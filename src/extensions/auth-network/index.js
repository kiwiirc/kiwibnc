const ConnectionOutgoing = require('../../worker/connectionoutgoing');
const tokens = require('../../libs/tokens');

module.exports.init = async function init(hooks, app) {
    const netConfig = app.conf.get('extension.auth-network', {});

    // Check config settings
    const requiredKeys = ['name', 'host', 'port', 'tls'];
    const missingKeys = [];
    requiredKeys.forEach((key) => {
        if (typeof netConfig[key] === 'undefined') {
            missingKeys.push(key);
        }
    });
    if (missingKeys.length) {
        l.error('extension.auth-network missing required keys:', missingKeys.join(', '));
        l.error('extension.auth-network disabled');
        return;
    }

    hooks.on('auth', async (event) => {
        const user = await app.userDb.getUser(event.username);
        if (user) {
            return;
        }

        l.trace('Attempting to auth new user with SASL:', event.username);

        const netInfo = { ...netConfig };
        netInfo.name = event.username;
        netInfo.sasl_account = event.username;
        netInfo.sasl_pass = event.password;
        netInfo.nick = event.username;
        netInfo.channels = '';

        let network = await app.userDb.getNetworkByName(-1, netInfo.name);
        if (network) {
            // Temp network exists but it maybe stale so cleanup time
            const upstream = await app.cons.findUsersOutgoingConnection(-1, network.id);
            if (upstream) {
                await cleanTempNetwork(upstream);
            } else {
                await app.db.dbUsers('user_networks').where('id', network.id).delete();
            }
        }

        network = await app.userDb.addNetwork(-1, netInfo);
        const con = new ConnectionOutgoing(null, app.db, app.messages, app.queue, app.cons);
        con.state.authUserId = -1;
        con.state.setNetwork(network);
        con.state.host = network.host;
        con.state.port = network.port;
        con.state.tls = network.tls;
        con.state.nick = network.nick || 'kiwibnc';
        con.state.username = network.username || network.nick || 'kiwibnc';
        con.state.realname = network.realname || network.nick || 'kiwibnc';
        con.state.password = network.password;
        con.state.sasl.account = network.sasl_account || '';
        con.state.sasl.password = network.sasl_pass || '';

        await con.state.save();
        await con.open();

        const conId = event.client.state.conId;
        con.state.linkIncomingConnection(conId);

        event.preventDefault();
    });

    hooks.on('message_from_upstream', async (event) => {
        const upstream = event.client;
        if (upstream.state.authUserId !== -1) {
            // Not a connection we are interested in
            return;
        }

        const msg = event.message;
        if (msg.command === 'CAP' && msg.params[1] === 'ACK') {
            const caps = msg.params[2].split(' ');
            if (!caps.includes('sasl')) {
                // Server does not support SASL
                l.error('Failed auth new user, server does not support SASL');
                await failed(upstream);
            }
        }

        switch (msg.command) {
            case '900':
            case '903':
                await success(upstream);
                break;
            case '901':
            case '902':
            case '904':
            case '905':
            case '906':
            case '907':
                await failed(upstream);
                break;
            default:
        }
    });

    hooks.on('connection_close', async (event) => {
        if (event.upstream.state.authUserId === -1) {
            l.trace('Temp connection closed, destroying', event.upstream.conId);
            event.upstream.destroy();
        }
    });

    async function success(upstream) {
        const sasl = upstream.state.sasl;
        l.trace('SASL auth success for new user:', sasl.account);

        const user = await app.userDb.addUser(sasl.account, sasl.password, false);
        const network = await app.userDb.getNetwork(upstream.state.authNetworkId);
        network.user_id = user.id;
        network.nick = sasl.account;
        network.name = netConfig.name;
        network.channels = netConfig.channels;
        await network.save();

        upstream.forEachClient(async (inCon) => {
            inCon.state.authUserId = user.id;
            inCon.state.authNetworkId = network.id;
            inCon.state.save();
        });

        upstream.state.authUserId = user.id;
        await upstream.state.save();

        (netConfig.channels || '').split(',').forEach((chanName) => {
            if (chanName.trim()) {
                const buffer = upstream.state.getOrAddBuffer(chanName.trim(), upstream);
                buffer.joined = true;
            }
        });
    }

    async function failed(upstream) {
        l.trace('SASL auth failed for new user:', sasl.account);

        upstream.forEachClient(async (inCon) => {
            await inCon.writeMsg('ERROR', 'Invalid password');
            inCon.close();
            inCon.destroy();
        });

        await cleanTempNetwork(upstream);
    }

    async function cleanTempNetwork(upstream) {
        if (upstream.state.connected) {
            // Connection will be destroyed when it closes
            upstream.close();
        } else {
            upstream.destroy();
        }
        await app.db.dbUsers('user_networks').where('id', upstream.state.authNetworkId).delete();
    }
};
