const uuidv4 = require('uuid/v4');
const { ConnectionState } = require('./connectionstate');
const ConnectionOutgoing = require('./connectionoutgoing');

// Client commands can be hot reloaded as they contain no state
let ClientCommands = null;

function hotReloadClientCommands() {
    delete require.cache[require.resolve('./clientcommands')];
    ClientCommands = require('./clientcommands');
}

hotReloadClientCommands();

class ConnectionIncoming {
    constructor(_id, db, userDb, messages, queue) {
        let id = _id || uuidv4();
        this.state = new ConnectionState(id, db);
        this.state.type = 1;
        this.queue = queue;
        this.map = null;
        this.db = db;
        this.userDb = userDb;
        this.messages = messages;
        this.cachedUpstreamId = '';
    }

    get id() {
        return this.state.conId;
    }

    get upstream() {
        // Not logged in = no upstream connection possible
        if (!this.state.authUserId) {
            return null;
        }

        if (this.cachedUpstreamId) {
            let con = this.map.get(this.cachedUpstreamId);
            if (con) {
                return con;
            }

            // this.map may no longer contain cachedUpstreamId if that con was disconnected
            this.cachedUpstreamId = false;
        }

        // Find an outgoing connection instance that matches the user + network info this connection
        // has authed into
        let foundCon = null;
        this.map.forEach((con) => {
            if (foundCon) return;
            if (
                con.state.type === 0 &&
                con.state.authUserId === this.state.authUserId &&
                con.state.authNetworkId === this.state.authNetworkId
            ) {
                this.cachedUpstreamId = con.id;
                foundCon = con;
            }
        });

        // If we found an upstream, add this incoming connection to it
        if (foundCon) {
            foundCon.state.linkedIncomingConIds.add(this.id);
            foundCon.state.save();
        }

        return foundCon;
    }

    trackInMap(map) {
        this.map = map;
        map.set(this.id, this);
    }

    destroy() {
        if (this.map) {
            this.map.delete(this.id);
        }

        if (this.upstream) {
            this.upstream.state.linkedIncomingConIds.delete(this.id);
        }

        this.state.destroy();
    }

    close() {
        this.queue.sendToSockets('connection.close', {
            id: this.id,
        });
    }

    write(data) {
        this.queue.sendToSockets('connection.data', {id: this.id, data: data});
    }

    writeStatus(data) {
        this.write(`:bnc PRIVMSG ${this.state.nick} :${data}\n`);
    }

    writeFromBnc(command, ...params) {
        this.writeLine(':bnc', command, ...params);
    }

    writeLine(...params) {
        // If the last param contains a space, turn it into a trailing param
        let lastParam = params[params.length - 1];
        if (params.length > 1 && (lastParam[0] === ':' || lastParam.indexOf(' ') > -1)) {
            params[params.length - 1] = ':' + params[params.length - 1];
        }
        this.write(params.join(' ') + '\n');
    }

    async registerClient() {
        let upstream = this.upstream;
        this.state.nick = upstream.state.nick;
        this.state.username = upstream.state.username;
        this.state.realname = upstream.state.realname;

        let nick = this.state.nick;
        upstream.state.registrationLines.forEach((regLine) => {
            this.writeLine(':' + upstream.state.serverPrefix, regLine[0], nick, ...regLine[1]);
        });

        this.state.netRegistered = true;

        // Dump all our joined channels..
        for (let chanName in upstream.state.channels) {
            let channel = upstream.state.channels[chanName];
            if (channel.joined) {
                this.writeLine(':' + nick, 'JOIN', channel.name);
                channel.topic && this.writeLine('TOPIC', channel.name, channel.topic);
                upstream.write(`NAMES ${channel.name}\n`);
            }
        }

        for (let chanName in upstream.state.channels) {
            let messages = await this.messages.getMessagesFromTime(
                this.state.authUserId,
                this.state.authNetworkId,
                chanName,
                Date.now() - 3600*1000
            );

            messages.forEach(async (msg) => {
                this.write(msg.to1459() + '\n');
            });
        }

        await this.state.save();
    }

    // Handy helper to reach the hotReloadClientCommands() function
    reloadClientCommands() {
        hotReloadClientCommands();
    }

    async messageFromClient(message, raw) {
        this.state.maybeLoad();
        let passUpstream = await ClientCommands.run(message, this);
        if (passUpstream !== false && this.upstream) {
            this.upstream.write(raw + '\n');
        }
    }

    async makeUpstream(network) {
        if (!network) {
            network = await this.userDb.getNetwork(this.state.authNetworkId);
        }

        let con = new ConnectionOutgoing(null, this.db, this.messages, this.queue);
        con.state.authUserId = this.state.authUserId;
        con.state.authNetworkId = this.state.authNetworkId
        con.state.host = network.host;
        con.state.port = network.port;
        con.state.tls = network.tls;
        con.state.nick = network.nick;
        con.state.username = network.username;
        con.state.realname = network.realname;
        con.state.password = network.password;
        con.state.linkedIncomingConIds.add(this.id);
        con.trackInMap(this.map);
        await con.state.save();

        this.queue.sendToSockets('connection.open', {
            host: con.state.host,
            port: con.state.port,
            tls: con.state.tls,
            id: con.id,
        });

        return con;
    }

    onAccepted() {
    }

    onClientClosed() {
        this.destroy();
    }
}

module.exports = ConnectionIncoming;
