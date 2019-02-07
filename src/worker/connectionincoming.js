const uuidv4 = require('uuid/v4');
const IrcMessage = require('irc-framework').Message;
const { ConnectionState } = require('./connectionstate');
const ConnectionOutgoing = require('./connectionoutgoing');
const { isoTime } = require('../libs/helpers');
const strftime = require('strftime');

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
        this.writeMsgFrom('*bnc', 'PRIVMSG', this.state.nick, data);
    }

    writeFromBnc(command, ...params) {
        this.writeMsgFrom('*bnc', command, ...params);
    }

    writeMsg(msg, ...args) {
        let msgObj;

        if (typeof msg === 'string') {
            msgObj = new IrcMessage(msg, ...args);
        } else {
            msgObj = msg;
        }

        let eventObj = {halt: false, client: this, message: msgObj};
        ClientCommands.triggerHook('message_to_client', eventObj);
        if (eventObj.halt) {
            return;
        }

        this.write(msgObj.to1459() + '\r\n');
    }

    writeMsgFrom(fromMask, command, ...args) {
        let m = new IrcMessage(command, ...args);
        m.prefix = fromMask;
        return this.writeMsg(m);
    }

    async registerClient() {
        let upstream = this.upstream;
        this.state.nick = upstream.state.nick;
        this.state.username = upstream.state.username;
        this.state.realname = upstream.state.realname;

        let nick = this.state.nick;
        upstream.state.registrationLines.forEach((regLine) => {
            this.writeMsgFrom(upstream.state.serverPrefix, regLine[0], nick, ...regLine[1]);
        });

        this.state.netRegistered = true;

        // Dump all our joined channels..
        for (let chanName in upstream.state.channels) {
            let channel = upstream.state.channels[chanName];
            if (channel.joined) {
                this.writeMsgFrom(nick, 'JOIN', channel.name);
                channel.topic && this.writeMsg('TOPIC', channel.name, channel.topic);
                upstream.write(`NAMES ${channel.name}\n`);
            }
        }

        // Now the client has a channel list, send any messages we have for them
        for (let chanName in upstream.state.channels) {
            let messages = await this.messages.getMessagesFromTime(
                this.state.authUserId,
                this.state.authNetworkId,
                chanName,
                Date.now() - 3600*1000
            );

            let supportsTime = this.state.caps.includes('server-time');
            messages.forEach(async (msg) => {
                if (!supportsTime) {
                    msg.params[1] = `[${strftime('%H:%M:%S')}] ${msg.params[1]}`;
                }
                this.writeMsg(msg);
            });
        }

        await this.state.save();
    }

    // Handy helper to reach the hotReloadClientCommands() function
    reloadClientCommands() {
        hotReloadClientCommands();
    }

    async messageFromClient(message, raw) {
        await this.state.maybeLoad();
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
