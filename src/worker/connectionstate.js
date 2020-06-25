const Helpers = require('../libs/helpers');

class IrcUser {
    constructor(nick) {
        this.nick = nick || '';
        this.host = '';
        this.username = '';
        this.prefixes = [];
        this.tags = Object.create(null);
    }

    updatePrefixes(mode, upstreamCon) {
        const add = mode.mode[0] === '+';
        const idx = this.prefixes.indexOf(mode.prefix);

        if ((add && idx > -1) || (!add && idx === -1)) {
            // Attempting to perform an unneded action
            // like removing a none existing prefix
            // or adding an already existing prefix
            return;
        }

        if (!add) {
            this.prefixes.splice(idx, 1);
            return;
        }

        // Use PREFIX iSupportToken to maintain prefixes in order of priority
        const prefixes = Helpers.parsePrefixes(upstreamCon.iSupportToken('PREFIX'));
        const newPrefixes = [];
        for (let i = 0; i < prefixes.length; i++) {
            const existing = this.prefixes.indexOf(prefixes[i].symbol) > -1
            if (existing || prefixes[i].mode === mode.mode[1]) {
                newPrefixes.push(prefixes[i].symbol)
            }
        }
        this.prefixes = newPrefixes;
    }
}

class IrcBuffer {
    constructor(name, isChannel) {
        this.name = name;
        this.key = '';
        this.joined = false;
        this.topic = '';
        this.modes = Object.create(null);
        this.status = '=';
        this.isChannel = !!isChannel;
        this.lastSeen = 0;
        this.users = Object.create(null);
    }

    leave() {
        this.joined = false;
        this.users = Object.create(null);
    }

    addUser(nick, user={}) {
        let o = this.users[nick.toLowerCase()] || new IrcUser(nick);
        this.users[nick.toLowerCase()] = o;

        let addProp = (prop) => {
            if (typeof user[prop] !== 'undefined') {
                o[prop] = user[prop];
            }
        };

        o.nick = nick;
        addProp('host');
        addProp('username');
        addProp('prefixes');

        if (user.tags) {
            Object.assign(o.tags, user.tags);
        }
    }

    removeUser(nick) {
        delete this.users[nick.toLowerCase()];
    }

    renameUser(oldNick, newNick) {
        let user = this.users[oldNick.toLowerCase()];
        if (!user) {
            return;
        }
        this.removeUser(oldNick);
        this.addUser(newNick, user);
    }

    updateChanModes(mode) {
        if (mode.mode[0] === '+') {
            this.modes[mode.mode[1]] = mode.param;
        } else {
            delete this.modes[mode.mode[1]];
        }
    }

    static fromObj(obj) {
        let c = new IrcBuffer(obj.name);
        c.key = obj.key || '';
        c.joined = obj.joined || false;
        c.topic = obj.topic || '';
        Object.assign(c.modes, obj.modes);
        c.status = obj.status || '=';
        c.isChannel = !!obj.isChannel;
        c.lastSeen = obj.lastSeen || 0;

        if (obj.users) {
            for (let nick in obj.users) {
                let u = obj.users[nick];
                if (nick && u && u.nick) {
                    c.addUser(nick, u);
                }
            }
        }

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
        this.caps = new Set();
        this.buffers = Object.create(null);
        this.nick = 'unknown-user';
        this.account = '';
        this.username = 'user';
        this.realname = 'BNC user';
        this.password = '';
        this.host = '';
        this.port = 6667;
        this.tls = false;
        this.tlsverify = true;
        this.bindHost = '';
        this.type = 0; // 0 = outgoing, 1 = incoming, 2 = server
        this.connected = false;
        this.sasl = {
            account: '',
            password: '',
        };
        // netRegistered - incomingcon = client authed+registered, outgoingcon = regged to the upstream irc network
        this.netRegistered = false;
        // receivedMotd - outgoingcon = received MOTD end or error from upstream
        this.receivedMotd = false;
        this.authUserId = 0;
        this.authNetworkId = 0;
        this.authNetworkName = '';
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
        let query = this.db.dbConnections('connections').insert({
            conid: this.conId,
            last_statesave: Helpers.now(),
            bind_host: '',
            host: this.host,
            port: this.port,
            tls: this.tls,
            tlsverify: this.tlsverify,
            type: this.type,
            account: this.account,
            username: this.username,
            realname: this.realname,
            password: this.password,
            connected: this.connected,
            sasl: JSON.stringify(this.sasl),
            server_prefix: this.serverPrefix,
            registration_lines: JSON.stringify(this.registrationLines),
            isupports: JSON.stringify(this.isupports),
            caps: JSON.stringify(Array.from(this.caps)),
            buffers: JSON.stringify(this.buffers),
            nick: this.nick,
            received_motd: this.receivedMotd,
            net_registered: this.netRegistered,
            auth_user_id: this.authUserId,
            auth_network_id: this.authNetworkId,
            auth_network_name: this.authNetworkName,
            auth_admin: this.authAdmin,
            linked_con_ids: JSON.stringify([...this.linkedIncomingConIds]),
            logging: this.logging,
            temp: JSON.stringify(this.tempData),
        });

        // Connection state is only in sqlite so we can use sqlite specific syntax here
        let sql = query.toString().replace(/^insert into /, 'insert or replace into ');
        await this.db.dbConnections.raw(sql);
    }

    setNetwork(network) {
        this.authNetworkId = network.id;
        this.authNetworkName = network.name;
    }

    async loadConnectionInfo() {
        let net = await this.db.users.getNetwork(this.authNetworkId);
        let bindHost = '';

        // If a network doesn't have a bindHost, check if it's user has a global one instead
        if (net && net.bind_host) {
            bindHost = net.bind_host;
        } else if (net && !net.bind_host) {
            let user = await this.db.factories.User.query().where('id', this.authUserId).first();
            if (user && user.bind_host) {
                bindHost = user.bind_host;
            }
        }

        if (net) {
            this.bindHost = bindHost || '';
            this.host = net.host;
            this.port = net.port;
            this.tls = !!net.tls;
            this.tlsverify = !!net.tlsverify;
            this.sasl = { account: net.sasl_account || '', password: net.sasl_pass || '' };
            this.authNetworkName = net.name;

            // Add any channels that we don't already have
            (net.channels || '').split(',').forEach(chanName => {
                if (chanName.trim()) {
                    let buffer = this.getOrAddBuffer(chanName.trim());
                    buffer.joined = true;
                }
            });

            // We don't update the current nick if we're connected already as that would then
            // take us out of sync with the current IRC state
            if (!this.connected) {
                this.nick = net.nick;
            }

            this.username = net.username || net.nick || 'kiwibnc';
            this.realname = net.realname || net.nick || 'kiwibnc';
            this.password = net.password || '';
        } else {
            // This network wasn't found in the database. Maybe it was deleted
            this.bindHost = '';
            this.host = '';
            this.port = 0;
            this.tls = false;
            this.sasl = { account: '', password: '' };

            // We don't update the current nick if we're connected already as that would then
            // take us out of sync with the current IRC state
            if (!this.connected) {
                this.nick = '';
            }

            this.username = '';
            this.realname = '';
            this.password = '';
        }
    }
    async load() {
        let row = await this.db.dbConnections('connections').where('conid', this.conId).first();

        if (!row) {
            this.registrationLines = [];
            this.isupports = [];
            this.caps = new Set();
            this.buffers = [];
            this.tempData = {};
            this.logging = true;
        } else {
            this.bindHost = row.bind_host || '';
            this.host = row.host;
            this.port = row.port;
            this.tls = row.tls;
            this.tlsverify = row.tlsverify;
            this.type = row.type;
            this.sasl = JSON.parse(row.sasl || '{"account":"","password":""}');
            this.connected = row.connected;
            this.serverPrefix = row.server_prefix;
            this.registrationLines = JSON.parse(row.registration_lines);
            this.isupports = JSON.parse(row.isupports);
            this.caps = new Set(JSON.parse(row.caps));
            this.buffers = Object.create(null);
            let rowChans = JSON.parse(row.buffers);
            for (let chanName in rowChans) {
                this.addBuffer(rowChans[chanName]);
            }
            this.nick = row.nick;
            this.account = row.account;
            this.username = row.username;
            this.realname = row.realname;
            this.password = row.password;
            this.receivedMotd = row.received_motd;
            this.netRegistered = row.net_registered;
            this.authUserId = row.auth_user_id;
            this.authNetworkId = row.auth_network_id;
            this.authNetworkName = row.auth_network_name;
            this.authAdmin = !!row.auth_admin;
            this.linkedIncomingConIds = new Set(JSON.parse(row.linked_con_ids || '[]'));
            this.logging = !!row.logging;
            this.tempData = JSON.parse(row.temp);
        }

        this.loaded = true;
    }

    async destroy() {
        await this.db.dbConnections('connections').where('conid', this.conId).delete();
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
        if (name.indexOf('.') > -1) {
            // Route server messages to the server buffer
            name = '*';
        }

        let buffer = this.getBuffer(name);
        if (buffer) {
            return buffer;
        }

        buffer = this.addBuffer(name, upstreamCon);
        this.save();

        return buffer;
    }

    getBuffer(name) {
        if (name.indexOf('.') > -1) {
            // Route server messages to the server buffer
            name = '*';
        }

        return this.buffers[name.toLowerCase()];
    }

    addBuffer(chan, upstreamCon) {
        let buffer = null;
        if (typeof chan === 'string') {
            l.debug(`Adding buffer '${chan}'`);
            let isChannel = upstreamCon ?
                upstreamCon.isChannelName(chan) :
                '#&'.includes(chan[0]);
            buffer = new IrcBuffer(chan, isChannel);
        } else {
            l.debug(`Adding buffer '${chan.name}'`);
            buffer = IrcBuffer.fromObj(chan);
        }

        this.buffers[buffer.name.toLowerCase()] = buffer;
        return buffer;
    }

    delBuffer(name) {
        l.debug(`Removing buffer '${name}'`);
        delete this.buffers[name.toLowerCase()];
    }

    renameBuffer(oldName, newName) {
        l.debug(`Renaming buffer '${oldName}' => '${newName}'`);
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
