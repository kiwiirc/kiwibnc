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

    if (command === '') {
        command = 'HELP';
    }

    if (typeof commands[command] === 'object') {
        let cmd = commands[command];
        if (cmd.requiresNetworkAuth && !con.state.authNetworkId) {
            con.writeStatus(`${command}: Not logged into a network`);
            return;
        }

        if (cmd.requiresAdmin && !con.state.authAdmin) {
            con.writeStatus(`${command}: This is an administrative command`);
            return;
        }

        await cmd.fn(input, con, msg);

    } else if (typeof commands[command] === 'function') {
        await commands[command](input, con, msg);

    } else {
        con.writeStatus(`Invalid command (${command})`);
    }
};

commands.HELP = {
    requiresNetworkAuth: false,
    fn: async function(input, con, msg) {
        con.writeStatus(`Here are the supported commands:`);
        con.writeStatus(Object.keys(commands).sort().join(' '));
    },
};

commands.HELLO =
commands.HEY =
commands.HI = 
commands.OLA = 
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
        let netCon = con.conDict.findUsersOutgoingConnection(
            con.state.authUserId,
            con.state.authNetworkId,
        );
        let activeNick = netCon ?
            netCon.state.nick :
            net.nick;
        let connected = netCon && netCon.state.connected ?
            'Yes' :
            'No';
        let info = [
            `Network: ${net.name} (${net.host}:${net.tls?'+':''}${net.port})`,
            `Active nick: ${activeNick}`,
            `Connected? ${connected}`,
        ];
        con.writeStatus(info.join('. '));
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
            account: 'sasl_account',
            account_pass: 'sasl_pass',
            account_password: 'sasl_pass',
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
            let network = await con.userDb.getNetwork(con.state.authNetworkId);
            for (let prop in toUpdate) {
                network[prop] = toUpdate[prop];
            }
            await network.save();
            
            con.writeStatus(`Updated network`);
        } else {
            con.writeStatus(`Usage: changenetwork server=irc.example.net port=6697 tls=yes`);
            con.writeStatus(`Available fields: name, server, port, tls, nick, username, realname, password, account, account_password`);
        }
    },
};

commands.ADDNETWORK = {
    requiresNetworkAuth: false,
    fn: async function(input, con, msg) {
        // addnetwork host=irc.freenode.net port=6667 tls=1

        let toUpdate = {
            port: 6697,
            tls: true,
            nick: 'bncuser',
        };

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
            account: 'sasl_account',
            account_pass: 'sasl_pass',
            account_password: 'sasl_pass',
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

        let missingFields = [];
        let requiredFields = ['name', 'host', 'port', 'nick'];
        requiredFields.forEach(f => {
            if (typeof toUpdate[f] === 'undefined') {
                missingFields.push(f);
            }
        });

        if (missingFields.length > 0) {
            con.writeStatus('Missing fields: ' + missingFields.join(', '));
            con.writeStatus(`Usage: addnetwork name=example server=irc.example.net port=6697 tls=yes nick=mynick`);
            con.writeStatus(`Available fields: name, server, port, tls, nick, username, realname, password`);
            return;
        }

        let existingNet = await con.userDb.getNetworkByName(con.state.authUserId, toUpdate.name);
        if (existingNet) {
            let existingHost = existingNet.host + ':' + (existingNet.tls ? '+' : '') + existingNet.port;
            con.writeStatus(`Network ${existingNet.name} already exists (${existingHost})`);
            return;
        }

        let network = await con.db.factories.Network();
        network.user_id = con.state.authUserId;
        for (let prop in toUpdate) {
            network[prop] = toUpdate[prop];
        }
        await network.save();

        con.writeStatus(`New network saved. You can now login using your_username/${toUpdate.name}:your_password`);
    },
};

commands.DELNETWORK = {
    requiresNetworkAuth: false,
    fn: async function(input, con, msg) {
        // delnetwork network_name

        let parts = input.split(' ');
        if (!input || parts.length === 0) {
            con.writeStatus('Usage: delnetwork <network_name>');
        }

        let netName = parts[0];

        // Make sure the network exists
        let network = await con.userDb.getNetworkByName(con.state.authUserId, netName);
        if (!network) {
            con.writeStatus(`Network ${netName} could not be found`);
            return;
        }

        // Close any active upstream connections we have for this network
        let upstream = await con.conDict.findUsersOutgoingConnection(con.state.authUserId, network.id);
        if (upstream) {
            upstream.close();
            upstream.destroy();
        }


        await con.db.db('user_networks').where('id', network.id).delete();
        con.writeStatus(`Network ${network.name} deleted`);
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
        l.error('Error setting new password:', err.message);
        con.writeStatus('There was an error changing your password');
    }
};

commands.ADDUSER = {
    requiresAdmin: true,
    fn: async function(input, con, msg) {
        let parts = input.split(' ');
        let username = parts[0] || '';
        let password = parts[1] || '';
        if (!username || !password) {
            con.writeStatus('Usage: adduser <username> <password>');
            return false;
        }

        let existingUser = await con.userDb.getUser(username);
        if (existingUser) {
            con.writeStatus(`User ${username} already exists`);
            return;
        }

        try {
            await con.userDb.addUser(username, password);
            con.writeStatus(`Added new user, ${username}`);
        } catch (err) {
            l.error('Error adding new user:', err.message);
            con.writeStatus('There was an error adding the new user');
        }
    },
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

commands.KILL = {
    requiresAdmin: true,
    fn: async function(input, con, msg) {
        con.queue.stopListening().then(process.exit);
        return false;
    },
};

commands.RELOAD = {
    requiresAdmin: true,
    fn: async function(input, con, msg) {
        con.reloadClientCommands();
        return false;
    },
};
