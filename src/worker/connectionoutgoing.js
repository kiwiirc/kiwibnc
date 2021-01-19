const uuidv4 = require('uuid/v4');
const hooks = require('./hooks');
const Helpers = require('../libs/helpers');
const { ConnectionState, IrcBuffer } = require('./connectionstate');

// Upstream commands can be hot reloaded as they contain no state
let UpstreamCommands = null;

function hotReloadUpstreamCommands() {
    delete require.cache[require.resolve('./upstreamcommands')];
    UpstreamCommands = require('./upstreamcommands');
}

hotReloadUpstreamCommands();

function rand(min, max) {
    return Math.floor(Math.random() * (max - min) + min);
}

class ConnectionOutgoing {
    constructor(_id, db, messages, queue, conDict) {
        let id = _id || uuidv4();
        this.db = db;
        this.state = new ConnectionState(this, id, db);
        this.state.type = 0;
        this.messages = messages;
        this.queue = queue;
        this.conDict = conDict;

        this.conDict.set(id, this);
    }

    get id() {
        return this.state.conId;
    }

    destroy() {
        this.conDict.delete(this.id);
        this.state.destroy();
    }

    close() {
        this.state.tempSet('requested_close', true);
        this.queue.sendToSockets('connection.close', {
            id: this.id,
        });
    }

    async open() {
        await this.state.loadConnectionInfo();

        const sendForbidden = () => {
            l.info('Attempted connection to forbidden network, ' + this.state.host);
            this.forEachClient((client) => {
                if (client.state.netRegistered) {
                    client.writeStatus('This network is forbidden');
                } else {
                    client.write('ERROR :This network is forbidden\r\n');
                    client.close();
                }
            });
        }

        const lcHost = this.state.host.toLowerCase();
        const blacklist = config.get('connections.blacklist', []);
        if (blacklist.length > 0 && Helpers.hasMinimatch(blacklist, lcHost)) {
            sendForbidden();
            return;
        }

        const whitelist = config.get('connections.whitelist', []);
        if (whitelist.length > 0 && !Helpers.hasMinimatch(whitelist, lcHost)) {
            sendForbidden();
            return;
        }

        let connection = {
            host: this.state.host,
            port: this.state.port,
            tls: this.state.tls,
            tlsverify: this.state.tlsverify,
            id: this.id,
            bindAddress: this.state.bindHost || '',
            family: undefined,
            // servername - force a specific TLS servername
            servername: undefined,
            connectTimeout: 5000,
        };

        let hook = await hooks.emit('connection_to_open', {upstream: this, connection });

        // If connected is true then it is most likely already open and it can't be prevented
        if (hook.prevent && !this.state.connected) {
            return;
        }

        if (connection.host && connection.port) {
            this.queue.sendToSockets('connection.open', connection);
        }
    }

    throttle(interval) {
        this.queue.sendToSockets('connection.throttle', {id: this.id, interval});
    }

    write(data) {
        this.queue.sendToSockets('connection.data', {id: this.id, data: data});
    }

    writeLine(...params) {
        // If the last param contains a space, turn it into a trailing param
        let lastParam = params[params.length - 1];
        if (params.length > 1 && (lastParam[0] === ':' || lastParam.indexOf(' ') > -1)) {
            params[params.length - 1] = ':' + params[params.length - 1];
        }
        this.write(params.join(' ') + '\r\n');
    }

    async forEachClient(fn, excludeCon) {
        this.state.linkedIncomingConIds.forEach(async (conId) => {
            let clientCon = this.conDict.get(conId);
            if (clientCon && clientCon !== excludeCon) {
                await fn(clientCon);
            }
        });
    }

    async messageFromUpstream(message, raw) {
        await this.state.maybeLoad();

        let passDownstream = await UpstreamCommands.run(message, this);
        if (passDownstream !== false) {
            // Send this data down to any linked clients
            let clients = [];
            this.forEachClient((client) => {
                if (client.state.netRegistered) {
                    clients.push(client);
                }
            });

            let hook = await hooks.emit('message_to_clients', {clients, message});
            if (hook.prevent) {
                return;
            }

            hook.event.clients.forEach(async client => {
                // Keep track of any changes to our user in this client instance
                let isUs = message.nick.toLowerCase() === client.state.nick.toLowerCase();
                if (message.command.toUpperCase() === 'NICK' && isUs) {
                    client.state.nick = message.params[0];
                    await client.state.save();
                }

                await client.writeMsg(message);
            });
        }
    }

    async onUpstreamConnected() {
        // Reset some state. They will be re-populated when upstream sends its registration burst again
        this.state.connected = true;
        this.state.netRegistered = false;
        this.state.receivedMotd = false;
        this.state.isupports = [];
        this.state.registrationLines = [];

        // tempSet() saves the state
        await this.state.tempSet('reconnecting', null);
        await this.state.tempSet('irc_error', null);

        hooks.emit('connection_open', {upstream: this});

        this.writeLine('CAP LS 302');

        if (this.state.password) {
            this.writeLine(`PASS ${this.state.password}`);
        }

        let {username, realname} = await this.makeUserAndRealNames();
        this.writeLine(`NICK ${this.state.nick}`);
        this.writeLine(`USER ${username} * * :${realname}`);

        this.forEachClient((client) => {
            client.writeStatus('Network connected!');
        });
    }

    async onUpstreamClosed(err) {
        // If we were trying to reconnect, continue with that instead
        if (this.state.tempGet('reconnecting')) {
            this.reconnect();
            return;
        }

        let shouldReconnect = this.state.connected &&
            this.state.netRegistered;

        if (this.state.tempGet('requested_close')) {
            shouldReconnect = false;
            await this.state.tempSet('requested_close', null);
        }

        this.state.connected = false;
        this.state.netRegistered = false;
        this.state.receivedMotd = false;

        for (let chanName in this.state.buffers) {
            let channel = this.state.buffers[chanName];
            if (channel.joined) {
                this.forEachClient(async (client) => {
                    await client.writeMsgFrom(client.state.nick, 'PART', channel.name);
                });
            }

            channel.leave();
        }

        await this.state.save();

        hooks.emit('connection_close', {upstream: this});

        this.forEachClient(async (client) => {
            let msg = 'Network disconnected';
            if (err && err.code) {
                msg += ` (${err.code})`;
            } else if (err && typeof err === 'string') {
                msg += ` (${err})`;
            }

            // Include any ERROR lines the ircd sent down
            let ircErr = await this.state.tempGet('irc_error');
            if (ircErr) {
                msg += ` (${ircErr})`;
            }

            client.writeStatus(msg);

            if (!client.state.netRegistered) {
                client.registerLocalClient();
            }
        });

        if (shouldReconnect) {
            this.reconnect();
        }
    }

    async reconnect() {
        let numAttempts = this.state.tempGet('reconnecting') || 0;
        numAttempts++;
        await this.state.tempSet('reconnecting', numAttempts);

        let reconnectTimeout = (Math.min(numAttempts ** 2, 60) * 1000) + rand(300, 5000);
        l('Reconnection attempt ' + numAttempts + ' in ' + reconnectTimeout + 'ms');

        setTimeout(() => {
            // The user may have forced a reconnect since
            if (this.state.connected) {
                return;
            }

            this.open();
        }, reconnectTimeout);
    }

    async makeUserAndRealNames() {
        let username = config.get('users.username', '{{username}}');
        let realname = config.get('users.realname', '{{realname}}');

        // Only get the user instance if we need it
        if (username.includes('{{user.') || realname.includes('{{user.')) {
            let user = await this.db.factories.User.query()
                .where('id', this.state.authUserId)
                .first();

            let vals = Object.create(null);
            vals['{{user.username}}'] = user.username;
            vals['{{user.id}}'] = user.id;

            for (let prop in vals) {
                username = username.replace(prop, vals[prop]);
                realname = realname.replace(prop, vals[prop]);
            }
        }

        let vals = Object.create(null);
        vals['{{username}}'] = this.state.username;
        vals['{{realname}}'] = this.state.realname;
        vals['{{nick}}'] = this.state.nick;
        vals['{{account}}'] = this.state.sasl.account;
        vals['{{nick}}'] = this.state.nick;

        for (let prop in vals) {
            username = username.replace(prop, vals[prop]);
            realname = realname.replace(prop, vals[prop]);
        }

        username = username.trim().replace(/ /g, '');
        realname = realname.trim();

        // There are cases where either value may be empty (eg. '{account}' on a connection
        // without an account). Set some fallbacks
        return {
            username: username || 'user',
            realname: realname || 'BNC user',
        };
    }

    iSupportToken(tokenName) {
        let token = this.state.isupports.find((tok) => tok.indexOf(`${tokenName}=`) === 0);
        if (!token) {
            return false;
        }

        return token.replace(`${tokenName}=`, '');
    }

    isChannelName(inp) {
        let types = this.iSupportToken('CHANTYPES') || '#&';
        return types.indexOf(inp[0]) > -1;
    }
}

module.exports = ConnectionOutgoing;
