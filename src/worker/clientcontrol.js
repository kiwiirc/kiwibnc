let commands = Object.create(null);

// Process a message sent to *bnc to control the users account and the bnc itself
module.exports.run = async function(msg, con) {
    let input = (msg.params[1] || '');
    let pos = input.indexOf(' ');
    if (pos === -1) {
        pos = input.length;
    }

    // Take the first word as the command, the rest of the message as-is
    let command = input.substr(0, pos).toUpperCase();
    input = input.substr(pos + 1);

    if (commands[command]) {
        await commands[command](input, con, msg);
    } else {
        con.writeStatus('Invalid command');
    }
};

commands.CONNECT = async function(input, con, msg) {
    if (con.upstream) {
        con.writeStatus(`Already connected`);
    } else {
        con.makeUpstream();
    }
}

commands.DISCONNECT = async function(input, con, msg) {
    if (con.upstream) {
        con.upstream.close();
    } else {
        con.writeStatus(`Not connected`);
    }
};

commands.LISTNETWORKS = async function(input, con, msg) {
    let nets = await con.db.all('SELECT * FROM user_networks WHERE user_id = ?', [
        con.state.authUserId
    ]);
    con.writeStatus(`${nets.length} network(s)`)
    nets.forEach((net) => {
        con.writeStatus(`Network: ${net.name} ${net.nick} ${net.host}:${net.tls?'+':''}${net.port}`);
    });
};

commands.SETPASS = async function(input, con, msg) {
    let parts = input.split(' ');
    let newPass = parts[0] || '';
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
};

commands.STATUS = async function(input, con, msg) {
    let parts = input.split(' ');
    if (con.upstream && con.upstream.state.connected) {
        con.writeStatus('Connected to ' + con.upstream.state.host);
    } else {
        con.writeStatus('Not connected');
    }

    if (parts[0] === 'more' && con.upstream) {
        con.writeStatus('This ID: ' + con.id);
        con.writeStatus('Upstream ID: ' + con.upstream.id);
    }
};
