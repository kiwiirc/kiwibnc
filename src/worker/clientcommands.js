const { ircLineParser } = require('irc-framework');

let commands = Object.create(null);

function mParam(msg, idx, def) {
    return msg.params[idx] || def;
}
function mParamU(msg, idx, def) {
    return (mParam(msg, idx, def) || '').toUpperCase();
}

module.exports.run = async function run(msg, con) {
    let command = msg.command.toUpperCase();

    // If we're in the CAP negotiating phase, don't allow any other commands to be processed yet.
    // Once CAP negotiations have ended, this queue will be run through.
    // If msg.source === queue, the message is being processed from the queue and should not be re-queued.
    if (con.state.tempGet('capping') && command !== 'CAP' && msg.source !== 'queue') {
        let messageQueue = con.state.tempGet('capping.queue') || [];
        messageQueue.push(msg.to1459());
        con.state.tempSet('capping.queue', messageQueue);
        return;
    }

    // Before this connection is authed, only reply to NICK commands explaining that a pass is needed
    if (!con.state.netRegistered && command === 'NICK') {
        con.write(`:bnc 464 ${con.state.nick} :Password required\n`);
        con.writeFromBnc('NOTICE', con.state.nick, 'You must send your password first. /quote PASS <username>/<network>:<password>');
        return false;
    }

    // If we're not authed, only accept PASS commands
    if (!con.state.netRegistered && (command !== 'PASS' && command !== 'CAP')) {
        return false;
    }

    if (commands[command]) {
        return await commands[command](msg, con);
    }

    // By default, send any unprocessed lines upstream
    return true;
};

commands.CAP = async function(msg, con) {
    let availableCaps = ['server-time', 'batch'];

    if (mParamU(msg, 0, '') === 'LIST') {
        con.writeLine('CAP', '*', 'LIST', con.state.caps.join(' '));
    }

    if (mParamU(msg, 0, '') === 'LS') {
        con.state.tempSet('capping', true);
        con.writeLine('CAP', '*', 'LS', availableCaps.join(' '));
    }

    if (mParamU(msg, 0, '') === 'REQ') {
        let requested = mParam(msg, 1, '').split(' ');
        let matched = requested.filter((cap) => availableCaps.includes(cap));
        con.state.caps = con.state.caps.concat(matched);
        await con.state.save();
        con.writeLine('CAP', '*', 'ACK', matched.join(' '));
    }

    if (mParamU(msg, 0, '') === 'END') {
        // Process any messages that came in during the CAP negotiation phase
        let messageQueue = con.state.tempGet('capping.queue') || [];
        while (messageQueue.length > 0) {
            let line = messageQueue.shift();
            con.state.tempSet('capping.queue', messageQueue);

            let msg = ircLineParser(line);
            if (!line || !msg) {
                continue;
            }

            // Indicate that this message is from the queue, and therefore should not be re-queued
            msg.source = 'queue';
            await module.exports.run(msg, con);

            // Update our list incase any messages has come in since we started processing it
            messageQueue = con.state.tempGet('capping.queue') || [];
        }

        con.state.tempSet('capping', null);
        con.state.tempSet('capping.queue', null);
    }

    return false;
};

commands.PASS = async function(msg, con) {
    // PASS is only accepted if we haven't logged in already
    if (con.state.authUserId) {
        return false;
    }

    // Matching for user/network:pass or user:pass
    let m = (msg.params[0] || '').match(/([^\/:]+)[:\/]([^:]+):?(.*)?/);
    if (!m) {
        con.write('ERROR :Invalid password\n');
        con.close();
        return false;
    }

    let username = m[1] || '';
    let networkName = m[2] || '';
    let password = m[3] || '';

    let network = await con.userDb.authUserNetwork(username, password, networkName);
    if (!network) {
        con.write('ERROR :Invalid password\n');
        con.close();
        return false;
    }

    con.state.authUserId = network.user_id;
    con.state.authNetworkId = network.id;
    await con.state.save();

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

    return false;
};

commands.NOTICE = async function(msg, con) {
    // Send this message to other connected clients
    con.upstream && con.upstream.forEachClient((client) => {
        client.writeLine(`:${con.upstream.state.nick}`, 'NOTICE', msg.params[0], msg.params[1]);
    }, con);
};

commands.PRIVMSG = async function(msg, con) {
    // Send this message to other connected clients
    con.upstream && con.upstream.forEachClient((client) => {
        client.writeLine(`:${con.upstream.state.nick}`, 'PRIVMSG', msg.params[0], msg.params[1]);
    }, con);

    // PM to * while logged in
    if (msg.params[0] === '*' && con.state.authUserId) {
        let parts = (msg.params[1] || '').split(' ');
        let command = (parts[0] || '').toLowerCase();

        if (command === 'connect') {
            if (con.upstream) {
                con.writeStatus(`Already connected`);
            } else {
                con.makeUpstream();
            }
        }

        if (command === 'listnetworks') {
            let nets = await con.db.all('SELECT * FROM user_networks WHERE user_id = ?', [
                con.state.authUserId
            ]);
            con.writeStatus(`${nets.length} networks`)
            nets.forEach((net) => {
                con.writeStatus(`Network: ${net.name} ${net.nick} ${net.host}:${net.tls?'+':''}${net.port}`);
            });
        }

        if (command === 'setpass') {
            let newPass = parts[1] || '';
            if (!newPass) {
                con.writeStatus('Usage: setpass <newpass>');
                return;
            }

            try {
                await con.userDb.changeUserPassword(con.state.authUserId, newPass);
                con.writeStatus('New password set');
            } catch (err) {
                l('Error setting new password:', err.message);
                con.writeStatus('There was an error changing your password');
            }
        }
    }
};

commands.NICK = async function(msg, con) {
    if (con.upstream && !con.upstream.state.netRegistered) {
        // We only want to pass a NICK upstream if we're done registered to the
        // network otherwise it may interfere with any ongoing registration
        return;
    }

    con.state.nick = msg.params[0];
    con.state.save();
    con.write(`:${con.state.nick} NICK ${con.state.nick}\n`);

    return false;
};

commands.PING = async function(msg, con) {
    con.write('PONG :' + msg.params[0] + '\n');
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
