class IrcBuffer {
    constructor(name, upstreamCon) {
        this.name = name;
        this.key = '';
        this.joined = false;
        this.topic = '';
        this.isChannel = upstreamCon ?
            upstreamCon.isChannelName(name) :
            true;
    }

    static fromObj(obj) {
        let c = new IrcBuffer(obj.name);
        c.key = obj.key || '';
        c.joined = obj.joined || false;
        c.topic = obj.topic || '';
        c.isChannel = !!obj.isChannel;
        return c;
    }
}

module.exports.IrcBuffer = IrcBuffer;

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
        this.buffers = Object.create(null);
        this.nick = 'unknown-user';
        this.account = '';
        this.username = 'user';
        this.realname = 'BNC user';
        this.password = '';
        this.host = '';
        this.port = 6667;
        this.tls = false;
        this.type = 0; // 0 = outgoing, 1 = incoming, 2 = server
        this.connected = false;
        this.sasl = {
            account: '',
            password: '',
        };
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
            account: this.account,
            connected: this.connected,
            sasl: JSON.stringify(this.sasl),
            server_prefix: this.serverPrefix,
            registration_lines: JSON.stringify(this.registrationLines),
            isupports: JSON.stringify(this.isupports),
            caps: JSON.stringify(this.caps),
            buffers: JSON.stringify(this.buffers),
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
            this.buffers = [];
            this.tempData = {};
            this.logging = true;
        } else {
            this.host = row.host;
            this.port = row.port;
            this.tls = row.tls;
            this.type = row.type;
            this.sasl = JSON.parse(row.sasl || '{"account":"","password":""}');
            this.connected = row.connected;
            this.serverPrefix = row.server_prefix;
            this.registrationLines = JSON.parse(row.registration_lines);
            this.isupports = JSON.parse(row.isupports);
            this.caps = JSON.parse(row.caps);
            this.buffers = Object.create(null);
            let rowChans = JSON.parse(row.buffers);
            for (let chanName in rowChans) {
                this.addBuffer(rowChans[chanName]);
            }
            this.nick = row.nick;
            this.account = row.account;
            this.netRegistered = row.net_registered;
            this.authUserId = row.auth_user_id;
            this.authNetworkId = row.auth_network_id;
            this.authAdmin = !!row.auth_admin;
            this.linkedIncomingConIds = new Set(JSON.parse(row.linked_con_ids || '[]'));
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

    getOrAddBuffer(name, upstreamCon) {
        let buffer = this.getBuffer(name);
        if (buffer) {
            return buffer;
        }

        buffer = this.addBuffer(name, upstreamCon);
        this.save();

        return buffer;
    }

    getBuffer(name) {
        return this.buffers[name.toLowerCase()];
    }

    addBuffer(chan, upstreamCon) {
        let buffer = null;
        if (typeof chan === 'string') {
            buffer = new IrcBuffer(chan, upstreamCon);
        } else {
            buffer = IrcBuffer.fromObj(chan);
        }

        this.buffers[buffer.name.toLowerCase()] = buffer;
        return buffer;
    }

    delBuffer(name) {
        delete this.buffers[name.toLowerCase()];
    }

    renameBuffer(oldName, newName) {
        let oldBuffer = this.getBuffer(oldName);
        if (!oldBuffer){
            return;
        }

        let newBuffer = this.getBuffer(newName);
        if (newBuffer) {
            return newBuffer;
        }

        delete this.buffers[oldName.toLowerCase()];
        oldBuffer.name = newName;
        this.buffers[newName.toLowerCase()] = oldBuffer;

        return oldBuffer;
    }

    linkIncomingConnection(id) {
        this.linkedIncomingConIds.add(id);
        this.save();
    }

    unlinkIncomingConnection(id) {
        this.linkedIncomingConIds.delete(id);
        this.save();
    }
}

module.exports.ConnectionState = ConnectionState;
