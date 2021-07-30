const ParseDuration = require('parse-duration');
const Tokens = require('../libs/tokens');
const keyvals = require('keyvals');

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
        let commandName = input.split(' ')[0];
        if (commandName) {
            let command = commands[commandName.toUpperCase()];
            if (!command) {
                con.writeStatus(`There is no command by that name`);
                return;
            }

            if (!command.description) {
                con.writeStatus(`No help available for that command`);
                return;
            }

            con.writeStatus(`${commandName}: ${command.description}`);

        } else {
            let isAdmin = con.state.authAdmin;
            let userCommandList = [];
            let adminCommandList = [];
            
            Object.entries(commands).forEach(([name, command]) => {
                if (command.skipCommandList === true) {
                    return;
                }
                if (command.requiresAdmin) {
                    adminCommandList.push(name);
                } else {
                    userCommandList.push(name);
                }
            });

            con.writeStatus(`Available commands:`);
            con.writeStatus(userCommandList.sort().join(' '));
            if (isAdmin) {
                con.writeStatus(`Admin commands:`);
                con.writeStatus(adminCommandList.sort().join(' '));
            }
            con.writeStatus(`Type "help <command>" for help on a specific command`);
        }
    },
};

commands.HELLO =
commands.HEY =
commands.HI =
commands.OLA =
commands.HOLA = {
    requiresNetworkAuth: false,
    skipCommandList: true,
    fn: async function(input, con, msg) {
        con.writeStatus(`Hello!`);
    },
};

commands.CONNECT = {
    requiresNetworkAuth: true,
    description: 'Connect to the current network',
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
    description: 'Disconnect from the current network',
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
    description: 'List all connected clients logged into this network',
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

commands.LISTNETWORKS = {
    description: 'List the networks in your account',
    fn: async function(input, con, msg) {
        let nets = await con.userDb.getUserNetworks(con.state.authUserId);
        con.writeStatus(`${nets.length} network(s)`)
        nets.forEach((net) => {
            let netCon = con.conDict.findUsersOutgoingConnection(
                con.state.authUserId,
                net.id,
            );
            let activeNick = netCon ?
                netCon.state.nick :
                net.nick;
            let connected = netCon && netCon.state.connected ?
                'Yes' :
                'No';
            let lastErr = netCon && netCon.state.tempGet('irc_error') ?
                'Error: ' + netCon.state.tempGet('irc_error') :
                undefined;
            let info = [
                `${net.name} (${net.host}:${net.tls?'+':''}${net.port})`,
                `Nick: ${activeNick}`,
                `Connected? ${connected}`,
                lastErr,
            ];
            con.writeStatus(info.join('. '));
        });
    },
};

commands.ATTACH = {
    description: 'Attach to a network within your account. Usage: "attach <network_name>"',
    fn: async function(input, con, msg) {
        // attach network_name

        let parts = input.split(' ');
        if (!input || parts.length === 0) {
            con.writeStatus('Usage: attach <network_name>');
            return;
        }

        if (con.state.authNetworkId) {
            con.writeStatus('Already attached to a netork');
            return;
        }

        let netName = parts[0];

        // Make sure the network exists
        let network = await con.userDb.getNetworkByName(con.state.authUserId, netName);
        if (!network) {
            con.writeStatus(`Network ${netName} could not be found`);
            return;
        }

        con.state.setNetwork(network);
        con.cachedUpstreamId = false;

        // Close any active upstream connections we have for this network
        let upstream = await con.conDict.findUsersOutgoingConnection(con.state.authUserId, network.id);
        if (upstream && !upstream.state.connected) {
            // The upstream connection will call con.registerClient() once it's registered
            con.writeStatus('Connecting to the network..');
            upstream.open();
        } else if (upstream) {
            con.writeStatus(`Attaching you to the network`);
            if (upstream.state.receivedMotd) {
                await con.registerClient();
            }
        } else {
            con.makeUpstream(network);
            con.writeStatus('Connecting to the network..');
        }
    },
};

commands.CHANGENETWORK = {
    description: 'Change a setting for the active network, or another under your account. Usage: "changenetwork [network_name] option=val"',
    fn: async function(input, con, msg) {
        // changenetwork [network name] option=value

        let parts = input.split(' ');
        if (!input || parts.length === 0) {
            con.writeStatus('Usage: changenetwork [network_name] option=value');
        }

        // Either get the specified network or default to the active network
        let network = null;
        if (parts[0].indexOf('=') === -1) {
            network = await con.userDb.getNetworkByName(con.state.authUserId, parts[0]);
            if (!network) {
                con.writeStatus(`Network ${parts[0]} could not be found`);
                return;
            }
        } else {
            network = await con.userDb.getNetwork(con.state.authNetworkId);
        }

        if (!network) {
            con.writeStatus('Not logged into a network');
            return;
        }

        let toUpdate = {};
        let columnMap = {
            name: 'name',
            host: 'host',
            server: 'host',
            address: 'host',
            port: {column: 'port', type: 'number'},
            tls: {column: 'tls', type: 'bool'},
            tlsverify: {column: 'tlsverify', type: 'bool'},
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
            channels: 'channels'
        };

        let options = keyvals.parse(input);
        for (let optionName in options) {
            let field = optionName.toLowerCase();
            let val = options[optionName];

            if (!columnMap[field]) {
                continue;
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
        }

        if (Object.keys(toUpdate).length > 0) {
            for (let prop in toUpdate) {
                network[prop] = toUpdate[prop];
            }
            await network.save();

            con.writeStatus(`Updated network`);
        } else {
            con.writeStatus(`Usage: changenetwork server=irc.example.net port=6697 tls=yes`);
            con.writeStatus(`Available fields: name, server, port, tls, tlsverify, nick, username, realname, password, account, account_password, channels`);
        }
    },
};

commands.ADDNETWORK = {
    requiresNetworkAuth: false,
    description: 'Add a new network to your account. Usage: "addnetwork name=example server=irc.example.net port=6697 tls=yes nick=mynick"',
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
            tlsverify: {column: 'tlsverify', type: 'bool'},
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
            channels: 'channels',
        };

        let options = keyvals.parse(input);
        for (let optionName in options) {
            let field = optionName.toLowerCase();
            let val = options[optionName];

            if (!columnMap[field]) {
                continue;
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
        }

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
            con.writeStatus(`Available fields: name, server, port, tls, tlsverify, nick, username, realname, password, account, account_password, channels`);
            return;
        }

        let existingNet = await con.userDb.getNetworkByName(con.state.authUserId, toUpdate.name);
        if (existingNet) {
            let existingHost = existingNet.host + ':' + (existingNet.tls ? '+' : '') + existingNet.port;
            con.writeStatus(`Network ${existingNet.name} already exists (${existingHost})`);
            return;
        }

        try {
            await con.userDb.addNetwork(con.state.authUserId, toUpdate);
            con.writeStatus(`New network saved. You can now login using your_username/${toUpdate.name}:your_password`);

        } catch (err) {
            if (err.code === 'max_networks') {
                con.writeStatus(`No more networks can be added to this account`);
                return;
            } else if (err.code === 'missing_name') {
                // Should never get here, but lets be safe
                con.writeStatus(`A network name must be given`);
                return;
            } else {
                l.error(err);
                con.writeStatus(`An error occured trying to save your network`);
            }
        }
    },
};

commands.DELNETWORK = {
    requiresNetworkAuth: false,
    description: 'Delete a network from your account. Usage: "delnetwork <network_name>"',
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


        await con.db.dbUsers('user_networks').where('id', network.id).delete();
        con.writeStatus(`Network ${network.name} deleted`);
    },
};

commands.SETPASS = {
    description: 'Change the password for your BNC account. Usage: "setpass <newpass>"',
    fn: async function(input, con, msg) {
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
    },
};

commands.ADDTOKEN = {
    description: 'Add an auth token to log into your BNC account in place of a password. Handy for bots. Usage: "addtoken [expires] [token comment]"',
    fn: async function(input, con, msg) {
        const parts = input.split(' ');
        const duration = parts[0] === '0' ? 0 : ParseDuration(parts[0], 'sec');
        const comment = duration === null ? input : parts.slice(1).join(' ');

        try {
            let token = await con.userDb.generateUserToken(con.state.authUserId, duration, comment, con.state.host);
            con.writeStatusWithTags(
                'Created new token for your account. You can use it in place of your password: ' + token,
                { '+auth_token': token }
            );
        } catch (err) {
            l.error('Error creating user token:', err.message);
            con.writeStatus('There was an error creating a new token for your account');
        }
    },
};

commands.CHANGETOKEN = {
    description: 'Change an existing auth token on your BNC account. Usage: changetoken <token> [expires] [comment]',
    fn: async function(input, con, msg) {
        const parts = input.split(' ');
        const token = parts[0];

        if (parts.length < 2 || !Tokens.isUserToken(token)) {
            con.writeStatus('Usage: changetoken <token> [expires] [comment]');
            return false;
        }

        const duration = parts[1] === '0' ? 0 : ParseDuration(parts[1], 'sec');
        const comment = duration === null ? parts.slice(1).join(' ') : parts.slice(2).join(' ');

        try {
            const res = await con.userDb.updateUserToken(con.state.authUserId, token, duration, comment);
            if (res === 1) {
                con.writeStatus('Token changed!');
            } else {
                con.writeStatus('Failed to change token :(');
            }
        } catch (err) {
            l.error('Error updating user token:', err.message);
            con.writeStatus('There was an error updating the token for your account');
        }
    },
};

commands.LISTTOKENS = {
    description: 'List all auth tokens on your BNC account',
    fn: async function(input, con, msg) {
        try {
            let tokens = await con.userDb.getUserTokens(con.state.authUserId);
            tokens.forEach(t => {
                let str = t.token;
                str += ' Created: ' + new Date(t.created_at * 1000).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) + '.';
                str += ' Expires: ' + new Date(t.expires_at * 1000).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) + '.';
                if (t.comment) {
                    str += ` (${t.comment})`;
                }
                con.writeStatus(str);
            });
            con.writeStatus('No more tokens.');
        } catch (err) {
            l.error('Error reading user tokens:', err.message);
            con.writeStatus('There was an error reading the tokens for your account');
        }
    },
};

commands.DELTOKEN = {
    description: 'Delete an auth token from your BNC account. Usage: "deltoken <token>"',
    fn: async function(input, con, msg) {
        let parts = input.split(' ');
        let token = parts[0] || '';
        if (!token || !Tokens.isUserToken(token)) {
            con.writeStatus('Usage: deltoken <token>');
            return false;
        }

        try {
            await con.userDb.removeUserToken(con.state.authUserId, token);
            con.writeStatus('Token deleted');
        } catch (err) {
            l.error('Error deleting user token:', err.message);
            con.writeStatus('There was an error deleting the token from your account');
        }
    },
};

commands.ADDUSER = {
    requiresAdmin: true,
    description: 'Add a BNC user account. Usage: "adduser <username> <password>"',
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

commands.STATUS = {
    description: 'Show the connection status for the active network',
    fn: async function(input, con, msg) {
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
    },
};

commands.KILL = {
    requiresAdmin: true,
    description: 'Kill the BNC worker process and automatically restart it, applying any new configuration. Does not close any IRC connections',
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
