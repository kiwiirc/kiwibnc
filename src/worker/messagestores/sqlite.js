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
        this.db = new sqlite3(config.relativePath(loggingConf.database));
        this.retentionDaysChannels = loggingConf.retention_days_channels || 0;
        this.retentionDaysPMs = loggingConf.retention_days_pms || 0;
        this.retentionCleanupInterval = loggingConf.retention_cleanup_interval || 1440; // Default 24h
        this.sqliteCacheSize = loggingConf.cache_size || 2000;  // in KB, default 2MB
        this.sqliteMmapSize = loggingConf.mmap_size || 0;       // in bytes, default disabled
        this.connectHistory = loggingConf.connect_history !== undefined
            ? parseInt(loggingConf.connect_history, 10)
            : 50; // Messages to replay on client connect (0 = disabled)
        this.stats = Stats.instance().makePrefix('messages');

        this.storeQueueLooping = false;
        this.storeQueue = [];

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
                    // Reduced batch size to ensure we don't hit SQLite variable limits in runDataCleanup
                    // 150 rows * 5 columns = 750 variables (limit is 999)
                    const BATCH_SIZE = 150;
                    // Collect orphaned data IDs across batches and clean up at the end
                    // to avoid running expensive NOT EXISTS queries after every small batch
                    let allDeletedRows = [];

                    const processRetention = async (days, isChannel) => {
                        if (days <= 0) return;
                        let more = true;
                        let busyRetries = 0;

                        while (more) {
                            // If a transaction is currently open (e.g. from storeMessageLoop), wait
                            // until it completes to avoid nested transactions or locking issues.
                            if (this.db.inTransaction) {
                                if (busyRetries++ > 50) { // Wait max 5 seconds
                                    l.warn('Database busy with other transactions, aborting retention cleanup');
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
                                        rows = this.runRetentionCleanup(days, isChannel, BATCH_SIZE);
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
                                allDeletedRows.push(...rows);
                                totalDeleted += rows.length;
                                // Yield to event loop between batches so TCP keepalives,
                                // reconnections and other I/O can be processed.
                                // Without this delay, continuous synchronous SQLite writes
                                // starve the event loop and cause IRC connection timeouts.
                                await new Promise(resolve => setTimeout(resolve, 50));
                            }

                            if (rows.length < BATCH_SIZE) {
                                more = false;
                            }
                        }
                    };

                    if (this.retentionDaysChannels > 0) {
                        await processRetention(this.retentionDaysChannels, true);
                    }
                    if (this.retentionDaysPMs > 0) {
                        await processRetention(this.retentionDaysPMs, false);
                    }

                    // Run orphaned data cleanup once at the end instead of per-batch.
                    // runDataCleanup uses synchronous NOT EXISTS queries that block the
                    // event loop; doing it once reduces that blocking significantly.
                    if (allDeletedRows.length > 0) {
                        // Process in chunks to keep each synchronous block short
                        const DATA_CLEANUP_CHUNK = 500;
                        for (let i = 0; i < allDeletedRows.length; i += DATA_CLEANUP_CHUNK) {
                            let chunk = allDeletedRows.slice(i, i + DATA_CLEANUP_CHUNK);
                            try {
                                this.runDataCleanup(chunk);
                            } catch (cleanupErr) {
                                l.warn('Data cleanup failed, will retry next cycle', cleanupErr.message);
                            }
                            // Yield between chunks
                            await new Promise(resolve => setTimeout(resolve, 50));
                        }
                    }

                    this.stats.gauge('retention.cleanup.rows_deleted', totalDeleted);
                    this.stats.gauge('retention.cleanup.duration_ms', Date.now() - startTime);
                } catch (err) {
                    l.error('Error running retention cleanup', err);
                    this.stats.increment('retention.cleanup.errors');
                } finally {
                    this.cleanupRunning = false;
                }
            };

            runCleanupTask();
            // Run cleanup periodically
            setInterval(runCleanupTask, this.retentionCleanupInterval * 60 * 1000);
        }
    }

    /**
     * Cleans up orphaned data in the 'data' table
     * @param {Array} deletedRows - The rows deleted from the 'logs' table
     */
    runDataCleanup(deletedRows) {
        if (!deletedRows || deletedRows.length === 0) return;

        this.db.transaction(() => {
            l.info('Running orphaned data cleanup (incremental)');
            
            // Extract all unique IDs from the deleted rows
            const candidateIds = new Set();
            for (const row of deletedRows) {
                if (row.bufferref) candidateIds.add(row.bufferref);
                if (row.msgtagsref) candidateIds.add(row.msgtagsref);
                if (row.dataref) candidateIds.add(row.dataref);
                if (row.prefixref) candidateIds.add(row.prefixref);
                if (row.paramsref) candidateIds.add(row.paramsref);
            }

            if (candidateIds.size === 0) return;
            const allIds = Array.from(candidateIds);

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
            `);

            const info = stmt.run(...allIds);

            if (info.changes > 0) {
                l.info(`Orphaned data cleanup removed ${info.changes} rows`);
                // Clear the cache to prevent reusing IDs that have just been deleted
                this.dataCache.reset();
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
    runRetentionCleanup(days, isChannel, limit) {
        if (days <= 0) return [];

        let cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        let cutoffTime = cutoffDate.getTime();

        let sql;
        if (isChannel) {
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

        let rows = this.db.prepare(sql).all(cutoffTime, limit || 1000);
        l.info(`Retention cleanup (${isChannel ? 'channels' : 'PMs'}, >${days} days) removed ${rows.length} messages`);
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
                l.warn('storeMessage: database busy, retrying in 100ms');
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
        this.storeMessageLoop();
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