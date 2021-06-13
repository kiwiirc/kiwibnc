const { ircLineParser, Message } = require('irc-framework');
const { mParam, mParamU, cloneIrcMessage } = require('../libs/helpers');
const msgIdGenerator = require('../libs/msgIdGenerator');
const ClientControl = require('./clientcontrol');
const hooks = require('./hooks');

let commands = Object.create(null);

module.exports.run = async function run(msg, con) {
    let command = msg.command.toUpperCase();
    l.debug('run() state:', [command, con.state.netRegistered, con.state.tempGet('capping'), con.state.tempGet('reg.state'), msg.source, con.state.nick]);
    if (command === 'DEB' || command === 'RELOAD' || command === 'PING') {
        return await runCommand(command, msg, con);
    }

    // If we're in the CAP negotiating phase, don't allow any other commands to be processed yet.
    // Once CAP negotiations have ended, this queue will be run through.
    // If msg.source === queue, the message is being processed from the queue and should not be re-queued.
    if (con.state.tempGet('capping') && command !== 'CAP' && msg.source !== 'queue') {
        let messageQueue = con.state.tempGet('reg.queue') || [];
        messageQueue.push(msg.to1459());
        await con.state.tempSet('reg.queue', messageQueue);
        return false;
    }

    // We're done capping, but not yet registered. Process registration commands
    if (!con.state.netRegistered) {
        // Only allow a subset of commands to be accepted at this point
        let preRegisterCommands = ['USER', 'NICK', 'PASS', 'CAP'];
        if (preRegisterCommands.indexOf(command) === -1) {
            return false;
        }

        let regState = con.state.tempGet('reg.state');
        if (!regState) {
            regState = {nick: '', user: '', pass: ''};
            await con.state.tempSet('reg.state', regState);
        }

        await runCommand(command, msg, con);
        await maybeProcessRegistration(con);

        return false;
    }

    return await runCommand(command, msg, con);
};

async function runCommand(command, msg, con) {
    let hook = await hooks.emit('message_from_client', {client: con, message: msg, passthru: true});
    if (hook.prevent) {
        return hook.event.passthru;
    }

    if (commands[command]) {
        return commands[command](msg, con);
    }

    // By default, send any unprocessed lines upstream
    return true;
}

async function maybeProcessRegistration(con) {
    // We can only register the client once we have all the info and CAP has ended
    let regState = con.state.tempGet('reg.state');
    if (
        !regState.nick ||
        !regState.user ||
        !regState.pass ||
        con.state.tempGet('capping')
    ) {
        return;
    }

    // get bnc username and password
    let username = '';
    let clientid = 'bnc';
    let networkName = '';
    let password = '';
    let network = null;

    let m = regState.pass.match(/^(?<username>[^\/:@]+)(?:@(?<clientid>[a-z0-9]+))?(?:\/(?<network>[^:]*))?(?::(?<password>.*))?$/);
    let mu = regState.user.match(/^(?<username>[^\/:@]+)(?:@(?<clientid>[a-z0-9]+))?(?:\/(?<network>.+))?$/);
    if (m && regState.pass.includes(':')) {
        // PASS user/network:pass or user/:pass or user:pass or user@clientid:pass etc
        username = m.groups.username || '';
        clientid = m.groups.clientid || '';
        networkName = m.groups.network || '';
        password = m.groups.password || '';
    } else if (mu && regState.pass) {
        // PASS pass
        // USER user/network or user or user@clientid
        username = mu.groups.username || '';
        clientid = mu.groups.clientid || '';
        networkName = mu.groups.network || '';
        password = regState.pass || '';
    } else {
        await con.writeMsg('ERROR', 'Invalid password');
        con.close();
        return false;
    }

    let hook = await hooks.emit('auth', {username, clientid, networkName, password, client: con, userId: null, network: null, isAdmin: false});
    if (hook.prevent) {
        return false;
    }

    // Parts of the BNC may depend on the clientid as it's configuring itself, so make sure that's
    // set correctly before anything else. Defaulting to bnc
    con.state.clientid = hook.event.clientid || 'bnc';

    if (hook.event.userId) {
        // An extension has authed the user
        con.state.authUserId = hook.event.userId;
        con.state.authAdmin = !!hook.event.isAdmin;

        if (hook.event.network) {
            con.state.setNetwork(hook.event.network);
            network = hook.event.network;
        } else if (networkName) {
            // Extension authed the user but left the network to us
            network = await con.userDb.getNetworkByName(hook.event.userId, networkName);
            if (network) {
                con.state.setNetwork(network);
            }
        }

    } else if (con.state.authUserId && con.state.authNetworkId) {
        // User has already logged in to a network
        network = await con.userDb.getNetwork(con.state.authNetworkId);

    } else if (networkName) {
        // Logging into a network
        let auth = await con.userDb.authUserNetwork(username, password, networkName);
        if (!auth.network) {
            await con.writeMsg('ERROR', 'Invalid password');
            con.close();
            return false;
        }

        network = auth.network;
        con.state.setNetwork(network);
        con.state.authUserId = network.user_id;
        con.state.authAdmin = auth.user && !!auth.user.admin;
    } else {
        // Logging into a user only mode (no attached network)
        let user = await con.userDb.authUser(username, password, con.state.host);
        if (!user) {
            await con.writeMsg('ERROR', 'Invalid password');
            con.close();
            return false;
        }

        con.state.authUserId = user.id;
        con.state.authAdmin = !!user.admin;
    }

    await con.state.save();

    // If after all the authing above we had a network name but couldn't find a network instance
    // to attach to, fail here
    if (networkName && !network) {
        await con.writeMsg('ERROR', 'Network not found');
        con.close();
        return false;
    }

    // If CAP is in negotiation phase, that will start the upstream when ready
    if (con.state.tempGet('capping')) {
        return;
    }

    if (network) {
        if (!con.upstream) {
            con.makeUpstream(network);
            con.writeStatus('Connecting to the network...');
        } else if (!con.upstream.state.connected) {
            // The upstream connection will call con.registerClient() once it's registered
            con.writeStatus('Waiting for the network to connect...');
            con.upstream.open();
        } else {
            if (con.upstream.state.receivedMotd) {
                await con.registerClient();
            }
        }
    } else {
        con.writeStatus('Welcome to your BNC!');
        await con.registerLocalClient();
    }

    await con.state.tempSet('reg.state', null);
}


/**
 * Commands sent from the client get handled here
 */

commands.CAP = async function(msg, con) {
    let availableCaps = new Set();
    await hooks.emit('available_caps', {client: con, caps: availableCaps});

    if (mParamU(msg, 0, '') === 'LIST') {
        con.writeFromBnc('CAP', '*', 'LIST', Array.from(con.state.caps).join(' '));
    }

    if (mParamU(msg, 0, '') === 'LS') {
        // Record the version of CAP the client is using
        let currentVer = con.state.tempGet('capver') || 301;
        let newVer = parseInt(mParamU(msg, 1, '301'), 10);
        if (!isNaN(newVer) && newVer > currentVer) {
            await con.state.tempSet('capver', newVer);
        }

        await con.state.tempSet('capping', true);
        con.writeFromBnc('CAP', '*', 'LS', Array.from(availableCaps).join(' '));
    }

    if (mParamU(msg, 0, '') === 'REQ') {
        let requested = mParam(msg, 1, '').split(' ');
        let matched = requested.filter((cap) => availableCaps.has(cap));
        con.state.caps = new Set([...con.state.caps, ...matched]);
        await con.state.save();
        con.writeFromBnc('CAP', '*', 'ACK', matched.join(' '));
    }

    if (mParamU(msg, 0, '') === 'END') {
        await processConQueue(con);
        await con.state.tempSet('capping', null);
    }

    return false;
};

commands.PASS = async function(msg, con) {
    // PASS is only accepted if we haven't logged in already
    if (con.state.authUserId) {
        return false;
    }

    let regState = con.state.tempGet('reg.state');
    regState.pass = mParam(msg, 0, '');
    await con.state.tempSet('reg.state', regState);

    return false;
};

commands.USER = async function(msg, con) {
    let regState = con.state.tempGet('reg.state');
    if (regState) {
        regState.user = mParam(msg, 0, '');
        await con.state.tempSet('reg.state', regState);
    }

    // Never send USER upstream
    return false;
};

commands.NOTICE = async function(msg, con) {
    let msgId = msgIdGenerator.generateId();

    // Send this message to other connected clients
    con.upstream && con.upstream.forEachClient((client) => {
        let m = new Message('NOTICE', msg.params[0], msg.params[1]);
        m.prefix = con.upstream.state.nick;
        m.tags.msgid = msgId;
        m.source = 'client';
        client.writeMsg(m);
    }, con);

    if (con.upstream && con.upstream.state.logging && con.upstream.state.netRegistered) {
        // Add a msgid tag to the message before it's stored. We don't add it to the original
        // message because we don't want it being sent upstream.
        // TODO: If labeled-response+msgid+echo-message is enabled upstream, dont store the message
        let m = cloneIrcMessage(msg);
        m.tags.msgid = msgId;
        await con.messages.storeMessage(m, con.upstream, con);
    }

    return true;
};

commands.PRIVMSG = async function(msg, con) {
    let msgId = msgIdGenerator.generateId();

    // Send this message to other connected clients
    con.upstream && con.upstream.forEachClient((client) => {
        let m = new Message('PRIVMSG', msg.params[0], msg.params[1]);
        m.prefix = con.upstream.state.nick;
        m.tags.msgid = msgId;
        m.source = 'client';
        client.writeMsg(m);
    }, con);

    // PM to *bnc while logged in
    if (msg.params[0] === '*bnc' && con.state.authUserId) {
        await ClientControl.run(msg, con);
        return false;
    }

    if (con.upstream && con.upstream.state.logging && con.upstream.state.netRegistered) {
        // Add a msgid tag to the message before it's stored. We don't add it to the original
        // message because we don't want it being sent upstream.
        // TODO: If labeled-response+msgid+echo-message is enabled upstream, dont store the message
        let m = cloneIrcMessage(msg);
        m.tags.msgid = msgId;
        await con.messages.storeMessage(m, con.upstream, con);
    }

    return true;
};

commands.NICK = async function(msg, con) {
    if (con.upstream && !con.upstream.state.netRegistered) {
        // We only want to pass a NICK upstream if we're done registered to the
        // network otherwise it may interfere with any ongoing registration
        return;
    }

    // If this client hasn't registered itself to the BNC yet, don't send it's nick upstream as
    // we will make use of it ourselves first
    if (!con.state.netRegistered) {
        con.state.nick = msg.params[0];
        con.state.save();
        con.writeMsgFrom(con.state.nick, 'NICK', con.state.nick);

        let regState = con.state.tempGet('reg.state');
        if (regState) {
            regState.nick = mParam(msg, 0, '');
            await con.state.tempSet('reg.state', regState);
        }

        // A quick reminder for the client that they need to send a password
        if (!regState.pass) {
            con.writeMsgFrom('bnc', 464, con.state.nick, 'Password required');
            con.writeFromBnc('NOTICE', con.state.nick, 'You must send your password first. /quote PASS <username>/<network>:<password>');
        }

        return false;
    }

    return true;
};

commands.NAMES = async function(msg, con) {
    let bufferName = msg.params[0] || '';
    let upstream = con.upstream;

    if (!bufferName) {
        // Send a raw NAMES command upstream to get the IRCds response
        return true;
    }

    if (!con.upstream || !con.upstream.state.netRegistered) {
        con.writeFromBnc('366', con.state.nick, bufferName, 'End of /NAMES list.');
        return false;
    }

    let buffer = upstream.state.getBuffer(bufferName);
    if (!buffer) {
        con.writeFromBnc('366', upstream.state.nick, bufferName, 'End of /NAMES list.');
        return false;
    }

    con.sendNames(buffer);
    return false;
};

commands.PART = async function(msg, con) {
    if (!con.upstream) {
        return;
    }

    let buffer = con.upstream.state.getBuffer(msg.params[0]);
    if (buffer) {
        buffer.partReceived = true;
    }

    return true;
}

commands.PING = async function(msg, con) {
    con.writeFromBnc('PONG', '*bnc', msg.params[0]);
    return false;
};

commands.QUIT = async function(msg, con) {
    // Some clients send a QUIT when they close, don't send that upstream
    con.close();
    return false;
};

commands.DEB = async function(msg, con) {
    l.info('upstream id', con.upstream ? con.upstream.id : '<no upstream>');
    l.info('clients', con.upstream ? con.upstream.state.linkedIncomingConIds.size : '<no upstream>');
    l.info('this client registered?', con.state.netRegistered);
    l.info('tmp vars', con.state.tempData);
    l.info('buffers', con.upstream ? con.upstream.state.buffers : '<no upstream>');

    if (Object.keys(con.state.buffers).length === 0) {
        l.info('No buffers');
    }

    for (let buffName in con.state.buffers) {
        let b = con.state.buffers[buffName];
        l.info('Buffer: ' + b.name + ' joined: ' + (b.joined ? 'yes' : 'no'));
    }

    return false;
};


async function processConQueue(con) {
    // Process any messages that came in before we got its PASS
    let messageQueue = con.state.tempGet('reg.queue') || [];
    while (messageQueue.length > 0) {
        let line = messageQueue.shift();
        await con.state.tempSet('reg.queue', messageQueue);

        let msg = ircLineParser(line);
        if (!line || !msg) {
            continue;
        }

        // Indicate that this message is from the queue, and therefore should not be re-queued
        msg.source = 'queue';
        await module.exports.run(msg, con);

        // Update our list incase any messages has come in since we started processing it
        messageQueue = con.state.tempGet('reg.queue') || [];
    }

    await con.state.tempSet('reg.queue', null);
}
