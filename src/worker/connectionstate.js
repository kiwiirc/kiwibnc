class Channel {
    constructor(name) {
        this.name = name;
        this.key = '';
        this.joined = false;
        this.topic = '';
    }

    static fromObj(obj) {
        let c = new Channel(obj.name);
        c.key = obj.key || '';
        c.joined = obj.joined || false;
        c.topic = obj.topic || '';
        return c;
    }
}

module.exports.Channel = Channel;

class ConnectionState {
    constructor(id, db) {
        this.db = db;
        this.conId = id;
        // loaded - State has been loaded from the db
        this.loaded = false;
        // serverPrefix - The server name given in the 001 message prefix
        this.serverPrefix = 'bnc';
        this.registrationLines = [];
        this.isupports = [];
        this.caps = [];
        this.channels = Object.create(null);
        this.nick = 'unknown-user';
        this.username = 'user';
        this.realname = 'BNC user';
        this.password = '';
        this.host = '';
        this.port = 6667;
        this.tls = false;
        this.type = 0; // 0 = outgoing, 1 = incoming, 2 = server
        this.connected = false;
        // netRegistered - incomingcon = client authed+registered, outgoingcon = regged to the upstream irc network
        this.netRegistered = false;
        this.authUserId = 0;
        this.authNetworkId = 0;

        // When an incoming connection finds its upstream, they add them here
        this.linkedIncomingConIds = new Set([]);
    }
    
    async maybeLoad() {
        if (!this.loaded) {
            await this.load();
        }
    }

    async save() {
        let registrationLines = JSON.stringify(this.registrationLines);
        let isupports = JSON.stringify(this.isupports);
        let caps = JSON.stringify(this.caps);
        let channels = JSON.stringify(this.channels);

        let sql = `INSERT OR REPLACE INTO connections (conid, last_statesave, host, port, tls, type, connected, server_prefix, registration_lines, isupports, caps, channels, nick, net_registered, auth_user_id, auth_network_id, linked_con_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        await this.db.run(sql, [
            this.conId,
            Date.now(),
            this.host,
            this.port,
            this.tls,
            this.type,
            this.connected,
            this.serverPrefix,
            registrationLines,
            isupports,
            caps,
            channels,
            this.nick,
            this.netRegistered,
            this.authUserId,
            this.authNetworkId,
            JSON.stringify([...this.linkedIncomingConIds]),
        ]);
    }

    async load() {
        let sql = `SELECT * FROM connections WHERE conid = ? LIMIT 1`;
        let row = await this.db.get(sql, [this.conId]);

        if (!row) {
            this.registrationLines = [];
            this.isupports = [];
            this.caps = [];
            this.channels = [];
        } else {
            this.host = row.host;
            this.port = row.port;
            this.tls = row.tls;
            this.type = row.type;
            this.connected = row.connected;
            this.serverPrefix = row.server_prefix;
            this.registrationLines = JSON.parse(row.registration_lines);
            this.isupports = JSON.parse(row.isupports);
            this.caps = JSON.parse(row.caps);
            this.channels = Object.create(null);
            let rowChans = JSON.parse(row.channels);
            for (let chanName in rowChans) {
                this.addChannel(rowChans[chanName]);
            }
            this.nick = row.nick;
            this.netRegistered = row.net_registered;
            this.authUserId = row.auth_user_id;
            this.authNetworkId = row.auth_network_id;
            this.linkedIncomingConIds = new Set(JSON.parse(row.linked_con_ids));
        }

        this.loaded = true;
    }

    async destroy() {
        await this.db.run(`DELETE FROM connections WHERE conid = ?`, [this.conId]);
    }

    getChannel(name) {
        return this.channels[name.toString()];
    }

    addChannel(chan) {
        let channel = null;
        if (typeof chan === 'string') {
            channel = new Channel(chan);
        } else {
            channel = Channel.fromObj(chan);
        }

        this.channels[channel.name.toLowerCase()] = channel;
        return channel;
    }
}

module.exports.ConnectionState = ConnectionState;
