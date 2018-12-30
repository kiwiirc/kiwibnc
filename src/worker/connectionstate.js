class Channel {
    constructor(name) {
        this.name = name;
        this.key = '';
        this.joined = false;
    }
}

module.exports.Channel = Channel;

class ConnectionState {
    constructor(id, db) {
        this.db = db;
        this.conId = id;
        this.loaded = false;
        this.isupports = [];
        this.caps = [];
        this.channels = [];
        this.nick = '';
        this.username = 'user';
        this.realname = 'BNC user';
        this.password = '';
        this.host = '';
        this.port = 6667;
        this.tls = false;
        this.type = 0; // 0 = outgoing, 1 = incoming, 2 = server
        this.connected = false;
        this.netRegistered = false;
        this.authUserId = 0;
        this.authNetworkId = 0;
    }
    
    async maybeLoad() {
        if (!this.loaded) {
            await this.load();
        }
    }

    async save() {
        let isupports = JSON.stringify(this.isupports);
        let caps = JSON.stringify(this.caps);
        let channels = JSON.stringify(this.channels);

        let sql = `INSERT OR REPLACE INTO connections (conid, last_statesave, host, port, tls, type, connected, isupports, caps, channels, nick, net_registered, auth_user_id, auth_network_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        await this.db.run(sql, [
            this.conId,
            Date.now(),
            this.host,
            this.port,
            this.tls,
            this.type,
            this.connected,
            isupports,
            caps,
            channels,
            this.nick,
            this.netRegistered,
            this.authUserId,
            this.authNetworkId,
        ]);
    }

    async load() {
        let sql = `SELECT * FROM connections WHERE conid = ? LIMIT 1`;
        let row = await this.db.get(sql, [this.conId]);

        if (!row) {
            this.isupports = [];
            this.caps = [];
            this.channels = [];
        } else {
            this.host = row.host;
            this.port = row.port;
            this.tls = row.tls;
            this.type = row.type;
            this.connected = row.connected;
            this.isupports = JSON.parse(row.isupports);
            this.caps = JSON.parse(row.caps);
            this.channels = JSON.parse(row.channels);
            this.nick = row.nick;
            this.netRegistered = row.net_registered;
            this.authUserId = row.auth_user_id;
            this.authNetworkId = row.auth_network_id;
        }

        this.loaded = true;
    }

    async destroy() {
        await this.db.run(`DELETE FROM connections WHERE conid = ?`, [this.conId]);
    }
}

module.exports.ConnectionState = ConnectionState;
