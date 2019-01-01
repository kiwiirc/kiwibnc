let commands = Object.create(null);

module.exports.run = async function run(msg, con) {
    let command = msg.command.toUpperCase();

    // No commands are allowed to be run before PASS has authed us in
    if (!con.state.netRegistered && command !== 'PASS') {
        con.write(`:*!bnc@bnc 464 ${con.state.nick} :Password required\n`);
        con.writeStatus('You must send your password first. /quote PASS <username>/<network>:<password>');
        return false;
    }

    if (commands[command]) {
        return await commands[command](msg, con);
    }

    // By default, send any unprocessed lines upstream
    return true;
};

commands.CAP = async function(msg, con) {
    // Purposely disable CAP commands for now
    // TODO: Implement this
    return false;
};

commands.PASS = async function(msg, con) {
    // PASS is only accepted if we haven't logged in already
    if (con.state.authUserId) {
        return;
    }

    // Matching for user/network:pass or user:pass
    let m = (msg.params[0] || '').match(/([^\/:]+)[:\/]([^:]+):?(.*)?/);
    if (!m) {
        con.write('ERROR :Invalid password\n');
        return;
    }

    let username = m[1] || '';
    let networkName = m[2] || '';
    let password = m[3] || '';

    let network = await con.userDb.authUserNetwork(username, password, networkName);
    if (!network) {
        con.write('ERROR :Invalid password\n');
        return;
    }

    con.state.authUserId = network.user_id;
    con.state.authNetworkId = network.id;
    await con.state.save();

    if (!con.upstream) {
        con.makeUpstream(network);
        // TODO: Hook into upstream registration so that we can call registerClient() after
    } else {
        con.writeStatus(`Attaching you to the network`);
        if (con.upstream.state.netRegistered) {
            await con.registerClient();
        }
    }

    return false;
};

commands.PRIVMSG = async function(msg, con) {
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
    if (con.upstream && con.upstream.state.netRegistered) {
        // We only want to pass a NICK upstream if we're registered to the
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

// TODO: Put these below commands behind a login or something
commands.KILL = async function(msg, con) {
    con.queue.stopListening().then(process.exit);
    return false;
};

commands.RELOAD = async function(msg, con) {
    con.reloadClientCommands();
    return false;
};
