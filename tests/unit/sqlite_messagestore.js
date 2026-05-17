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
        if (store) {
            store.close();
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

            const deleted = store.runRetentionCleanup(30, true, 100);

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

            const deleted = store.runRetentionCleanup(30, true, 100); // isChannel = true

            expect(deleted.length).toBe(0);
            
            const remaining = store.db.prepare('SELECT * FROM logs').all();
            expect(remaining.length).toBe(1);
        });

        test('should delete PM messages older than retention days', () => {
            const pmId = insertData('user1');
            const oldTime = Date.now() - (31 * 24 * 60 * 60 * 1000);

            insertLog({ bufferref: pmId, time: oldTime, msgid: 'pm1' });

            const deleted = store.runRetentionCleanup(30, false, 100); // isChannel = false

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
    });
});
