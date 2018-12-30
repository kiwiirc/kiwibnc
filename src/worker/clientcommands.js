let commands = Object.create(null);

module.exports.run = async function run(msg, con) {
    let command = msg.command.toUpperCase();
    commands[command] && await commands[command](msg, con);
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
    } else {
        con.writeStatus(`Attaching you to the network`);
    }
};

commands.PRIVMSG = async function(msg, con) {
    // PM to * while logged in
    if (msg.params[0] === '*' && con.state.authUserId) {
        let command = (msg.params[1] || '').toLowerCase();
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
    }
};

commands.NICK = async function(msg, con) {
    con.state.nick = msg.params[0];
    con.state.save();
    con.write(`:${con.state.nick} NICK ${con.state.nick}\n`);
};

commands.PING = async function(msg, con) {
    con.write('PONG :' + msg.params[0] + '\n');
};

// TODO: Put these below commands behind a login or something
commands.KILL = async function(msg, con) {
    con.queue.stopListening().then(process.exit);
};

commands.RELOAD = async function(msg, con) {
    con.reloadClientCommands();
};
