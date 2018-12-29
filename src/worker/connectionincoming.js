const uuidv4 = require('uuid/v4');
const { ConnectionState } = require('./connectionstate');
const ConnectionOutgoing = require('./connectionoutgoing');

class ConnectionIncoming {
    constructor(_id, db, userDb, queue) {
        let id = _id || uuidv4();
        this.state = new ConnectionState(id, db);
        this.state.type = 1;
        this.queue = queue;
        this.map = null;
        this.db = db;
        this.userDb = userDb;
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
            l('matching with con', con.state.authUserId, con.state.authNetworkId)
            if (
                con.state.type === 0 &&
                con.state.authUserId === this.state.authUserId &&
                con.state.authNetworkId === this.state.authNetworkId
            ) {
                this.cachedUpstreamId = con.id;
                foundCon = con;
            }
        });

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

        this.state.destroy();
    }

    write(data) {
        this.queue.sendToSockets('connection.data', {id: this.id, data: data});
    }

    async messageFromClient(message) {
        this.state.maybeLoad();

        if (message.command === 'PASS' && !this.state.authUserId) {
            // Matching for user/network:pass or user:pass
            let m = (message.params[0] || '').match(/([^\/:]+)[:\/]([^:]+):?(.*)?/);
            if (!m) {
                this.write('ERROR :Invalid password\n');
                return;
            }

            let username = m[1] || '';
            let networkName = m[2] || '';
            let password = m[3] || '';

            let network = await this.userDb.authUserNetwork(username, password, networkName);
            if (!network) {
                this.write('ERROR :Invalid password\n');
                return;
            }

            this.state.authUserId = network.user_id;
            this.state.authNetworkId = network.id;
            await this.state.save();

            if (!this.upstream) {
                this.makeUpstream(network);
            } else {
                this.write(`:*!bnc@bnc PRIVMSG ${this.nick} :Attaching you to the network\n`);
            }
        }

        // PM to * while logged in
        if (message.command === 'PRIVMSG' && message.params[0] === '*' && this.state.authUserId) {
            if (message.params[1] === 'connect') {
                if (this.upstream) {
                    this.write(`:*!bnc@bnc PRIVMSG ${this.state.nick} :Already connected\n`);
                } else {
                    this.makeUpstream();
                }
            }
        }

        if (message.command === 'NICK') {
            this.state.nick = message.params[0];
            this.state.save();
            this.write(`:${this.state.nick} NICK ${this.state.nick}\n`);
        }

        if (message.command === 'PING') {
            this.write('PONG :' + message.params[0] + '\n');
        }

        if (message.command === 'STATE') {
            this.write(':bnc NOTICE * :You are ' + this.state.nick + '\n');
        }

        // TODO: Remove this kill code!
        if (message.command === 'KILL') {
            this.queue.stopListening().then(process.exit);
        }
    }

    async makeUpstream(network) {
        if (!network) {
            network = await this.userDb.getNetwork(this.state.authNetworkId);
        }

        let con = new ConnectionOutgoing(null, this.db, this.queue);
        con.state.authUserId = this.state.authUserId;
        con.state.authNetworkId = this.state.authNetworkId
        con.state.host = network.host;
        con.state.port = network.port;
        con.state.tls = network.tls;
        con.state.nick = network.nick;
        con.state.username = network.username;
        con.state.realname = network.realname;
        con.state.password = network.password;
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
        this.write(`:bnc NOTICE ${this.state.nick} :Welcome to BNC!\n`);
    }

    onClientClosed() {
        this.destroy();
    }
}

module.exports = ConnectionIncoming;
