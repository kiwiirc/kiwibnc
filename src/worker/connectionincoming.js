const uuidv4 = require('uuid/v4');
const IrcMessage = require('irc-framework').Message;
const { ConnectionState } = require('./connectionstate');
const ConnectionOutgoing = require('./connectionoutgoing');
const hooks = require('./hooks');
const strftime = require('strftime');

// Client commands can be hot reloaded as they contain no state
let ClientCommands = null;

function hotReloadClientCommands() {
    delete require.cache[require.resolve('./clientcommands')];
    ClientCommands = require('./clientcommands');
}

hotReloadClientCommands();

class ConnectionIncoming {
    constructor(_id, db, userDb, messages, queue, conDict) {
        let id = _id || uuidv4();
        this.state = new ConnectionState(id, db);
        this.state.type = 1;
        this.queue = queue;
        this.conDict = conDict;
        this.db = db;
        this.userDb = userDb;
        this.messages = messages;
        this.cachedUpstreamId = '';

        this.conDict.set(id, this);
    }

    get id() {
        return this.state.conId;
    }

    get upstream() {
        // Not logged in = no upstream connection possible
        if (!this.state.authUserId) {
            l.trace('upstream() no authUserId');
            return null;
        }

        // Not authed into a network = user mode only
        if (!this.state.authNetworkId) {
            l.trace('upstream() no authNetworkId');
            return null;
        }

        if (this.cachedUpstreamId) {
            let con = this.conDict.get(this.cachedUpstreamId);
            if (con) {
                l.trace('upstream() Found cached upstream');
                return con;
            }

            // this.conDict may no longer contain cachedUpstreamId if that con was disconnected
            l.trace('upstream() Clearing cached upstream');
            this.cachedUpstreamId = false;
        }

        let upstream = this.conDict.findUsersOutgoingConnection(this.state.authUserId, this.state.authNetworkId);

        // If we found an upstream, add this incoming connection to it
        if (upstream) {
            l.trace('upstream() Found upstream, caching');
            this.cachedUpstreamId = upstream.id;
            upstream.state.linkIncomingConnection(this.id);
        } else {
            l.trace('upstream() Upstream not found');
        }

        return upstream;
    }

    destroy() {
        if (this.upstream) {
            this.upstream.state.unlinkIncomingConnection(this.id);
        }

        this.conDict.delete(this.id);
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
        return this.writeMsgFrom('*bnc', 'PRIVMSG', this.state.nick, data);
    }

    writeStatusWithTags(data, tags) {
        let m = new IrcMessage('PRIVMSG', this.state.nick, data);
        m.prefix = '*bnc';
        m.tags = tags;
        return this.writeMsg(m);
    }

    writeFromBnc(command, ...params) {
        return this.writeMsgFrom('*bnc', command, ...params);
    }

    writeMsg(msg, ...args) {
        let msgObj;

        if (typeof msg === 'string') {
            msgObj = new IrcMessage(msg, ...args);
        } else {
            msgObj = msg;
        }

        return hooks.emit('message_to_client', {client: this, message: msgObj, raw: ''}).then(hook => {
            if (hook.prevent) {
                return;
            }

            let toWrite = hook.event.raw || msgObj.to1459() + '\r\n';
            this.write(toWrite);
        });
    }

    writeMsgFrom(fromMask, command, ...args) {
        let m = new IrcMessage(command, ...args);
        m.prefix = fromMask;
        return this.writeMsg(m);
    }

    supportsCapNotify() {
        if (this.state.caps.has('cap-notify')) {
            return true;
        }

        // CAP versions over 301 implicitally support cap-notify
        if ((this.state.tempGet('capver') || 301) > 301) {
            return true;
        }

        return false;
    }

    async registerLocalClient() {
        let regLines = [
            ['001', this.state.nick, 'Welcome to your BNC'],
            ['002', this.state.nick, 'Your host is *bnc, running version kiwibnc-0.1'],
        ];

        let isupportTokens = [
            'CHANTYPES=#',
            'CHANMODES=eIbq,k,flj,CFLMPQScgimnprstz',
            'CHANLIMIT=#:0',
            'PREFIX=(o)@',
            'MAXLIST=bqeI:100',
            'MODES=4',
            'NETWORK=bnc',
            'CALLERID=g',
            'CASEMAPPING=rfc1459',
        ];
        await hooks.emit('available_isupports', {client: this, tokens: isupportTokens});

        // Convert all the isupport tokens into 005 lines making sure not to go over 512 in length
        let tokenLines = batchIsupportTokensToMaxLenth(
            isupportTokens,
            `:*bnc 005 ${this.state.nick}`,
            'are supported by this server',
            512
        );

        tokenLines.forEach((tokenParams) => {
            let params = [...tokenParams, 'are supported by this server'];
            regLines.push(['005', this.state.nick, ...params]);
        });

        regLines = regLines.concat([
            ['375', this.state.nick, '- BNC Message of the Day -'],
            ['372', this.state.nick, '- Send a message to *bnc to get started -'],
            ['372', this.state.nick, '- /query *bnc -'],
            ['376', this.state.nick, 'End of /MOTD command'],
        ]);

        regLines.forEach(line => this.writeFromBnc(...line));

        this.state.netRegistered = true;
        await this.state.save();
        await hooks.emit('client_registered', {client: this});
    }

    async registerClient() {
        let upstream = this.upstream;
        this.state.nick = upstream.state.nick;
        this.state.username = upstream.state.username;
        this.state.realname = upstream.state.realname;

        let nick = this.state.nick;

        // Let plugins modify/add isupport tokens
        let isupports = upstream.state.registrationLines.filter((regLine) => regLine[0] === '005');
        let isupportTokens = isupports.reduce((prev, cur) => {
            // Remove the last token as it's usually 'are supported by this server'.
            let tokens = cur[1];
            return prev.concat(tokens.slice(0, tokens.length - 1));
        }, []);
        await hooks.emit('available_isupports', {client: this, tokens: isupportTokens});

        // Convert all the isupport tokens into 005 lines making sure not to go over 512 in length
        let tokenLines = batchIsupportTokensToMaxLenth(
            isupportTokens,
            `:${upstream.state.serverPrefix} 005 ${nick}`,
            'are supported by this server',
            512
        );

        let sent005 = false;
        upstream.state.registrationLines.forEach((regLine) => {
            if (regLine[0] === '005' && !sent005) {
                sent005 = true;
                tokenLines.forEach((tokenParams) => {
                    let params = [...tokenParams, 'are supported by this server'];
                    this.writeMsgFrom(upstream.state.serverPrefix, '005', nick, ...params);
                });
            } else if (regLine[0] === '005' && sent005) {
                return;
            } else {
                this.writeMsgFrom(upstream.state.serverPrefix, regLine[0], nick, ...regLine[1]);
            }
        });

        let account = upstream.state.account;
        let username = this.state.username;
        let host = this.state.host;
        if (account !== '') {
            this.writeMsgFrom(upstream.state.serverPrefix, '900', nick, `${nick}!${username}@${host}`, account, `You are now logged in as ${account}`);
        }

        if (Object.keys(upstream.state.userModes).length > 0) {
            this.writeMsgFrom(upstream.state.serverPrefix, 'MODE', nick, '+' + Object.keys(upstream.state.userModes).join(''));
        }

        this.state.netRegistered = true;

        // If the client supports BOUNCER commands, it will request a buffer list
        // itself and then request messages as needed
        if (!this.state.caps.has('bouncer')) {
            await this.dumpChannels();
        }

        // If we previously set them away, now bring them back
        if (await upstream.state.tempGet('set_away')) {
            upstream.writeLine('AWAY');
            await upstream.state.tempSet('set_away', null);
        }

        await this.state.save();
        await hooks.emit('client_registered', {client: this});
    }

    async dumpChannels() {
        let upstream = this.upstream;

        // Dump all our joined channels..
        for (let chanName in upstream.state.buffers) {
            let channel = upstream.state.buffers[chanName];
            if (channel.isChannel && channel.joined) {
                await this.writeMsgFrom(this.state.nick, 'JOIN', channel.name);
                channel.topic && await this.writeMsg('TOPIC', channel.name, channel.topic);
                this.sendNames(channel);
            }
        }

        // Now the client has a channel list, send any messages we have for them
        for (let buffName in upstream.state.buffers) {
            let buffer = upstream.state.buffers[buffName];
            if (buffer.isChannel && !buffer.joined) {
                continue;
            }

            let messages = await this.messages.getMessagesBeforeTime(
                this.state.authUserId,
                this.state.authNetworkId,
                buffer.name,
                Date.now()
            );

            let supportsTime = this.state.caps.has('server-time');
            messages.forEach(async (msg) => {
                if (!supportsTime) {
                    msg.params[1] = `[${strftime('%H:%M:%S')}] ${msg.params[1]}`;
                }
                await this.writeMsg(msg);
            });
        }
    }

    sendNames(buffer) {
        let upstream = this.upstream;
        if (!upstream) {
            return;
        }

        let fullMask = this.state.caps.has('userhost-in-names');
        let multiPrefix = this.state.caps.has('multi-prefix');

        let names = [];
        for (let n in buffer.users) {
            let user = buffer.users[n];
            let mask = (fullMask && user.host) ?
                `${user.nick}!${user.username}@${user.host}` :
                user.nick;
            let prefix = multiPrefix ?
                user.prefixes.join('') :
                user.prefixes[0] || '';

            names.push(prefix + mask);
        }

        // NAMES replies include all the users on the same line. But if it goes over the 512 line
        // limit then we need to break it up into chunks

        let currentLine = '';
        // :irc.network.org 353 Guest25 @ #channel :@Guest25
        let args = ['353', this.state.nick, buffer.status, buffer.name];
        let len = args.reduce((prevVal, curVal) => prevVal + curVal.length, 0);
        len += 2 + upstream.state.serverPrefix.length; // 2 = the : before and space after
        len += args.length; // the spaces between the args
        while (names.length > 0) {
            let currentName = names.shift();
            if (len + currentLine.length + 1 + currentName.length > 512) {
                this.writeMsgFrom(upstream.state.serverPrefix, ...args.concat(currentLine));
                currentLine = '';
            }

            currentLine += currentLine.length > 0 ? ' ' + currentName : currentName;
        }

        if (currentLine) {
            this.writeMsgFrom(upstream.state.serverPrefix, ...args.concat(currentLine));
        }

        this.writeMsgFrom(upstream.state.serverPrefix, '366', this.state.nick, buffer.name, 'End of /NAMES list.');
    }

    // Handy helper to reach the hotReloadClientCommands() function
    reloadClientCommands() {
        hotReloadClientCommands();
    }

    async messageFromClient(message, raw) {
        await this.state.maybeLoad();
        let passUpstream = await ClientCommands.run(message, this);
        if (!passUpstream) {
            return;
        }

        if (this.upstream && this.upstream.state.connected) {
            this.upstream.write(raw + '\n');
        } else {
            l.debug('No connected upstream, not forwarding client data');
        }
    }

    async makeUpstream(network) {
        // May not be logged into a network
        if (!this.state.authNetworkId && !network) {
            return null;
        }

        if (!network) {
            network = await this.userDb.getNetwork(this.state.authNetworkId);
        }

        let con = this.upstream || new ConnectionOutgoing(null, this.db, this.messages, this.queue, this.conDict);
        con.state.authUserId = network.user_id;
        con.state.setNetwork(network);
        con.state.host = network.host;
        con.state.port = network.port;
        con.state.tls = network.tls;
        con.state.nick = network.nick || 'kiwibnc';
        con.state.username = network.username || network.nick || 'kiwibnc';
        con.state.realname = network.realname || network.nick || 'kiwibnc';
        con.state.password = network.password;
        con.state.sasl.account = network.sasl_account || '';
        con.state.sasl.password = network.sasl_pass || '';
        con.state.linkIncomingConnection(this.id);
        await con.state.save();

        con.open();

        return con;
    }

    async onAccepted() {
        await hooks.emit('new_client', {client: this});
    }

    async onClientClosed() {
        let upstream = this.upstream;
        if (upstream && upstream.state.netRegistered) {
            // If there are no other clients connected, mark this user as away
            let otherClients = [];
            upstream.forEachClient(c => otherClients.push(c), this);
            if (otherClients.length === 0) {
                upstream.writeLine('AWAY', 'away');
                await upstream.state.tempSet('set_away', true);
            }
        }

        await hooks.emit('client_disconnected', {client: this});
        this.destroy();
    }
}

// Split []tokens into batches that when joined with prefix and suffix, its length does not exceed maxLen
// eg. ['one', 'two', ...100 more tokens] = [['one', 'two'], [...more tokens]]
function batchIsupportTokensToMaxLenth(tokens, prefix, suffix='are supported by this server', maxLen=512) {
    // 1 = the extra space after the prefix
    let l = prefix.length + 1;
    // 1 = the : before the suffix
    l += suffix.length + 1;
    // 2 = the \r\n at the end of the line
    l += 2;

    let tokenLines = [];
    let currentLen = 0;

    for (let i = 0; i < tokens.length; i++) {
        let token = tokens[i];
        // If this token goes over maxLen, or exceeding 13 tokens, start a new line. (Or if we don't have a line yet)
        if (l + currentLen + token.length + 1 > maxLen || (i % 13) === 0 || tokenLines.length === 0) {
            tokenLines.push([]);
            currentLen = 0;
        }
        tokenLines[tokenLines.length - 1].push(token);
        // + 1 for the space after the token
        currentLen += token.length + 1;
    }

    return tokenLines;
}

module.exports = ConnectionIncoming;
