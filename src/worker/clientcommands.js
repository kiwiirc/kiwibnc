const { ircLineParser } = require('irc-framework');
const { mParam, mParamU } = require('../libs/helpers');
const ClientControl = require('./clientcontrol');
const hooks = require('./hooks');

let commands = Object.create(null);

module.exports.run = async function run(msg, con) {
    let command = msg.command.toUpperCase();
    l.debug('run() state:', [command, con.state.netRegistered, con.state.tempGet('capping'), con.state.tempGet('reg.state'), msg.source]);
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
    let networkName = '';
    let password = '';
    let network = null;

    let m = regState.pass.match(/([^\/:]+)(?:\/([^:]+))?(?::(.*))?/);
    let mu = regState.user.match(/([^\/]+)(?:\/(.+))?/);
    if (m && regState.pass.includes(':')) {
        // PASS user/network:pass or user:pass
        username = m[1] || '';
        networkName = m[2] || '';
        password = m[3] || '';
    } else if (mu && regState.pass) {
        // PASS pass
        // USER user/network or user
        username = mu[1] || '';
        networkName = mu[2] || '';
        password = regState.pass || '';
    } else {
        await con.writeMsg('ERROR', 'Invalid password');
        con.close();
        return false;
    }

    let hook = await hooks.emit('auth', {username, networkName, password, client: con, userId: null, network: null, isAdmin: false});
    if (hook.prevent) {
        return false;
    }

    if (hook.event.userId) {
        // An extension has authed the user
        con.state.authUserId = hook.event.userId;
        con.state.authAdmin = !!hook.event.isAdmin;

        if (hook.event.network) {
            con.state.authNetworkId = hook.event.network.id;
            network = hook.event.network;
        }

    } else if (networkName) {
        // Logging into a network
        let auth = await con.userDb.authUserNetwork(username, password, networkName);
        if (!auth.network) {
            await con.writeMsg('ERROR', 'Invalid password');
            con.close();
            return false;
        }

        network = auth.network;
        con.state.authUserId = network.user_id;
        con.state.authNetworkId = network.id;
        con.state.authAdmin = auth.user && !!auth.user.admin;
    } else {
        // Logging into a user only mode (no attached network)
        let user = await con.userDb.authUser(username, password);
        if (!user) {
            await con.writeMsg('ERROR', 'Invalid password');
            con.close();
            return false;
        }

        con.state.authUserId = user.id;
        con.state.authAdmin = !!user.admin;
    }

    await con.state.save();

    // If CAP is in negotiation phase, that will start the upstream when ready
    if (con.state.tempGet('capping')) {
        return;
    }

    if (network) {
        if (!con.upstream) {
            con.makeUpstream(network);
            con.writeStatus('Connecting to the network..');
        } else if (!con.upstream.state.connected) {
            // The upstream connection will call con.registerClient() once it's registered
            con.writeStatus('Connecting to the network..');
            con.upstream.open();
        } else {
            con.writeStatus(`Attaching you to the network`);
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
    let availableCaps = [];
    await hooks.emit('available_caps', {client: con, caps: availableCaps});

    if (mParamU(msg, 0, '') === 'LIST') {
        con.writeMsg('CAP', '*', 'LIST', con.state.caps.join(' '));
    }

    if (mParamU(msg, 0, '') === 'LS') {
        // Record the version of CAP the client is using
        await con.state.tempSet('capping', mParamU(msg, 1, '301'));
        con.writeMsg('CAP', '*', 'LS', availableCaps.join(' '));
    }

    if (mParamU(msg, 0, '') === 'REQ') {
        let requested = mParam(msg, 1, '').split(' ');
        let matched = requested.filter((cap) => availableCaps.includes(cap));
        con.state.caps = con.state.caps.concat(matched);
        await con.state.save();
        con.writeMsg('CAP', '*', 'ACK', matched.join(' '));
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
    // Send this message to other connected clients
    con.upstream && con.upstream.forEachClient((client) => {
        client.writeMsgFrom(con.upstream.state.nick, 'NOTICE', msg.params[0], msg.params[1]);
    }, con);

    if (con.upstream && con.upstream.state.logging) {
        await con.messages.storeMessage(
            con.upstream.state.authUserId,
            con.upstream.state.authNetworkId,
            msg,
            con.upstream.state
        );
    }
};

commands.PRIVMSG = async function(msg, con) {
    // Send this message to other connected clients
    con.upstream && con.upstream.forEachClient((client) => {
        client.writeMsgFrom(con.upstream.state.nick, 'PRIVMSG', msg.params[0], msg.params[1]);
    }, con);

    // PM to *bnc while logged in
    if (msg.params[0] === '*bnc' && con.state.authUserId) {
        await ClientControl.run(msg, con);
        return false;
    }

    if (con.upstream && con.upstream.state.logging) {
        await con.messages.storeMessage(
            con.upstream.state.authUserId,
            con.upstream.state.authNetworkId,
            msg,
            con.upstream.state
        );
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

commands.PING = async function(msg, con) {
    con.writeMsg('PONG', msg.params[0]);
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
