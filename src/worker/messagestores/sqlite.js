const sqlite3 = require('better-sqlite3');
const { isoTime } = require('../../libs/helpers');
const Stats = require('../../libs/stats');

const IrcMessage = require('irc-framework').Message;

const MSG_TYPE_PRIVMSG = 1;
const MSG_TYPE_NOTICE = 2;

class SqliteMessageStore {
    constructor(conf) {
        this.db = new sqlite3(conf.db_path || './messages.db');
        this.stats = Stats.instance().makePrefix('messages');

        this.storeQueueLooping = false;
        this.storeQueue = [];
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
    }

    // Insert a chunk of data into the data table if it doesn't already exist, returning its ID
    async dataId(data) {
        try {
            // Will fail if the data already exists in the db
            this.stmtInsertData.run(data);
        } catch (err) {
        }

        let row = this.stmtGetExistingDataId.get(data);
        return row.id;
    }

    async getMessagesFromMsgId(userId, networkId, buffer, fromMsgId, length) { }
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

        let messages = rows.map((row) => {
            let m = new IrcMessage();
            if (row.type === MSG_TYPE_PRIVMSG) {
                m.command = 'PRIVMSG';
            } else if (m.type === MSG_TYPE_NOTICE) {
                m.command = 'NOTICE'
            }

            m.prefix = row.prefix;
            m.tags = JSON.parse(row.msgtags);
            m.tags.time = m.tags.time || isoTime(new Date(row.time));
            m.params = row.params.split(' ');
            m.params.push(row.data);

            return m;
        });

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

        let messages = rows.map((row) => {
            let m = new IrcMessage();
            if (row.type === MSG_TYPE_PRIVMSG) {
                m.command = 'PRIVMSG';
            } else if (m.type === MSG_TYPE_NOTICE) {
                m.command = 'NOTICE'
            }

            m.prefix = row.prefix;
            m.tags = JSON.parse(row.msgtags);
            m.tags.time = m.tags.time || isoTime(new Date(row.time));
            m.params = row.params.split(' ');
            m.params.push(row.data);

            return m;
        });

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

        let {userId, networkId, message, conState} = args;

        let bufferName = '';
        let type = 0;
        let data = '';
        let params = '';
        let msgId = '';
        // If no prefix, it's because we're sending it upstream (from the client)
        let prefix = message.prefix || conState.nick;
        let time = new Date(message.tags.time || isoTime());

        if (message.command === 'PRIVMSG') {
            type = MSG_TYPE_PRIVMSG;
            bufferName = bufferNameIfPm(message, conState.nick, 0);
            data = message.params[1];
            params = message.params.slice(0, message.params.length - 1).join(' ');
            msgId = message.tags['draft/msgid'] || message.tags['msgid'] || '';
        } else if (message.command === 'NOTICE') {
            type = MSG_TYPE_NOTICE;
            bufferName = bufferNameIfPm(message, conState.nick, 0);
            // We store the last param as data so that it is searchable in future
            data = message.params[1];
            params = message.params.slice(0, message.params.length - 1).join(' ');
            msgId = message.tags['draft/msgid'] || message.tags['msgid'] || '';
        }
        
        if (!type) {
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

    async storeMessage(userId, networkId, message, conState) {
        this.storeQueue.push({userId, networkId, message, conState});
        this.storeMessageLoop();
    }
}

module.exports = SqliteMessageStore;

function bufferNameIfPm(message, nick, messageNickIdx) {
    if (nick.toLowerCase() === message.params[messageNickIdx]) {
        // It's a PM
        return message.nick;
    } else {
        return message.params[messageNickIdx];
    }
}
