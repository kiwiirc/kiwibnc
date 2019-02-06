const EventEmitter = require('events');
const { ircLineParser } = require('irc-framework');
const { mParam, mParamU } = require('../libs/helpers');

let commands = Object.create(null);
let commandHooks = new EventEmitter();

module.exports.triggerHook = function triggerHook(hookName, event) {
    commandHooks.emit(hookName, event);
};

module.exports.run = async function run(msg, con) {
    let command = msg.command.toUpperCase();
    l('state:', [command, con.state.netRegistered, con.state.tempGet('capping'), con.state.tempGet('reg.state'), msg.source]);
    if (command === 'DEB' || command === 'RELOAD') {
        return await commands[command](msg, con);
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

        await commands[command](msg, con);
        await maybeProcessRegistration(con);

        return false;
    }

    if (commands[command]) {
        return await commands[command](msg, con);
    }

    // By default, send any unprocessed lines upstream
    return true;
};

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

    // Matching for user/network:pass or user:pass
    let m = regState.pass.match(/([^\/:]+)[:\/]([^:]+):?(.*)?/);
    if (!m) {
        con.writeMsg('ERROR', 'Invalid password');
        con.close();
        return false;
    }

    let username = m[1] || '';
    let networkName = m[2] || '';
    let password = m[3] || '';

    let network = await con.userDb.authUserNetwork(username, password, networkName);
    if (!network) {
        con.writeMsg('ERROR', 'Invalid password');
        con.close();
        return false;
    }

    con.state.authUserId = network.user_id;
    con.state.authNetworkId = network.id;
    await con.state.save();

    // If CAP is in negotiation phase, that will start the upstream when ready
    if (con.state.tempGet('capping')) {
        return;
    }

    if (!con.upstream) {
        con.makeUpstream(network);
        con.writeStatus('Connecting to the network..');
        // The upstream connection will call con.registerClient() when it's ready
    } else {
        con.writeStatus(`Attaching you to the network`);
        if (con.upstream.state.netRegistered) {
            await con.registerClient();
        }
    }

    await con.state.tempSet('reg.state', null);
}


/**
 * Tap into some hooks to modify messages and capabilities
 */

// Some caps to always request
commandHooks.on('available_caps', event => {
    event.caps.push('batch');
});

// server-time support
commandHooks.on('message_to_client', event => {
    let caps = event.client.state.caps;

    if (caps.includes('server-time')) {
        if (!event.message.tags['time']) {
            event.message.tags['time'] = strftime('%Y-%m-%dT%H:%M:%S.%LZ');
        }
    } else {
        delete event.message.tags['time'];
    }
});
commandHooks.on('available_caps', event => {
    let caps = event.caps.push('server-time');
});

// away-notify support
commandHooks.on('message_to_client', event => {
    if (!event.client.state.caps.includes('away-notify') && event.message.command === 'AWAY') {
        event.halt = true;
    }
});
commandHooks.on('available_caps', event => {
    event.caps.push('away-notify');
});

// account-notify support
commandHooks.on('message_to_client', event => {
    if (!event.client.state.caps.includes('account-notify') && event.message.command === 'ACCOUNT') {
        event.halt = true;
    }
});
commandHooks.on('available_caps', event => {
    event.caps.push('account-notify');
});

// extended-join
commandHooks.on('available_caps', event => {
    if (!event.client.upstream) {
        return;
    }

    // Only allow the client to use extended-join if upstream has it
    let upstream = event.client.upstream;
    if (upstream.state.caps.include('extended-join')) {
        event.caps.push('extended-join');
    }
});
commandHooks.on('message_to_client', event => {
    // :nick!user@host JOIN #channelname * :Real Name
    let caps = event.client.state.caps;
    let m = event.message;
    if (!caps.includes('extended-join') && m.command === 'JOIN' && m.params.length > 2) {
        // Drop the account name from the params (The * in the above example)
        m.params.splice(1, 1);
    }
});

// multi-prefix
commandHooks.on('available_caps', event => {
    event.caps.push('multi-prefix');
});
commandHooks.on('message_to_client', event => {
    let m = event.message;
    // Only listen for 353(NAMES) and 352(WHO) replies
    if (m.command !== '353' && m.command !== '352') {
        return;
    }

    if (!event.client.upstream) {
        return;
    }

    let clientCaps = event.client.state.caps;
    let upstreamCaps = event.client.upstream.state.caps;
    if (!clientCaps.includes('multi-prefix') && upstreamCaps.includes('multi-prefix')) {
        // Make sure only one prefix is included in the message before sending them to the client

        let prefixes = event.client.upstream.state.isupports.find(token => {
            return token.indexOf('PREFIX=') === 0;
        });

        // Convert "PREFIX=(qaohv)~&@%+" to "~&@%+"
        prefixes = (prefixes || '').split('=')[1] || '';
        prefixes = prefixes.substr(prefixes.indexOf(')') + 1);

        // :server.com 353 guest = #tethys :~&@%+aji &@Attila @+alyx +KindOne Argure
        if (m.command === '353') {
            // Only keep the first prefix for each user from the userlist
            let list = m.params[3].split(' ').map(item => {
                let itemPrefixes = '';
                let nick = '';
                for (let i = 0; i < item.length; i++) {
                    if (prefixes.indexOf(item[i]) > -1) {
                        itemPrefixes += item[i];
                    } else {
                        nick = item.substr(i + 1);
                        break;
                    }
                }

                return itemPrefixes[0] + nick;
            });

            m.params[3] = list.join(' ');
        }

        // :kenny.chatspike.net 352 guest #test grawity broken.symlink *.chatspike.net grawity H@%+ :0 Mantas M.
        if (m.command === '352') {
            let remapped = '';
            let status = m.params[6] || '';
            if (status[0] === 'H' || status[0] === 'A') {
                remapped += status[0];
                status = status.substr(1);
            }

            if (status[0] === '*') {
                remapped += status[0];
                status = status.substr(1);
            }

            if (status[0]) {
                remapped += status[0];
                status = status.substr(1);
            }

            m.params[6] = remapped;
        }
    }
});


/**
 * Commands sent from the client get handled here
 */

commands.CAP = async function(msg, con) {
    let availableCaps = [];
    commandHooks.emit('available_caps', {client: con, caps: availableCaps});

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
};

commands.PRIVMSG = async function(msg, con) {
    // Send this message to other connected clients
    con.upstream && con.upstream.forEachClient((client) => {
        client.writeMsgFrom(con.upstream.state.nick, 'PRIVMSG', msg.params[0], msg.params[1]);
    }, con);

    // PM to *bnc while logged in
    if (msg.params[0] === '*bnc' && con.state.authUserId) {
        let parts = (msg.params[1] || '').split(' ');
        let command = (parts[0] || '').toLowerCase();

        if (command === 'connect') {
            if (con.upstream) {
                con.writeStatus(`Already connected`);
            } else {
                con.makeUpstream();
            }
        }

        if (command === 'disconnect') {
            if (con.upstream) {
                con.upstream.close();
            } else {
                con.writeStatus(`Not connected`);
            }
        }

        if (command === 'listnetworks') {
            let nets = await con.db.all('SELECT * FROM user_networks WHERE user_id = ?', [
                con.state.authUserId
            ]);
            con.writeStatus(`${nets.length} network(s)`)
            nets.forEach((net) => {
                con.writeStatus(`Network: ${net.name} ${net.nick} ${net.host}:${net.tls?'+':''}${net.port}`);
            });
        }

        if (command === 'setpass') {
            let newPass = parts[1] || '';
            if (!newPass) {
                con.writeStatus('Usage: setpass <newpass>');
                return false;
            }

            try {
                await con.userDb.changeUserPassword(con.state.authUserId, newPass);
                con.writeStatus('New password set');
            } catch (err) {
                l('Error setting new password:', err.message);
                con.writeStatus('There was an error changing your password');
            }
        }

        if (command === 'status') {
            if (con.upstream && con.upstream.state.connected) {
                con.writeStatus('Connected to ' + con.upstream.state.host);
            } else {
                con.writeStatus('Not connected');
            }

            if (parts[1] === 'more' && con.upstream) {
                con.writeStatus('This ID: ' + con.id);
                con.writeStatus('Upstream ID: ' + con.upstream.id);
            }
        }

        return false;
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
        con.writeMsgFrom('bnc', 464, con.state.nick, 'Password required');
        con.writeFromBnc('NOTICE', con.state.nick, 'You must send your password first. /quote PASS <username>/<network>:<password>');

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

// TODO: Put these below commands behind a login or something
commands.KILL = async function(msg, con) {
    con.queue.stopListening().then(process.exit);
    return false;
};

commands.RELOAD = async function(msg, con) {
    con.reloadClientCommands();
    return false;
};

commands.DEB = async function(msg, con) {
    l('upstream id', con.upstream ? con.upstream.id : '<no upstream>');
    l('clients', con.upstream ? con.upstream.state.linkedIncomingConIds.size : '<no upstream>');
    l('this client registered?', con.state.netRegistered);
    l('tmp vars', con.state.tempData);
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
