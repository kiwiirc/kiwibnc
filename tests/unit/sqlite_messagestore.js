const fs = require('fs');
const os = require('os');
const path = require('path');
const SqliteMessageStore = require('../../src/worker/messagestores/sqlite');
const Stats = require('../../src/libs/stats');

// Mock Stats
jest.mock('../../src/libs/stats', () => {
    const mockStats = {
        increment: jest.fn(),
        gauge: jest.fn(),
        timerStart: jest.fn(() => ({ stop: jest.fn() })),
        makePrefix: jest.fn(() => mockStats),
    };
    return {
        instance: jest.fn(() => mockStats),
    };
});

describe('SqliteMessageStore Retention & Cleanup', () => {
    let store;
    let mockConfig;

    beforeAll(() => {
        global.l = {
            info: jest.fn(),
            debug: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
        };
    });

    beforeEach(async () => {
        jest.clearAllMocks();

        mockConfig = {
            get: jest.fn((key) => {
                if (key === 'logging') {
                    return {
                        database: ':memory:',
                        retention_days_channels: 30,
                        retention_days_pms: 30,
                        retention_cleanup_interval: 1440,
                    };
                }
                return {};
            }),
            relativePath: jest.fn((path) => path),
        };

        store = new SqliteMessageStore(mockConfig);
        await store.init();
    });

    afterEach(() => {
        if (store.db && store.db.open) {
            store.db.close();
        }
    });

    // Helper to insert data
    const insertData = (value) => {
        const stmt = store.db.prepare('INSERT INTO data (data) VALUES (?)');
        const info = stmt.run(value);
        return info.lastInsertRowid;
    };

    // Helper to insert log
    const insertLog = (props) => {
        const stmt = store.db.prepare(`
            INSERT INTO logs (
                user_id, network_id, bufferref, time, type, msgid, 
                msgtagsref, dataref, prefixref, paramsref
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        // Default values
        const defaults = {
            user_id: 1,
            network_id: 1,
            bufferref: 0,
            time: Date.now(),
            type: 1,
            msgid: 'msg-' + Math.random(),
            msgtagsref: 0,
            dataref: 0,
            prefixref: 0,
            paramsref: 0
        };

        const p = { ...defaults, ...props };
        stmt.run(
            p.user_id, p.network_id, p.bufferref, p.time, p.type, p.msgid,
            p.msgtagsref, p.dataref, p.prefixref, p.paramsref
        );
    };

    describe('runRetentionCleanup', () => {
        test('should delete channel messages older than retention days', () => {
            const channelId = insertData('#channel');
            const oldTime = Date.now() - (31 * 24 * 60 * 60 * 1000); // 31 days ago
            const newTime = Date.now() - (1 * 24 * 60 * 60 * 1000); // 1 day ago

            insertLog({ bufferref: channelId, time: oldTime, msgid: 'old1' });
            insertLog({ bufferref: channelId, time: newTime, msgid: 'new1' });

            const deleted = store.runRetentionCleanup(30, 'channels', 100);

            expect(deleted.length).toBe(1);
            expect(deleted[0].bufferref).toBe(channelId);

            const remaining = store.db.prepare('SELECT * FROM logs').all();
            expect(remaining.length).toBe(1);
            expect(remaining[0].msgid).toBe('new1');
        });

        test('should NOT delete PM messages when cleaning channels', () => {
            const pmId = insertData('user1');
            const oldTime = Date.now() - (31 * 24 * 60 * 60 * 1000);

            insertLog({ bufferref: pmId, time: oldTime, msgid: 'pm1' });

            const deleted = store.runRetentionCleanup(30, 'channels', 100);

            expect(deleted.length).toBe(0);
            
            const remaining = store.db.prepare('SELECT * FROM logs').all();
            expect(remaining.length).toBe(1);
        });

        test('should delete PM messages older than retention days', () => {
            const pmId = insertData('user1');
            const oldTime = Date.now() - (31 * 24 * 60 * 60 * 1000);

            insertLog({ bufferref: pmId, time: oldTime, msgid: 'pm1' });

            const deleted = store.runRetentionCleanup(30, 'pms', 100);

            expect(deleted.length).toBe(1);
        });
    });

    describe('runDataCleanup', () => {
        test('should delete orphaned data', () => {
            const dataId1 = insertData('orphaned1');
            const dataId2 = insertData('kept2');
            
            // Reference dataId2 in logs
            insertLog({ dataref: dataId2 });

            // Run cleanup with both IDs
            // We simulate passing rows that were "deleted" from logs, 
            // but here we just pass objects with the IDs we want to check.
            const deletedRows = [
                { dataref: dataId1 },
                { dataref: dataId2 }
            ];

            store.runDataCleanup(deletedRows);

            const d1 = store.db.prepare('SELECT * FROM data WHERE id = ?').get(dataId1);
            const d2 = store.db.prepare('SELECT * FROM data WHERE id = ?').get(dataId2);

            expect(d1).toBeUndefined(); // Should be deleted
            expect(d2).toBeDefined();   // Should be kept
        });

        test('should handle multiple references correctly', () => {
            const dataId = insertData('multi-ref');
            
            // Reference in bufferref AND dataref
            insertLog({ bufferref: dataId });
            
            // Even if we pass it as a candidate for deletion
            store.runDataCleanup([{ bufferref: dataId }]);

            const d = store.db.prepare('SELECT * FROM data WHERE id = ?').get(dataId);
            expect(d).toBeDefined();
        });

        test('should handle batching correctly (simulated)', () => {
            // Create many orphaned data items
            const ids = [];
            for(let i=0; i<200; i++) {
                ids.push(insertData(`bulk-${i}`));
            }

            // Create deletedRows input
            const deletedRows = ids.map(id => ({ dataref: id }));

            store.runDataCleanup(deletedRows);

            const count = store.db.prepare('SELECT count(*) as c FROM data').get();
            expect(count.c).toBe(0);
        });

        test('should chunk candidate ids beyond a single statement', () => {
            // More ids than the 900 per statement chunk, with one still referenced
            const ids = [];
            for(let i=0; i<2500; i++) {
                ids.push(insertData(`chunked-${i}`));
            }
            const keptId = ids[1500];
            insertLog({ dataref: keptId });

            store.runDataCleanup(ids.map(id => ({ dataref: id })));

            const count = store.db.prepare('SELECT count(*) as c FROM data').get();
            expect(count.c).toBe(1);
            expect(store.db.prepare('SELECT * FROM data WHERE id = ?').get(keptId)).toBeDefined();
        });
    });

    describe('storeMessage queue', () => {
        const tick = () => new Promise(resolve => setImmediate(resolve));

        // Drain the store queue, one scheduled item per tick
        const drain = async (max = 20) => {
            for (let i = 0; i < max; i++) {
                await tick();
                if (!store.storeQueue.length && !store.storeQueueLooping) return;
            }
        };

        const upstreamCon = {
            state: { authUserId: 1, authNetworkId: 1, nick: 'me' },
            iSupportToken: () => null,
        };

        const makeMessage = (command, params, nick) => ({
            command,
            params,
            nick: nick || 'bob',
            tags: { time: new Date().toISOString() },
        });

        const logCount = () => store.db.prepare('SELECT count(*) as c FROM logs').get().c;

        test('should not write inline, so relaying is not blocked by the write lock', async () => {
            await store.storeMessage(makeMessage('PRIVMSG', ['#chan', 'hello']), upstreamCon, null);

            // The caller returns before the insert happens
            expect(logCount()).toBe(0);

            await drain();
            expect(logCount()).toBe(1);
        });

        test('should keep draining the queue past messages it does not log', async () => {
            // JOIN is queued by the upstream handler but never logged
            await store.storeMessage(makeMessage('JOIN', ['#chan']), upstreamCon, null);
            await store.storeMessage(makeMessage('PRIVMSG', ['#chan', 'hello']), upstreamCon, null);

            await drain();

            expect(logCount()).toBe(1);
            expect(store.storeQueue.length).toBe(0);
        });

        test('should keep draining the queue past ignored CTCP requests', async () => {
            await store.storeMessage(makeMessage('PRIVMSG', ['#chan', '\x01VERSION\x01']), upstreamCon, null);
            await store.storeMessage(makeMessage('PRIVMSG', ['#chan', 'hello']), upstreamCon, null);

            await drain();

            expect(logCount()).toBe(1);
            expect(store.storeQueue.length).toBe(0);
        });

        test('should requeue a message instead of dropping it when the db is busy', async () => {
            const realTransaction = store.db.transaction.bind(store.db);
            let failuresLeft = 1;
            store.db.transaction = (fn) => {
                const wrapped = realTransaction(fn);
                return (...args) => {
                    if (failuresLeft-- > 0) {
                        const err = new Error('database is locked');
                        err.code = 'SQLITE_BUSY';
                        throw err;
                    }
                    return wrapped(...args);
                };
            };

            await store.storeMessage(makeMessage('PRIVMSG', ['#chan', 'hello']), upstreamCon, null);
            await drain();

            // First attempt failed, the message must still be queued rather than lost
            expect(logCount()).toBe(0);
            expect(store.storeQueue.length).toBe(1);

            // The retry is scheduled 100ms out
            await new Promise(resolve => setTimeout(resolve, 200));
            await drain();

            expect(logCount()).toBe(1);
        });
    });

    describe('runVacuum', () => {
        let tmpDir;
        let fileStore;

        const makeFileStore = (overrides) => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwibnc-vacuum-'));
            const config = {
                get: () => ({
                    database: path.join(tmpDir, 'messages.db'),
                    // No retention, so nothing schedules itself behind the test
                    ...overrides,
                }),
                relativePath: (p) => p,
            };
            return new SqliteMessageStore(config);
        };

        afterEach(() => {
            if (fileStore && fileStore.db && fileStore.db.open) {
                fileStore.db.close();
            }
            fileStore = null;
            if (tmpDir) {
                fs.rmSync(tmpDir, { recursive: true, force: true });
                tmpDir = null;
            }
        });

        test('should skip, and say so once, when the database cannot reclaim space', async () => {
            fileStore = makeFileStore();
            await fileStore.init();
            expect(fileStore.db.pragma('auto_vacuum', { simple: true })).not.toBe(2);

            await fileStore.runVacuum();
            expect(fileStore.warnedVacuumMode).toBe(true);
            expect(fileStore.vacuumRunning).toBe(false);

            // The notice is logged once, not on every retention cycle
            const notices = l.info.mock.calls.filter(
                (args) => typeof args[0] === 'string' && args[0].includes('auto_vacuum')
            ).length;
            await fileStore.runVacuum();
            expect(l.info.mock.calls.filter(
                (args) => typeof args[0] === 'string' && args[0].includes('auto_vacuum')
            ).length).toBe(notices);
        });

        test('should skip a database held only in memory', async () => {
            await store.runVacuum();
            expect(store.vacuumRunning).toBe(false);
            expect(store.warnedVacuumMode).toBeUndefined();
        });

        test('should not throw when the vacuum thread fails', async () => {
            fileStore = makeFileStore();
            await fileStore.init();

            // Reach the thread whatever the state of the file
            fileStore.db.pragma = (pragma, opts) => {
                if (pragma === 'auto_vacuum') return 2;
                if (pragma === 'freelist_count') return 1000000;
                return [];
            };
            fileStore.databasePath = path.join(tmpDir, 'no', 'such', 'dir', 'messages.db');

            await expect(fileStore.runVacuum()).resolves.toBeUndefined();
            expect(fileStore.vacuumRunning).toBe(false);
        });
    });
});
