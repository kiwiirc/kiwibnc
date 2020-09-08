const messageTags = require('irc-framework/src/messagetags');
const { mParam, mParamU, isoTime, notifyLevel } = require('../../libs/helpers');

let bncApp = null;

module.exports.init = async function init(hooks, app) {
    bncApp = app;

    let sendConnectionState = async (upstream, state) => {
        let network = await app.userDb.getNetwork(upstream.state.authNetworkId);
        if (!network) {
            return;
        }

        app.cons.findAllUsersClients(upstream.state.authUserId).forEach(client => {
            if (client.state.caps.has('bouncer')) {
                client.writeMsg('BOUNCER', 'state', network.id, network.name, state);
            }
        });
    };

    hooks.on('available_caps', event => {
        event.caps.add('bouncer');
    });

    hooks.on('connection_open', event => {
        if (event.upstream) {
            sendConnectionState(event.upstream, 'connected');
        }
    });
    hooks.on('connection_close', event => {
        if (event.upstream) {
            sendConnectionState(event.upstream, 'disconnected');
        }
    });

    hooks.on('message_from_client', event => {
        if (event.message.command.toUpperCase() === 'BOUNCER') {
            return handleBouncerCommand(event);
        }
    });

    hooks.on('available_isupports', async event => {
        let token = 'BOUNCER';
        let upstream = event.client.upstream;
        if (upstream) {
            let network = await event.client.userDb.getNetwork(upstream.state.authNetworkId);
            if (network) {
                token += `=network=${network.name};netid=${network.id}`;
            }
        }

        event.tokens.push(token);
    });
};

async function handleBouncerCommand(event) {
    event.preventDefault();
    event.passthru = false;

    let msg = event.message;
    let con = event.client;

    let subCmd = mParamU(msg, 0, '');
    let encodeTags = require('irc-framework/src/messagetags').encode;

    let getNetworkId = (paramIdx) => {
        let netId = mParam(msg, paramIdx, '');
        return netId === '*' ?
            string(con.state.authNetworkId):
            netId;
    };

    if (subCmd === 'CONNECT') {
        let netId = getNetworkId(1);
        if (!netId) {
            con.writeMsg('BOUNCER', 'connect', '*', 'ERR_INVALIDARGS');
            return;
        }

        let network = await con.userDb.getUserNetwork(con.state.authUserId, netId);
        if (!network) {
            con.writeMsg('BOUNCER', 'connect', '*', 'ERR_NETNOTFOUND');
            return;
        }

        let upstream = null;
        upstream = con.conDict.findUsersOutgoingConnection(con.state.authUserId, network.id);
        if (upstream && !upstream.state.connected) {
            upstream.open();
        } else if(!upstream) {
            upstream = await con.makeUpstream(network);
        }
    }

    if (subCmd === 'DISCONNECT') {
        let netId = getNetworkId(1);
        if (!netId) {
            con.writeMsg('BOUNCER', 'disconnect', '*', 'ERR_INVALIDARGS');
            return;
        }

        let network = await con.userDb.getUserNetwork(con.state.authUserId, netId);
        if (!network) {
            con.writeMsg('BOUNCER', 'disconnect', netId, 'ERR_NETNOTFOUND');
            return;
        }

        let upstream = null;
        upstream = con.conDict.findUsersOutgoingConnection(con.state.authUserId, network.id);
        if (upstream && upstream.state.connected) {
            let quitMessage = mParam(msg, 2, '');
            if (quitMessage) {
                upstream.writeLine('QUIT', quitMessage);
            }

            upstream.close();
        }
    }

    if (subCmd === 'LISTNETWORKS') {
        await sendNetworkListToClients(con);
    }

    if (subCmd === 'LISTBUFFERS') {
        let netId = getNetworkId(1);
        if (!netId) {
            con.writeMsg('BOUNCER', 'listbuffers', '*', 'ERR_INVALIDARGS');
            return;
        }

        let network = await con.userDb.getUserNetwork(con.state.authUserId, netId);
        if (!network) {
            con.writeMsg('BOUNCER', 'listbuffers', '*', 'ERR_NETNOTFOUND');
            return;
        }

        let upstream = null;
        upstream = con.conDict.findUsersOutgoingConnection(con.state.authUserId, network.id);
        if (upstream) {
            for (let chanName in upstream.state.buffers) {
                let buffer = upstream.state.buffers[chanName];
                let chan = {
                    network: network.name,
                    buffer: buffer.name,
                };
                if (buffer.lastSeen) {
                    chan.seen = isoTime(new Date(buffer.lastSeen));
                }
                if (buffer.isChannel) {
                    chan = {
                        ...chan,
                        joined: buffer.joined ? '1' : '0',
                        topic: buffer.topic,
                    };
                }

                let levels = Object.assign(Object.create(null), {
                    [notifyLevel.Message]: 'message',
                    [notifyLevel.Mention]: 'highlight',
                    [notifyLevel.None]: 'never',
                });
                if (levels[buffer.notifyLevel]) {
                    chan.notify = levels[buffer.notifyLevel];
                }

                con.writeMsg('BOUNCER', 'listbuffers', network.id, encodeTags(chan));
            }
        }

        con.writeMsg('BOUNCER', 'listbuffers', network.id, 'RPL_OK');
    }

    if (subCmd === 'DELBUFFER') {
        let netId = getNetworkId(1);
        let bufferName = mParam(msg, 2, '');
        if (!netId || !bufferName) {
            con.writeMsg('BOUNCER', 'delbuffer', '*', '*', 'ERR_INVALIDARGS');
            return;
        }

        let network = await con.userDb.getUserNetwork(con.state.authUserId, netId);
        if (!network) {
            con.writeMsg('BOUNCER', 'delbuffer', '*', '*', 'ERR_NETNOTFOUND');
            return;
        }

        let upstream = null;
        upstream = con.conDict.findUsersOutgoingConnection(con.state.authUserId, network.id);
        if (!upstream) {
            // TODO: If no upstream loaded, check if its in the db (network) and remove it from there
            con.writeMsg('BOUNCER', 'delbuffer', network.id, bufferName, 'RPL_OK');
            return;
        }

        
        let buffer = upstream.state.getBuffer(bufferName);
        if (!buffer) {
            // No buffer? No need to delete anything
            con.writeMsg('BOUNCER', 'delbuffer', network.id, bufferName, 'RPL_OK');
            return;
        }

        upstream.state.delBuffer(buffer.name);
        if (buffer.joined) {
            upstream.writeLine('PART', buffer.name);
        }

        await upstream.state.save();
        con.writeMsg('BOUNCER', 'delbuffer', network.id, bufferName, 'RPL_OK');
    }

    if (subCmd === 'CHANGEBUFFER') {
        let netId = getNetworkId(1);
        let bufferName = mParam(msg, 2, '');
        if (!netId || !bufferName) {
            con.writeMsg('BOUNCER', 'changebuffer', '*', '*', 'ERR_INVALIDARGS');
            return;
        }

        let network = await con.userDb.getUserNetwork(con.state.authUserId, netId);
        if (!network) {
            con.writeMsg('BOUNCER', 'changebuffer', '*', '*', 'ERR_NETNOTFOUND');
            return;
        }

        let upstream = null;
        upstream = con.conDict.findUsersOutgoingConnection(con.state.authUserId, network.id);
        if (!upstream) {
            // TODO: If no upstream loaded, check if its in the db (network) and remove it from there
            con.writeMsg('BOUNCER', 'changebuffer', network.id, bufferName, 'ERR_BUFFERNOTFOUND');
            return;
        }

        let buffer = upstream.state.getBuffer(bufferName);
        if (!buffer) {
            con.writeMsg('BOUNCER', 'changebuffer', network.id, bufferName, 'ERR_BUFFERNOTFOUND');
            return;
        }

        let tags = messageTags.decode(mParam(msg, 3));
        if (tags && tags.seen) {
            let seen = tags.seen === '1' ?
                Date.now() :
                new Date(tags.seen).getTime();

            if (!isNaN(seen)) {
                buffer.lastSeen = seen;
            }
        }

        if (tags && tags.notify) {
            let levels = Object.assign(Object.create(null), {
                message: notifyLevel.Message,
                highlight: notifyLevel.Mention,
                never: notifyLevel.None,
            });
            if (Object.keys(levels).includes(tags.notify)) {
                buffer.notifyLevel = levels[tags.notify];
            }
        }

        await upstream.state.save();
    }

    if (subCmd === 'ADDNETWORK') {
        let tags = messageTags.decode(mParam(msg, 1));
        if (!tags || !tags.network || !tags.network.match(/^[a-z0-9_]+$/i)) {
            con.writeMsg('BOUNCER', 'addnetwork', '*', '*', 'ERR_NEEDSNAME');
            return;
        }

        let network = await con.userDb.getNetworkByName(con.state.authUserId, tags.network);
        if (network) {
            con.writeMsg('BOUNCER', 'addnetwork', '*', tags.network, 'ERR_NAMEINUSE');
            return;
        }

        let port = tags.port ?
            tags.port :
            6667;
        port = parseInt(tags.port, 10);
        if (isNaN(port) || port <= 0 || port > 65535) {
            con.writeMsg('BOUNCER', 'addnetwork', '*', tags.network, 'ERR_INVALIDPORT');
            return;
        }

        try {
            network = await con.userDb.addNetwork(con.state.authUserId, {
                name: tags.network,
                host: tags.host || '',
                port: port,
                tls: (tags.tls === '1'),
                tlsverify: (tags.tlsverify === '1'),
                nick: tags.nick || '',
                username: tags.user || '',
                realname: tags.realname || '',
                password: tags.password || '',
                sasl_account: tags.account || '',
                sasl_pass: tags.account_password || '',
            });
        } catch (err) {
            if (err.code === 'max_networks') {
                con.writeMsg('BOUNCER', 'addnetwork', '*', tags.network, 'ERR_MAXNETWORKS');
            } else {
                l.error('[BOUNCER] Error adding network to user', err);
                con.writeMsg('BOUNCER', 'addnetwork', '*', tags.network, 'ERR_UNKNOWN', 'Error saving the network');
            }
            
            return;
        }

        con.writeMsg('BOUNCER', 'addnetwork', network.id, network.name, 'RPL_OK');

        // Update all clients of the network list. This lets each client keep their network list up to date
        await sendNetworkListToClients(bncApp.cons.findAllUsersClients(con.state.authUserId));
    }

    if (subCmd === 'CHANGENETWORK') {
        let netId = getNetworkId(1);
        let tags = messageTags.decode(mParam(msg, 2));
        if (!netId || !tags) {
            con.writeMsg('BOUNCER', 'changenetwork', '*', 'ERR_INVALIDARGS');
            return;
        }

        let network = await con.userDb.getUserNetwork(con.state.authUserId, netId);
        if (!network) {
            con.writeMsg('BOUNCER', 'changenetwork', netId, 'ERR_NETNOTFOUND');
            return;
        }

        if (tags.port) {
            let port = tags.port ?
                tags.port :
                6667;
            port = parseInt(tags.port, 10);
            if (isNaN(port) || port <= 0 || port > 65535) {
                con.writeMsg('BOUNCER', 'changenetwork', netId, 'ERR_INVALIDPORT');
                return;
            }

            network.port = port;
        }

        if (typeof tags.host === 'string') {
            network.host = tags.host;
        }

        if (tags.tls) {
            network.tls = (tags.tls === '1');
        }

        if (tags.tlsverify) {
            network.tlsverify = (tags.tlsverify === '1');
        }

        if (typeof tags.nick === 'string') {
            network.nick = tags.nick;
        }

        if (typeof tags.user === 'string') {
            network.username = tags.user;
        }

        if (tags.network) {
            network.name = tags.network;
        }

        if (typeof tags.password === 'string') {
            network.password = tags.password;
        }

        if (typeof tags.account === 'string') {
            network.sasl_account = tags.account;
        }

        if (typeof tags.account_password === 'string') {
            network.sasl_pass = tags.account_password;
        }

        if (tags.notify) {
            let levels = Object.assign(Object.create(null), {
                message: notifyLevel.Message,
                highlight: notifyLevel.Mention,
                never: notifyLevel.None,
            });
            if (Object.keys(levels).includes(tags.notify)) {
                let upstream = con.upstream;
                if (upstream) {
                    for (bufferName in upstream.state.buffers) {
                        upstream.state.buffers[bufferName].notifyLevel = levels[tags.notify];
                    }
                }
            }
        }

        try {
            await network.save();
        } catch (err) {
            l.error('[BOUNCER] Error changing network', err.stack);
            con.writeMsg('BOUNCER', 'changenetwork', netId, 'ERR_UNKNOWN', 'Error saving the network');
            return;
        }

        con.writeMsg('BOUNCER', 'changenetwork', netId, 'RPL_OK');

        // Update all clients of the network list. This lets each client keep their network list up to date
        await sendNetworkListToClients(bncApp.cons.findAllUsersClients(con.state.authUserId));
    }

    if (subCmd === 'DELNETWORK') {
        let netId = getNetworkId(1);

        // Make sure the network exists
        let network = await con.userDb.getUserNetwork(con.state.authUserId, netId);
        if (!network) {
            con.writeMsg('BOUNCER', 'delnetwork', netId, 'ERR_NETNOTFOUND');
            return;
        }

        // Close any active upstream connections we have for this network
        let upstream = await con.conDict.findUsersOutgoingConnection(con.state.authUserId, network.id);
        if (upstream) {
            upstream.close();
            upstream.destroy();
        }


        await con.db.dbUsers('user_networks').where('id', network.id).delete();
        con.writeMsg('BOUNCER', 'delnetwork', netId, 'RPL_OK');

        // Update all clients of the network list. This lets each client keep their network list up to date
        await sendNetworkListToClients(bncApp.cons.findAllUsersClients(con.state.authUserId));
    }
};

async function sendNetworkListToClients(clients) {
    if (!Array.isArray(clients)) {
        clients = [clients];
    }

    if (clients.length === 0) {
        return;
    }

    let userId = clients[0].state.authUserId;
    let nets = await clients[0].userDb.getUserNetworks(clients[0].state.authUserId);
    let lines = [];

    nets.forEach((net) => {
        let parts = [];
        parts.push('network=' + net.name);
        parts.push('host=' + net.host);
        parts.push('port=' + net.port);
        parts.push('tls=' + (net.tls ? '1' : '0'));
        parts.push('tlsverify=' + (net.tlsverify ? '1' : '0'));
        parts.push('host=' + net.host);

        let propsToAdd = {
            // network_property: bouncer_key
            password: 'password',
            sasl_account: 'account',
            sasl_pass: 'account_password'
        };
        for (let prop in propsToAdd) {
            if (net[prop]) {
                parts.push(`${propsToAdd[prop]}=${net[prop]}`);
            }
        }

        let netCon = bncApp.cons.findUsersOutgoingConnection(userId, net.id);
        if (netCon) {
            parts.push('nick=' + netCon.state.nick);
            parts.push('state=' + (netCon.state.connected ? 'connected' : 'disconnected'));
        } else {
            parts.push('nick=' + net.nick);
            parts.push('state=disconnect');
        }

        lines.push(['BOUNCER', 'listnetworks', net.id, parts.join(';')]);
    });

    lines.push(['BOUNCER', 'listnetworks', 'RPL_OK']);

    clients.forEach((client) => {
        lines.forEach((line) => client.writeMsg(...line));
    });
}