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
        this.stats = Stats.instance().makePrefix('messages');

        this.storeQueueLooping = false;
        this.storeQueue = [];

        this.dataCache = new LRU({
            max: 50 * 1000 * 1000, // very roughly 50mb cache
            length: (entry, key) => key.length,
        });

        this.purgerRunning = false;
        this.purgerTimeout = 0;
        // Max number of records to delete in one loop
        this.purgerLimit = 1000;
        // Delay in ms between each loop
        this.purgerDelay = 1000;
    }

    async init() {
        this.db.pragma('journal_mode = WAL');
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
        this.db.exec(`
        CREATE TABLE IF NOT EXISTS data (
            id INTEGER PRIMARY KEY,
            data BLOB UNIQUE
        )`);

        this.db.exec(`
        CREATE TABLE IF NOT EXISTS logs_deletions (
            id INTEGER PRIMARY KEY,
            user_id INTEGER,
            before_time INTEGER
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

        // Start purging any messages defined in logs_deletions
        this.startMessagePurger();
    }

    // Insert a chunk of data into the data table if it doesn't already exist, returning its ID
    async dataId(data) {
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
                user_id,
                network_id,
                (SELECT data FROM data WHERE id = bufferref) as buffer,
                time,
                type,
                msgid,
                (SELECT data FROM data WHERE id = msgtagsref) as msgtags,
                (SELECT data FROM data WHERE id = paramsref) as params,
                (SELECT data FROM data WHERE id = dataref) as data,
                (SELECT data FROM data WHERE id = prefixref) as prefix
            FROM logs
            WHERE
                user_id = :user_id
                AND network_id = :network_id
                AND bufferref = (SELECT id FROM data WHERE data = :buffer)
                AND time > (SELECT time FROM logs WHERE msgid = :msgid)
            ORDER BY time
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
                user_id,
                network_id,
                (SELECT data FROM data WHERE id = bufferref) as buffer,
                time,
                type,
                msgid,
                (SELECT data FROM data WHERE id = msgtagsref) as msgtags,
                (SELECT data FROM data WHERE id = paramsref) as params,
                (SELECT data FROM data WHERE id = dataref) as data,
                (SELECT data FROM data WHERE id = prefixref) as prefix
            FROM logs
            WHERE
                user_id = :user_id
                AND network_id = :network_id
                AND bufferref = (SELECT id FROM data WHERE data = :buffer)
                AND time > :time
            ORDER BY time
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
                user_id,
                network_id,
                (SELECT data FROM data WHERE id = bufferref) as buffer,
                time,
                type,
                msgid,
                (SELECT data FROM data WHERE id = msgtagsref) as msgtags,
                (SELECT data FROM data WHERE id = paramsref) as params,
                (SELECT data FROM data WHERE id = dataref) as data,
                (SELECT data FROM data WHERE id = prefixref) as prefix
            FROM logs
            WHERE
                user_id = :user_id
                AND network_id = :network_id
                AND bufferref = (SELECT id FROM data WHERE data = :buffer)
                AND time <= (SELECT time FROM logs WHERE msgid = :msgid)
            ORDER BY time DESC
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
                user_id,
                network_id,
                (SELECT data FROM data WHERE id = bufferref) as buffer,
                time,
                type,
                msgid,
                (SELECT data FROM data WHERE id = msgtagsref) as msgtags,
                (SELECT data FROM data WHERE id = paramsref) as params,
                (SELECT data FROM data WHERE id = dataref) as data,
                (SELECT data FROM data WHERE id = prefixref) as prefix
            FROM logs
            WHERE
                user_id = :user_id
                AND network_id = :network_id
                AND bufferref = (SELECT id FROM data WHERE data = :buffer)
                AND time <= :time
            ORDER BY time DESC
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
            toql = 'AND time < (SELECT time FROM logs WHERE msgid = :toMsgid)';
            sqlParams.toMsgid = to.value;
        }

        let stmt = this.db.prepare(`
            SELECT
                user_id,
                network_id,
                (SELECT data FROM data WHERE id = bufferref) as buffer,
                time,
                type,
                msgid,
                (SELECT data FROM data WHERE id = msgtagsref) as msgtags,
                (SELECT data FROM data WHERE id = paramsref) as params,
                (SELECT data FROM data WHERE id = dataref) as data,
                (SELECT data FROM data WHERE id = prefixref) as prefix
            FROM logs
            WHERE
                user_id = :user_id
                AND network_id = :network_id
                AND bufferref = (SELECT id FROM data WHERE data = :buffer)
                ${fromSql}
                ${toSql}
            ORDER BY time DESC
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
        this.db.exec('BEGIN');

        let bufferId = await this.dataId(bufferName);
        let dataId = await this.dataId(data);
        let msgtagsId = await this.dataId(JSON.stringify(message.tags));
        let prefixId = await this.dataId(prefix);
        let paramsId = await this.dataId(params);

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

        this.db.exec('COMMIT');
        messagesTmr.stop();

        this.storeQueueLooping = false;
        this.storeMessageLoop();
    }

    async storeMessage(message, upstreamCon, clientCon) {
        this.storeQueue.push({message, upstreamCon, clientCon});
        this.storeMessageLoop();
    }

    async purgeMessages(userId, beforeTime) {
        if (!userId && !beforeTime) {
            return;
        }

        let stmt = this.db.prepare(`
        INSERT INTO logs_deletions (
            user_id,
            before_time
        ) VALUES (?, ?)
        `);

        await stmt.run(userId, beforeTime);
        await this.startMessagePurger();
    }

    async startMessagePurger() {
        if (this.purgerRunning) {
            return;
        }
        this.purgerRunning = true;
        this.messagePurger();
    }

    async messagePurger() {
        const selectJob = this.db.prepare(`
        SELECT
            id,
            user_id,
            before_time
        FROM logs_deletions
        ORDER BY id ASC
        LIMIT 1
        `);

        const job = selectJob.get();
        if (!job) {
            this.purgerRunning = false;
            return;
        }

        l('Purging messages matching: [user_id: ' + job.user_id + ' && before_time: ' + job.before_time + ']');

        const whereCond = [];
        if (job.user_id) {
            whereCond.push('user_id = :userId');
        }
        if (job.before_time) {
            whereCond.push('time < :beforeTime');
        }

        const deleteLogs = this.db.prepare(`
        DELETE FROM logs
        WHERE ${whereCond.join(' AND ')}
        AND msgid IN (
            SELECT msgid
            FROM logs
            WHERE ${whereCond.join(' AND ')}
            ORDER BY time ASC
            LIMIT :limit
        )`);
        const result = deleteLogs.run({
            userId: job.user_id,
            beforeTime: job.before_time,
            limit: this.purgerLimit
        });

        if (result.changes < this.purgerLimit) {
            // Last query's changes less than limit, job complete
            const deleteJob = this.db.prepare('DELETE FROM logs_deletions WHERE id = :jobId');
            deleteJob.run({jobId: job.id});
            l('Purging messages complete');
        }

        this.purgerTimeout = setTimeout(() => { this.messagePurger() }, this.purgerDelay);
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