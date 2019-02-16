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
        this.authAdmin = false;

        // When an incoming connection finds its upstream, they add them here
        this.linkedIncomingConIds = new Set([]);

        // Message logging may be disabled. Only used on the upstream connection
        this.logging = true;

        // Temporary misc data such as CAP negotiation status
        this.tempData = {};
    }
    
    async maybeLoad() {
        if (!this.loaded) {
            await this.load();
        }
    }

    async save() {
        let query = this.db.db('connections').insert({
            conid: this.conId,
            last_statesave: Date.now(),
            host: this.host,
            port: this.port,
            tls: this.tls,
            type: this.type,
            connected: this.connected,
            server_prefix: this.serverPrefix,
            registration_lines: JSON.stringify(this.registrationLines),
            isupports: JSON.stringify(this.isupports),
            caps: JSON.stringify(this.caps),
            channels: JSON.stringify(this.channels),
            nick: this.nick,
            net_registered: this.netRegistered,
            auth_user_id: this.authUserId,
            auth_network_id: this.authNetworkId,
            auth_admin: this.authAdmin,
            linked_con_ids: JSON.stringify([...this.linkedIncomingConIds]),
            logging: this.logging,
            temp: JSON.stringify(this.tempData),
        });
        let sql = query.toString().replace(/^insert into /, 'insert or replace into ');
        await this.db.run(sql);
    }

    async load() {
        let sql = `SELECT * FROM connections WHERE conid = ? LIMIT 1`;
        let row = await this.db.get(sql, [this.conId]);

        if (!row) {
            this.registrationLines = [];
            this.isupports = [];
            this.caps = [];
            this.channels = [];
            this.tempData = {};
            this.logging = true;
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
            this.authAdmin = !!row.auth_admin;
            this.linkedIncomingConIds = new Set(JSON.parse(row.linked_con_ids));
            this.logging = !!row.logging;
            this.tempData = JSON.parse(row.temp);
        }

        this.loaded = true;
    }

    async destroy() {
        await this.db.run(`DELETE FROM connections WHERE conid = ?`, [this.conId]);
    }

    tempGet(key) {
        return this.tempData[key];
    }

    async tempSet(key, val) {
        if (typeof key === 'string') {
            if (val === null) {
                delete this.tempData[key];
            } else {
                this.tempData[key] = val;
            }
        } else if (typeof key === 'object') {
            for (let prop in key) {
                if (key[prop] === null) {
                    delete this.tempData[prop];
                } else {
                    this.tempData[prop] = key[prop];
                }
            }
        }

        await this.save();
    }

    getChannel(name) {
        return this.channels[name.toLowerCase()];
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

    delChannel(name) {
        delete this.channels[name.toLowerCase()];
    }
}

module.exports.ConnectionState = ConnectionState;
