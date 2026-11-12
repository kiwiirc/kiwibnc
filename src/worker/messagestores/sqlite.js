const path = require('path');
const { Worker } = require('worker_threads');
const sqlite3 = require('better-sqlite3');
const LRU = require('lru-cache');
const Stats = require('../../libs/stats');
const Helpers = require('../../libs/helpers');

const IrcMessage = require('irc-framework').Message;

const MSG_TYPE_PRIVMSG = 1;
const MSG_TYPE_NOTICE = 2;

class SqliteMessageStore {
    constructor(config) {
        this.supportsWrite = true;
        this.supportsRead = true;

        let loggingConf = config.get('logging', {});
        this.databasePath = config.relativePath(loggingConf.database);
        this.db = new sqlite3(this.databasePath);
        this.retentionDaysChannels = loggingConf.retention_days_channels || 0;
        this.retentionDaysPMs = loggingConf.retention_days_pms || 0;
        // The server tab is high volume server output, not conversation, so it follows the
        // channel retention rather than the (usually longer) PM one
        this.retentionDaysServer = loggingConf.retention_days_server !== undefined
            ? parseInt(loggingConf.retention_days_server, 10)
            : this.retentionDaysChannels;
        this.retentionCleanupInterval = loggingConf.retention_cleanup_interval || 1440; // Default 24h
        // Minutes to wait before the first cleanup pass. Running it at boot means taking the
        // sqlite write lock exactly when every client is reconnecting and asking for history.
        this.retentionStartupDelay = loggingConf.retention_startup_delay !== undefined
            ? parseInt(loggingConf.retention_startup_delay, 10)
            : 5;
        // Reclaiming disk space after retention has deleted messages. Only has any effect on a
        // database in incremental auto_vacuum mode, see the 'vacuummessages' action.
        this.vacuumEnabled = loggingConf.vacuum !== undefined
            ? !!loggingConf.vacuum
            : true;
        this.vacuumChunkPages = loggingConf.vacuum_chunk_pages || 2000;
        this.vacuumKeepFreePages = loggingConf.vacuum_keep_free_pages !== undefined
            ? parseInt(loggingConf.vacuum_keep_free_pages, 10)
            : 4000;
        this.vacuumPauseMs = loggingConf.vacuum_pause_ms !== undefined
            ? parseInt(loggingConf.vacuum_pause_ms, 10)
            : 20;
        // Cap the WAL file after each checkpoint. -1 leaves it at its high water mark forever,
        // which is the sqlite default and the reason messages.db-wal never gets smaller.
        this.walSizeLimit = loggingConf.wal_size_limit !== undefined
            ? parseInt(loggingConf.wal_size_limit, 10)
            : 32 * 1024 * 1024;
        this.sqliteCacheSize = loggingConf.cache_size || 2000;  // in KB, default 2MB
        this.sqliteMmapSize = loggingConf.mmap_size || 0;       // in bytes, default disabled
        this.connectHistory = loggingConf.connect_history !== undefined
            ? parseInt(loggingConf.connect_history, 10)
            : 50; // Messages to replay on client connect (0 = disabled)
        this.stats = Stats.instance().makePrefix('messages');

        this.storeQueueLooping = false;
        this.storeQueue = [];
        this.cleanupRunning = false;
        this.vacuumRunning = false;

        this.dataCache = new LRU({
            max: 50 * 1000 * 1000, // very roughly 50mb cache
            length: (entry, key) => key.length,
        });
    }

    async init() {
        // SQLite performance optimizations
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');     // Safe with WAL, reduces fsync calls
        this.db.pragma(`cache_size = -${this.sqliteCacheSize}`);  // Negative = KB
        if (this.sqliteMmapSize > 0) {
            this.db.pragma(`mmap_size = ${this.sqliteMmapSize}`);
        }
        this.db.pragma('temp_store = MEMORY');      // Temp tables in RAM
        this.db.pragma('busy_timeout = 100');        // Short wait for locks; retries are handled async
        if (this.walSizeLimit >= 0) {
            // Truncate the WAL back down to this after a checkpoint instead of leaving it at
            // whatever size a big write burst pushed it to
            this.db.pragma(`journal_size_limit = ${this.walSizeLimit}`);
        }

        this.db.exec(`
        CREATE TABLE IF NOT EXISTS logs (
            user_id INTEGER,
            network_id INTEGER,
            bufferref INTEGER,
            time INTEGER,
            type INTEGER,
            msgid TEXT,
            msgtagsref INTEGER,
            dataref INTEGER,
            prefixref INTEGER,
            paramsref INTEGER
        )`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS logs_user_id_ts ON logs (user_id, bufferref, time)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS logs_msgid ON logs (msgid)`);
        
        // Indexes required for efficient data cleanup (avoid full table scans)
        this.db.exec(`CREATE INDEX IF NOT EXISTS logs_bufferref ON logs (bufferref)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS logs_msgtagsref ON logs (msgtagsref)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS logs_dataref ON logs (dataref)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS logs_prefixref ON logs (prefixref)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS logs_paramsref ON logs (paramsref)`);

        this.db.exec(`
        CREATE TABLE IF NOT EXISTS data (
            id INTEGER PRIMARY KEY,
            data BLOB UNIQUE
        )`);

        this.stmtInsertData = this.db.prepare("INSERT INTO data(data) values(?)");
        this.stmtInsertLogWithId = this.db.prepare(`
            INSERT INTO logs (
                user_id,
                network_id,
                bufferref,
                time,
                type,
                msgid,
                msgtagsref,
                dataref,
                prefixref,
                paramsref
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        this.stmtGetExistingDataId = this.db.prepare("SELECT id FROM data WHERE data = ?");

        if (this.retentionDaysChannels > 0 || this.retentionDaysPMs > 0) {
            const runCleanupTask = async () => {
                if (this.cleanupRunning) return;
                this.cleanupRunning = true;
                l.info('Running message retention cleanup');
                let startTime = Date.now();
                let totalDeleted = 0;
                this.stats.increment('retention.cleanup.runs');

                try {
                    const BATCH_SIZE = 150;

                    // Orphaned 'data' ids are collected in a Set and flushed as soon as there are
                    // enough of them for a full chunk, rather than accumulating every deleted row
                    // until the end of the run: a catch-up pass over millions of messages would
                    // otherwise hold the whole lot in memory at once.
                    //
                    // Flushing mid-run stays correct because an id is only dropped from the Set
                    // once checked, and the *last* logs row referencing it re-adds it when deleted,
                    // so every id gets a final check after its last reference is gone.
                    const DATA_CLEANUP_CHUNK = 900;
                    let pendingDataIds = new Set();

                    const flushDataCleanup = async (force) => {
                        while (pendingDataIds.size >= (force ? 1 : DATA_CLEANUP_CHUNK)) {
                            let chunk = [];
                            for (let id of pendingDataIds) {
                                chunk.push(id);
                                if (chunk.length >= DATA_CLEANUP_CHUNK) break;
                            }
                            chunk.forEach((id) => pendingDataIds.delete(id));

                            try {
                                this.cleanupOrphanedData(chunk);
                            } catch (cleanupErr) {
                                l.warn('Data cleanup failed, will retry next cycle', cleanupErr.message);
                            }
                            // These NOT EXISTS queries are synchronous, yield between chunks
                            await new Promise(resolve => setTimeout(resolve, 50));
                        }
                    };

                    const processRetention = async (days, kind) => {
                        if (days <= 0) return;
                        let more = true;
                        let busyRetries = 0;
                        const isChannel = kind === 'channels';

                        // The server tab is matched on prefixref, which is indexed, so it needs
                        // none of the temp table machinery below
                        let emptyPrefixId = null;
                        if (kind === 'server') {
                            let row = this.db.prepare("SELECT id FROM data WHERE data = ''").get();
                            if (!row) {
                                return;
                            }
                            emptyPrefixId = row.id;
                        }

                        // Pre-compute the set of matching buffer IDs ONCE into a temp table.
                        //
                        // Without this, runRetentionCleanup's IN-subquery runs a full table scan
                        // of the 'data' table on every batch call. The 'data' column has BLOB
                        // affinity, so SQLite cannot use the UNIQUE index for LIKE comparisons
                        // (LIKE index optimisation only applies to TEXT affinity columns). On a
                        // large database the scan takes several seconds and blocks the event loop
                        // for the entire duration, stalling HTTP requests and IRC keepalives.
                        const tempBufs = kind === 'server'
                            ? null
                            : (isChannel ? 'tmp_ret_ch_bufs' : 'tmp_ret_pm_bufs');
                        if (tempBufs) {
                            this.createRetentionBufferTable(tempBufs, isChannel);
                        }

                        while (more) {
                            // If a transaction is currently open (e.g. from storeMessageLoop), wait
                            // until it completes to avoid nested transactions or locking issues.
                            if (this.db.inTransaction) {
                                if (busyRetries++ > 50) { // Wait max 5 seconds
                                    l.warn('Database busy with other transactions, aborting retention cleanup');
                                    if (tempBufs) this.db.exec(`DROP TABLE IF EXISTS ${tempBufs}`);
                                    return;
                                }
                                await new Promise(resolve => setTimeout(resolve, 100));
                                continue;
                            }
                            busyRetries = 0;

                            let rows = [];
                            // Transaction for the delete batch — retry on SQLITE_BUSY
                            let retentionRetries = 0;
                            while (true) {
                                try {
                                    this.db.transaction(() => {
                                        rows = this.runRetentionCleanup(days, kind, BATCH_SIZE, tempBufs, emptyPrefixId);
                                    })();
                                    break;
                                } catch (err) {
                                    if (err.code === 'SQLITE_BUSY' && retentionRetries++ < 10) {
                                        await new Promise(resolve => setTimeout(resolve, 200));
                                        continue;
                                    }
                                    throw err;
                                }
                            }

                            if (rows.length > 0) {
                                for (let row of rows) {
                                    if (row.bufferref) pendingDataIds.add(row.bufferref);
                                    if (row.msgtagsref) pendingDataIds.add(row.msgtagsref);
                                    if (row.dataref) pendingDataIds.add(row.dataref);
                                    if (row.prefixref) pendingDataIds.add(row.prefixref);
                                    if (row.paramsref) pendingDataIds.add(row.paramsref);
                                }
                                totalDeleted += rows.length;
                                // Yield to event loop between batches so TCP keepalives,
                                // reconnections and other I/O can be processed.
                                // Without this delay, continuous synchronous SQLite writes
                                // starve the event loop and cause IRC connection timeouts.
                                await new Promise(resolve => setTimeout(resolve, 50));
                                await flushDataCleanup(false);
                            }

                            if (rows.length < BATCH_SIZE) {
                                more = false;
                            }
                        }

                        if (tempBufs) this.db.exec(`DROP TABLE IF EXISTS ${tempBufs}`);
                    };

                    if (this.retentionDaysChannels > 0) {
                        await processRetention(this.retentionDaysChannels, 'channels');
                    }
                    // Before the PM pass, so the PM temp table has less to walk
                    if (this.retentionDaysServer > 0) {
                        await processRetention(this.retentionDaysServer, 'server');
                    }
                    if (this.retentionDaysPMs > 0) {
                        await processRetention(this.retentionDaysPMs, 'pms');
                    }

                    // Anything left over from the last partial chunk
                    await flushDataCleanup(true);

                    // Deleting rows only moves pages onto the freelist, it never shrinks the file
                    await this.runVacuum();

                    this.stats.gauge('retention.cleanup.rows_deleted', totalDeleted);
                    this.stats.gauge('retention.cleanup.duration_ms', Date.now() - startTime);
                } catch (err) {
                    l.error('Error running retention cleanup', err);
                    this.stats.increment('retention.cleanup.errors');
                } finally {
                    this.cleanupRunning = false;
                }
            };

            // Delay the first pass rather than running it during startup, when every client is
            // reconnecting and requesting history
            let startupTimer = setTimeout(runCleanupTask, this.retentionStartupDelay * 60 * 1000);
            // Run cleanup periodically
            let intervalTimer = setInterval(runCleanupTask, this.retentionCleanupInterval * 60 * 1000);
            // Neither timer should be a reason for the process to stay alive
            startupTimer.unref();
            intervalTimer.unref();
        }
    }

    /**
     * Hands free pages back to the filesystem, in a worker thread.
     *
     * Deleting messages puts their pages on sqlite's freelist, where they are reused by new
     * messages but never returned to the OS - which is why messages.db only ever grows. Only a
     * database in incremental auto_vacuum mode can give them back without a full offline VACUUM.
     */
    async runVacuum() {
        if (!this.vacuumEnabled || this.vacuumRunning) {
            return;
        }

        // Nothing to reclaim on a database that only exists in memory
        if (!this.databasePath || this.databasePath.indexOf(':memory:') > -1) {
            return;
        }

        // incremental_vacuum is a no-op unless the database was built with, or converted to,
        // incremental auto_vacuum. Converting needs a one-off offline VACUUM.
        let autoVacuum = this.db.pragma('auto_vacuum', { simple: true });
        if (autoVacuum !== 2) {
            if (!this.warnedVacuumMode) {
                this.warnedVacuumMode = true;
                l.info(
                    'Message database is not in incremental auto_vacuum mode so disk space is ' +
                    'never reclaimed. Stop the bouncer and run "kiwibnc vacuummessages" to convert it'
                );
            }
            return;
        }

        let free = this.db.pragma('freelist_count', { simple: true });
        if (free <= this.vacuumKeepFreePages) {
            return;
        }

        this.vacuumRunning = true;
        let startTime = Date.now();
        this.stats.increment('retention.vacuum.runs');

        try {
            await new Promise((resolve) => {
                let worker = new Worker(path.join(__dirname, 'vacuumworker.js'), {
                    workerData: {
                        file: this.databasePath,
                        chunkPages: this.vacuumChunkPages,
                        keepFreePages: this.vacuumKeepFreePages,
                        pausePerChunk: this.vacuumPauseMs,
                        // The vacuum is the one that should wait, not the messages being stored
                        busyTimeout: 5000,
                        walSizeLimit: this.walSizeLimit,
                    },
                });

                let settled = false;
                let finish = () => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    resolve();
                };

                worker.on('message', (msg) => {
                    if (msg.ok) {
                        let mb = (msg.pagesFreed * msg.pageSize) / (1024 * 1024);
                        l.info(
                            `Vacuum returned ${msg.pagesFreed} pages (${mb.toFixed(1)}MB) to disk` +
                            (msg.walTruncated ? ', WAL truncated' : ', WAL busy and left as is')
                        );
                        this.stats.gauge('retention.vacuum.pages_freed', msg.pagesFreed);
                    } else {
                        l.warn('Vacuum failed, will retry next cycle:', msg.error);
                        this.stats.increment('retention.vacuum.errors');
                    }
                });

                // A failure in the thread must never take the worker process down with it
                worker.on('error', (err) => {
                    l.warn('Vacuum thread error, will retry next cycle:', err.message);
                    this.stats.increment('retention.vacuum.errors');
                    finish();
                });
                worker.on('exit', finish);
            });

            this.stats.gauge('retention.vacuum.duration_ms', Date.now() - startTime);
        } finally {
            this.vacuumRunning = false;
        }
    }

    /**
     * (Re)creates a temp table holding the ids of every channel buffer, or every PM buffer,
     * that has at least one message in logs.
     *
     * The distinct buffer ids come from the logs_bufferref index, which is small, and only those
     * few thousand ids are then looked up in 'data' to classify them. Scanning 'data' directly
     * would read every message body in the database (it holds message text, tags and prefixes,
     * not only buffer names) and, for PMs, fill the temp table with nearly every row of 'data'.
     * The CROSS JOIN pins that join order: SQLite never reorders a CROSS JOIN, and without
     * ANALYZE statistics a plain join could pick the full scan of 'data' instead.
     *
     * @param {string} tableName - Name of the temp table to create
     * @param {boolean} isChannel - true for channel buffers (#, &), false for PM buffers
     */
    createRetentionBufferTable(tableName, isChannel) {
        const match = isChannel
            ? `CAST(data.data AS TEXT) LIKE '#%' OR CAST(data.data AS TEXT) LIKE '&%'`
            : `CAST(data.data AS TEXT) NOT LIKE '#%' AND CAST(data.data AS TEXT) NOT LIKE '&%'`;

        this.db.exec(`DROP TABLE IF EXISTS ${tableName}`);
        this.db.exec(`
            CREATE TEMP TABLE ${tableName} AS
            SELECT data.id AS id
            FROM (SELECT DISTINCT bufferref AS id FROM logs) bufs
            CROSS JOIN data ON data.id = bufs.id
            WHERE ${match}
        `);
        this.db.exec(`CREATE INDEX idx_${tableName} ON ${tableName}(id)`);
    }

    /**
     * Cleans up orphaned data in the 'data' table
     * @param {Array} deletedRows - The rows deleted from the 'logs' table
     */
    runDataCleanup(deletedRows) {
        if (!deletedRows || deletedRows.length === 0) return;

        // Extract all unique IDs from the deleted rows
        const candidateIds = new Set();
        for (const row of deletedRows) {
            if (row.bufferref) candidateIds.add(row.bufferref);
            if (row.msgtagsref) candidateIds.add(row.msgtagsref);
            if (row.dataref) candidateIds.add(row.dataref);
            if (row.prefixref) candidateIds.add(row.prefixref);
            if (row.paramsref) candidateIds.add(row.paramsref);
        }

        const allIds = Array.from(candidateIds);
        const CHUNK = 900;
        for (let i = 0; i < allIds.length; i += CHUNK) {
            this.cleanupOrphanedData(allIds.slice(i, i + CHUNK));
        }
    }

    /**
     * Deletes the given 'data' rows if nothing in 'logs' references them any more
     * @param {Array} allIds - Candidate data ids to check
     */
    cleanupOrphanedData(allIds) {
        if (!allIds || allIds.length === 0) return;

        this.db.transaction(() => {
            l.debug('Running orphaned data cleanup (incremental)');

            const placeholders = allIds.map(() => '?').join(',');

            // Delete from data ONLY IF the ID is not referenced in any of the 5 columns in logs
            // We use the UNION ALL optimization inside the NOT EXISTS check
            const stmt = this.db.prepare(`
                DELETE FROM data
                WHERE id IN (${placeholders})
                AND NOT EXISTS (
                    SELECT 1 FROM logs WHERE bufferref = data.id
                    UNION ALL
                    SELECT 1 FROM logs WHERE msgtagsref = data.id
                    UNION ALL
                    SELECT 1 FROM logs WHERE dataref = data.id
                    UNION ALL
                    SELECT 1 FROM logs WHERE prefixref = data.id
                    UNION ALL
                    SELECT 1 FROM logs WHERE paramsref = data.id
                    LIMIT 1
                )
                RETURNING data
            `);

            const deleted = stmt.all(...allIds);

            if (deleted.length > 0) {
                l.info(`Orphaned data cleanup removed ${deleted.length} rows`);
                // Drop just the deleted values from the cache, so we don't hand out ids that no
                // longer exist. Cleanup now runs several times per retention pass, and resetting
                // the whole cache each time would push every following write back to an
                // INSERT-then-SELECT round trip.
                for (const row of deleted) {
                    let key = typeof row.data === 'string' ? row.data : String(row.data);
                    this.dataCache.del(key);
                }
            }
        })();
    }

    /**
     * Deletes messages exceeding the retention period
     * @param {number} days - Number of retention days
     * @param {boolean} isChannel - true for channels (#, &), false for PMs
     * @param {number} limit - Max number of rows to delete per batch
     * @returns {Array} Deleted rows with their references
     */
    runRetentionCleanup(days, kind, limit, bufTableName, emptyPrefixId) {
        if (days <= 0) return [];

        const isChannel = kind === 'channels';
        let cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        let cutoffTime = cutoffDate.getTime();

        let sql;
        let params = [cutoffTime, limit || 1000];
        if (kind === 'server') {
            // A message with no sender is server output, never a conversation. Matching on
            // prefixref uses logs_prefixref, so this needs no temp table of buffer ids.
            sql = `
                DELETE FROM logs
                WHERE rowid IN (
                    SELECT rowid FROM logs
                    WHERE prefixref = ? AND time < ?
                    LIMIT ?
                )
                RETURNING bufferref, msgtagsref, dataref, prefixref, paramsref
            `;
            params = [emptyPrefixId, cutoffTime, limit || 1000];
        } else if (bufTableName) {
            // Use the pre-computed temp table of buffer IDs (avoids repeated full table
            // scan of the data column which has BLOB affinity and cannot use LIKE index).
            sql = `
                DELETE FROM logs
                WHERE rowid IN (
                    SELECT l.rowid FROM logs l
                    INNER JOIN ${bufTableName} b ON l.bufferref = b.id
                    WHERE l.time < ?
                    LIMIT ?
                )
                RETURNING bufferref, msgtagsref, dataref, prefixref, paramsref
            `;
        } else if (isChannel) {
            sql = `
                DELETE FROM logs
                WHERE rowid IN (
                    SELECT rowid FROM logs
                    WHERE time < ?
                    AND bufferref IN (
                        SELECT id FROM data
                        WHERE data LIKE '#%' OR data LIKE '&%'
                    )
                    LIMIT ?
                )
                RETURNING bufferref, msgtagsref, dataref, prefixref, paramsref
            `;
        } else {
            sql = `
                DELETE FROM logs
                WHERE rowid IN (
                    SELECT rowid FROM logs
                    WHERE time < ?
                    AND bufferref IN (
                        SELECT id FROM data
                        WHERE data NOT LIKE '#%' AND data NOT LIKE '&%'
                    )
                    LIMIT ?
                )
                RETURNING bufferref, msgtagsref, dataref, prefixref, paramsref
            `;
        }

        let label = kind === 'channels' ? 'channels' : kind === 'server' ? 'server tab' : 'PMs';
        let rows = this.db.prepare(sql).all(...params);
        l.info(`Retention cleanup (${label}, >${days} days) removed ${rows.length} messages`);
        return rows;
    }

    // Insert a chunk of data into the data table if it doesn't already exist, returning its ID
    dataId(data) {
        let cached = this.dataCache.get(data);
        if (cached) {
            return cached;
        }

        try {
            // Will fail if the data already exists in the db
            this.stmtInsertData.run(data);
        } catch (err) {
        }

        let row = this.stmtGetExistingDataId.get(data);
        if (row && row.id) {
            this.dataCache.set(data, row.id);
            return row.id;
        }

        return null;
    }

    async getMessagesFromMsgId(userId, networkId, buffer, fromMsgId, length) {
        let messagesTmr = this.stats.timerStart('lookup.time');

        let stmt = this.db.prepare(`
            SELECT
                logs.user_id,
                logs.network_id,
                d_buffer.data as buffer,
                logs.time,
                logs.type,
                logs.msgid,
                d_msgtags.data as msgtags,
                d_params.data as params,
                d_data.data as data,
                d_prefix.data as prefix
            FROM logs
            LEFT JOIN data d_buffer ON logs.bufferref = d_buffer.id
            LEFT JOIN data d_msgtags ON logs.msgtagsref = d_msgtags.id
            LEFT JOIN data d_params ON logs.paramsref = d_params.id
            LEFT JOIN data d_data ON logs.dataref = d_data.id
            LEFT JOIN data d_prefix ON logs.prefixref = d_prefix.id
            WHERE
                logs.user_id = :user_id
                AND logs.network_id = :network_id
                AND logs.bufferref = (SELECT id FROM data WHERE data = :buffer)
                AND logs.time > (SELECT time FROM logs WHERE msgid = :msgid)
            ORDER BY logs.time
            LIMIT :limit
        `);
        let rows = stmt.all({
            user_id: userId,
            network_id: networkId,
            buffer: buffer,
            msgid: fromMsgId,
            limit: length || 50,
        });

        let messages = dbRowsToMessage(rows);

        messagesTmr.stop();
        return messages;
    }

    async getMessagesFromTime(userId, networkId, buffer, fromTime, length) {
        let messagesTmr = this.stats.timerStart('lookup.time');

        let stmt = this.db.prepare(`
            SELECT
                logs.user_id,
                logs.network_id,
                d_buffer.data as buffer,
                logs.time,
                logs.type,
                logs.msgid,
                d_msgtags.data as msgtags,
                d_params.data as params,
                d_data.data as data,
                d_prefix.data as prefix
            FROM logs
            LEFT JOIN data d_buffer ON logs.bufferref = d_buffer.id
            LEFT JOIN data d_msgtags ON logs.msgtagsref = d_msgtags.id
            LEFT JOIN data d_params ON logs.paramsref = d_params.id
            LEFT JOIN data d_data ON logs.dataref = d_data.id
            LEFT JOIN data d_prefix ON logs.prefixref = d_prefix.id
            WHERE
                logs.user_id = :user_id
                AND logs.network_id = :network_id
                AND logs.bufferref = (SELECT id FROM data WHERE data = :buffer)
                AND logs.time > :time
            ORDER BY logs.time
            LIMIT :limit
        `);
        let rows = stmt.all({
            user_id: userId,
            network_id: networkId,
            buffer: buffer,
            time: fromTime,
            limit: length || 50,
        });

        let messages = dbRowsToMessage(rows);

        messagesTmr.stop();
        return messages;
    }

    async getMessagesBeforeMsgId(userId, networkId, buffer, msgId, length) {
        let messagesTmr = this.stats.timerStart('lookup.time');

        let stmt = this.db.prepare(`
            SELECT
                logs.user_id,
                logs.network_id,
                d_buffer.data as buffer,
                logs.time,
                logs.type,
                logs.msgid,
                d_msgtags.data as msgtags,
                d_params.data as params,
                d_data.data as data,
                d_prefix.data as prefix
            FROM logs
            LEFT JOIN data d_buffer ON logs.bufferref = d_buffer.id
            LEFT JOIN data d_msgtags ON logs.msgtagsref = d_msgtags.id
            LEFT JOIN data d_params ON logs.paramsref = d_params.id
            LEFT JOIN data d_data ON logs.dataref = d_data.id
            LEFT JOIN data d_prefix ON logs.prefixref = d_prefix.id
            WHERE
                logs.user_id = :user_id
                AND logs.network_id = :network_id
                AND logs.bufferref = (SELECT id FROM data WHERE data = :buffer)
                AND logs.time <= (SELECT time FROM logs WHERE msgid = :msgid)
            ORDER BY logs.time DESC
            LIMIT :limit
        `);
        let rows = stmt.all({
            user_id: userId,
            network_id: networkId,
            buffer: buffer,
            msgid: msgId,
            limit: length || 50,
        });
        // We ordered the messages DESC in the query, so reverse them back into the correct order
        rows.reverse();

        let messages = dbRowsToMessage(rows);

        messagesTmr.stop();
        return messages;
    }

    async getMessagesBeforeTime(userId, networkId, buffer, fromTime, length) {
        let messagesTmr = this.stats.timerStart('lookup.time');

        let stmt = this.db.prepare(`
            SELECT
                logs.user_id,
                logs.network_id,
                d_buffer.data as buffer,
                logs.time,
                logs.type,
                logs.msgid,
                d_msgtags.data as msgtags,
                d_params.data as params,
                d_data.data as data,
                d_prefix.data as prefix
            FROM logs
            LEFT JOIN data d_buffer ON logs.bufferref = d_buffer.id
            LEFT JOIN data d_msgtags ON logs.msgtagsref = d_msgtags.id
            LEFT JOIN data d_params ON logs.paramsref = d_params.id
            LEFT JOIN data d_data ON logs.dataref = d_data.id
            LEFT JOIN data d_prefix ON logs.prefixref = d_prefix.id
            WHERE
                logs.user_id = :user_id
                AND logs.network_id = :network_id
                AND logs.bufferref = (SELECT id FROM data WHERE data = :buffer)
                AND logs.time <= :time
            ORDER BY logs.time DESC
            LIMIT :limit
        `);
        let rows = stmt.all({
            user_id: userId,
            network_id: networkId,
            buffer: buffer,
            time: fromTime,
            limit: length || 50,
        });
        // We ordered the messages DESC in the query, so reverse them back into the correct order
        rows.reverse();

        let messages = dbRowsToMessage(rows);

        messagesTmr.stop();
        return messages;
    }

    async getMessagesBetween(userId, networkId, buffer, from, to, length) {
        let messagesTmr = this.stats.timerStart('lookup.time');

        let fromSql = '';
        let toSql = '';
        let sqlParams = {
            user_id: userId,
            network_id: networkId,
            buffer: buffer,
            limit: length || 50,
        };

        // from is inclusive
        if (from.type === 'timestamp') {
            fromSql = 'AND time >= :fromTime';
            sqlParams.fromTime = from.value;
        } else if (from.type === 'msgid') {
            fromSql = 'AND time >= (SELECT time FROM logs WHERE msgid = :fromMsgid)';
            sqlParams.fromMsgid = from.value;
        }

        // to is excluding
        if (to.type === 'timestamp') {
            toSql = 'AND time < :toTime';
            sqlParams.toTime = to.value;
        } else if (to.type === 'msgid') {
            toSql = 'AND time < (SELECT time FROM logs WHERE msgid = :toMsgid)';
            sqlParams.toMsgid = to.value;
        }

        let stmt = this.db.prepare(`
            SELECT
                logs.user_id,
                logs.network_id,
                d_buffer.data as buffer,
                logs.time,
                logs.type,
                logs.msgid,
                d_msgtags.data as msgtags,
                d_params.data as params,
                d_data.data as data,
                d_prefix.data as prefix
            FROM logs
            LEFT JOIN data d_buffer ON logs.bufferref = d_buffer.id
            LEFT JOIN data d_msgtags ON logs.msgtagsref = d_msgtags.id
            LEFT JOIN data d_params ON logs.paramsref = d_params.id
            LEFT JOIN data d_data ON logs.dataref = d_data.id
            LEFT JOIN data d_prefix ON logs.prefixref = d_prefix.id
            WHERE
                logs.user_id = :user_id
                AND logs.network_id = :network_id
                AND logs.bufferref = (SELECT id FROM data WHERE data = :buffer)
                ${fromSql}
                ${toSql}
            ORDER BY logs.time DESC
            LIMIT :limit
        `);
        let rows = stmt.all(sqlParams);
        // We ordered the messages DESC in the query, so reverse them back into the correct order
        rows.reverse();

        let messages = dbRowsToMessage(rows);

        messagesTmr.stop();
        return messages;
    }

    getNthLatestMessageTime(userId, networkId, buffer, n) {
        // OFFSET n returns the (n+1)th most recent message; combined with
        // `time > result` in countMessagesSince this yields exactly n messages
        // counted as unread. Using OFFSET n-1 would undercount by one.
        let stmt = this.db.prepare(`
            SELECT time
            FROM logs
            WHERE
                logs.user_id = :user_id
                AND logs.network_id = :network_id
                AND logs.bufferref = (SELECT id FROM data WHERE data = :buffer)
                AND logs.type IN (:type_privmsg, :type_notice)
            ORDER BY time DESC
            LIMIT 1 OFFSET :offset
        `);
        let row = stmt.get({
            user_id: userId,
            network_id: networkId,
            buffer: buffer,
            offset: Math.max(0, n),
            type_privmsg: MSG_TYPE_PRIVMSG,
            type_notice: MSG_TYPE_NOTICE,
        });
        return row ? row.time : 0;
    }

    countMessagesSince(userId, networkId, buffer, fromTime) {
        let stmt = this.db.prepare(`
            SELECT COUNT(*) AS cnt
            FROM logs
            WHERE
                logs.user_id = :user_id
                AND logs.network_id = :network_id
                AND logs.bufferref = (SELECT id FROM data WHERE data = :buffer)
                AND logs.time > :time
                AND logs.type IN (:type_privmsg, :type_notice)
        `);
        let row = stmt.get({
            user_id: userId,
            network_id: networkId,
            buffer: buffer,
            time: fromTime,
            type_privmsg: MSG_TYPE_PRIVMSG,
            type_notice: MSG_TYPE_NOTICE,
        });
        return row ? row.cnt : 0;
    }

    async storeMessageLoop() {
        this.stats.gauge('messagestore.queue_length', this.storeQueue.length);

        if (this.storeQueueLooping) {
            return;
        }

        this.storeQueueLooping = true;
        let args = this.storeQueue.shift();
        if (!args) {
            this.storeQueueLooping = false;
            return;
        }

        let {message, upstreamCon, clientCon} = args;
        let conState = upstreamCon.state;
        let userId = conState.authUserId;
        let networkId = conState.authNetworkId;

        let bufferName = '';
        let type = 0;
        let data = '';
        let params = '';
        let msgId = '';
        // If no prefix, it's because we're sending it upstream (from the client)
        let prefix = clientCon ? clientCon.state.nick : message.nick;
        let time = new Date(message.tags.time || Helpers.isoTime());

        // Ignore CTCP request/responses
        if (
            (message.command === 'PRIVMSG' || message.command === 'NOTICE') &&
            message.params[1] && message.params[1][0] === '\x01'
        ) {
            // We do want to log ACTIONs though
            if (!message.params[1].startsWith('\x01ACTION' )) {
                this.storeQueueLooping = false;
                // Nothing to store for this one, but the queue must keep draining
                setImmediate(() => this.storeMessageLoop());
                return;
            }
        }

        if (message.command === 'PRIVMSG') {
            type = MSG_TYPE_PRIVMSG;
            bufferName = Helpers.extractBufferName(upstreamCon, message, 0);
            data = message.params[1];
            params = message.params.slice(0, message.params.length - 1).join(' ');
            msgId = message.tags['draft/msgid'] || message.tags['msgid'] || '';
        } else if (message.command === 'NOTICE') {
            type = MSG_TYPE_NOTICE;
            bufferName = Helpers.extractBufferName(upstreamCon, message, 0);
            // We store the last param as data so that it is searchable in future
            data = message.params[1];
            params = message.params.slice(0, message.params.length - 1).join(' ');
            msgId = message.tags['draft/msgid'] || message.tags['msgid'] || '';
        }

        if (!type) {
            this.storeQueueLooping = false;
            // Not a message type we log (JOIN, PART, ...), move on to the next queued item
            setImmediate(() => this.storeMessageLoop());
            return;
        }

        let messagesTmr = this.stats.timerStart('store.time');

        try {
            // Use better-sqlite3's transaction() instead of raw exec('BEGIN')/exec('COMMIT') so that
            // db.inTransaction is properly updated. With raw exec('BEGIN'), better-sqlite3 doesn't
            // track the open transaction, causing runDataCleanup to wrongly think the db is free and
            // start its own write transaction, which results in SQLITE_BUSY.
            this.db.transaction(() => {
                let bufferId = this.dataId(bufferName);
                let dataId = this.dataId(data);
                let msgtagsId = this.dataId(JSON.stringify(message.tags));
                let prefixId = this.dataId(prefix);
                let paramsId = this.dataId(params);

                this.stmtInsertLogWithId.run(
                    userId,
                    networkId,
                    bufferId,
                    time.getTime(),
                    type,
                    msgId,
                    msgtagsId,
                    dataId,
                    prefixId,
                    paramsId,
                );
            })();
        } catch (err) {
            if (err.code === 'SQLITE_BUSY') {
                // args has already been shifted off the queue, put it back or the message is lost
                args.busyRetries = (args.busyRetries || 0) + 1;
                if (args.busyRetries <= 10) {
                    l.warn('storeMessage: database busy, retrying in 100ms');
                    this.storeQueue.unshift(args);
                } else {
                    l.error('storeMessage: database still busy after 10 retries, dropping message');
                    this.stats.increment('store.dropped');
                }
                setTimeout(() => { this.storeQueueLooping = false; this.storeMessageLoop(); }, 100);
                return;
            }
            l.error('storeMessage error', err);
        }

        messagesTmr.stop();

        this.storeQueueLooping = false;
        // Use setImmediate to schedule the next item, preventing stack overflow on large queues
        // and allowing other event loop callbacks to run between items.
        setImmediate(() => this.storeMessageLoop());
    }

    async storeMessage(message, upstreamCon, clientCon) {
        this.storeQueue.push({message, upstreamCon, clientCon});
        // Schedule the write rather than running it inline. storeMessageLoop() is synchronous all
        // the way to the insert, so calling it directly runs the transaction inside the command
        // handler, ie. before the message has been relayed to connected clients - any wait on the
        // sqlite write lock would land straight on message delivery latency.
        setImmediate(() => this.storeMessageLoop());
    }

    deleteUserMessages(userId) {
        this.db.prepare('DELETE FROM logs WHERE user_id = ?').run(userId);
    }
}

module.exports = SqliteMessageStore;

function dbRowsToMessage(rows) {
    return rows.map((row) => {
        let m = new IrcMessage();
        if (row.type === MSG_TYPE_PRIVMSG) {
            m.command = 'PRIVMSG';
        } else if (row.type === MSG_TYPE_NOTICE) {
            m.command = 'NOTICE';
        } else {
            l.error('Read message from SQLite with unknown command:', m.type);
        }

        m.prefix = row.prefix;
        m.tags = JSON.parse(row.msgtags);
        m.tags.time = m.tags.time || Helpers.isoTime(new Date(row.time));
        m.params = row.params.split(' ');
        m.params.push(row.data);

        return m;
    });
}