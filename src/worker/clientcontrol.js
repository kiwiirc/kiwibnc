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

    if (typeof commands[command] === 'object') {
        let cmd = commands[command];
        if (cmd.requiresNetworkAuth && !con.state.authNetworkId) {
            con.writeStatus(`${command}: Not logged into a network`);
            return;
        }

        await cmd.fn(input, con, msg);

    } else if (typeof commands[command] === 'function') {
        await commands[command](input, con, msg);

    } else {
        con.writeStatus('Invalid command');
    }
};

commands.HELLO =
commands.HEY =
commands.HI = 
commands.HOLA = {
    requiresNetworkAuth: false,
    fn: async function(input, con, msg) {
        con.writeStatus(`Hello!`);
    },
};

commands.CONNECT = {
    requiresNetworkAuth: true,
    fn: async function(input, con, msg) {
        if (con.upstream && con.upstream.state.connected) {
            con.writeStatus(`Already connected`);
        } else {
            con.makeUpstream();
        }
    },
};

commands.DISCONNECT = {
    requiresNetworkAuth: true,
    fn: async function(input, con, msg) {
        if (con.upstream && con.upstream.state.connected) {
            con.upstream.close();
        } else {
            con.writeStatus(`Not connected`);
        }
    },
};

commands.LISTCLIENTS = {
    requiresNetworkAuth: true,
    fn: async function(input, con, msg) {
        let entries = [];
        if (con.upstream) {
            con.upstream.forEachClient(client => {
                entries.push(`Client: ${client.state.host}`);
            });
        }

        con.writeStatus(`${entries.length} client(s) connected`);
        entries.forEach(e => con.writeStatus(e));
    },
};

commands.LISTNETWORKS = async function(input, con, msg) {
    let nets = await con.userDb.getUserNetworks(con.state.authUserId);
    con.writeStatus(`${nets.length} network(s)`)
    nets.forEach((net) => {
        con.writeStatus(`Network: ${net.name} ${net.nick} ${net.host}:${net.tls?'+':''}${net.port}`);
    });
};

commands.CHANGENETWORK = {
    requiresNetworkAuth: true,
    fn: async function(input, con, msg) {
        // changenetwork host=irc.freenode.net port=6667 tls=1

        let toUpdate = {};
        let columnMap = {
            name: 'name',
            host: 'host',
            server: 'host',
            address: 'host',
            port: {column: 'port', type: 'number'},
            tls: {column: 'tls', type: 'bool'},
            ssl: {column: 'tls', type: 'bool'},
            secure: {column: 'tls', type: 'bool'},
            nick: 'nick',
            username: 'username',
            realname: 'realname',
            real: 'realname',
            password: 'password',
            pass: 'password',
        };

        input.split(' ').forEach(part => {
            let pos = part.indexOf('=');
            if (pos === -1) {
                pos = part.length;
            }
        
            let field = part.substr(0, pos).toLowerCase();
            let val = part.substr(pos + 1);

            if (!columnMap[field]) {
                return;
            }

            let column = '';
            let type = 'string';

            if (typeof columnMap[field] === 'string') {
                column = columnMap[field];
                type = 'string';
            } else {
                column = columnMap[field].column;
                type = columnMap[field].type || 'string';
            }

            if (type === 'string') {
                toUpdate[column] = val;
            } else if(type === 'bool') {
                toUpdate[column] = ['0', 'no', 'off', 'false'].indexOf(val.toLowerCase()) > -1 ?
                    false :
                    true;
            } else if(type === 'number') {
                let num = parseInt(val, 10);
                if (isNaN(num)) {
                    num = 0;
                }

                toUpdate[column] = num;
            }
        });

        if (Object.keys(toUpdate).length > 0) {
            await con.db.db('user_networks')
                .where('user_id', con.state.authUserId)
                .where('id', con.state.authNetworkId)
                .update(toUpdate);
            
            con.writeStatus(`Updated network`);
        } else {
            con.writeStatus(`Syntax: changenetwork server=irc.example.net port=6667 tls=yes`);
            con.writeStatus(`Available fields: name, server, port, tls, nick, username, realname, password`);
        }
    },
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
    } else if (!con.state.authNetworkId) {
        con.writeStatus(`Not logged into a network`);
    } else {
        con.writeStatus('Not connected');
    }

    if (parts[0] === 'more' && con.upstream) {
        con.writeStatus('This ID: ' + con.id);
        con.writeStatus('Upstream ID: ' + con.upstream.id);
    }
};
