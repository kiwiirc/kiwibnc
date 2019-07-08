const messageTags = require('irc-framework/src/messagetags');
const { mParam, mParamU, isoTime } = require('../../../libs/helpers');

module.exports.init = async function init(hooks, app) {
    let sendConnectionState = async (upstream, state) => {
        let network = await app.userDb.getNetwork(upstream.state.authNetworkId);
        if (!network) {
            return;
        }

        upstream.forEachClient(client => {
            if (client.state.caps.includes('kiwiirc.com/bouncer')) {
                client.writeMsg('BOUNCER', 'state', network.name, state);
            }
        });
    };

    hooks.on('available_caps', event => {
        event.caps.push('kiwiirc.com/bouncer');
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
                token += `=network=${network.name};`;
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

    let handled = false;

    if (subCmd === 'CONNECT') {
        handled = true;
        let netName = mParam(msg, 1, '');
        if (!netName) {
            con.writeMsg('BOUNCER', 'connect', '*', 'ERR_INVALIDARGS');
            return;
        }

        let network = await con.userDb.getNetworkByName(con.state.authUserId, netName);
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
        handled = true;
        let netName = mParam(msg, 1, '');
        if (!netName) {
            con.writeMsg('BOUNCER', 'disconnect', '*', 'ERR_INVALIDARGS');
            return;
        }

        let network = await con.userDb.getNetworkByName(con.state.authUserId, netName);
        if (!network) {
            con.writeMsg('BOUNCER', 'disconnect', '*', 'ERR_NETNOTFOUND');
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
        handled = true;
        let nets = await con.userDb.getUserNetworks(con.state.authUserId);
        nets.forEach((net) => {
            let parts = [];
            parts.push('network=' + net.name);
            parts.push('host=' + net.host);
            parts.push('port=' + net.port);
            parts.push('tls=' + (net.tls ? '1' : '0'));
            parts.push('host=' + net.host);

            let netCon = con.conDict.findUsersOutgoingConnection(con.state.authUserId, net.id);
            if (netCon) {
                parts.push('nick=' + netCon.state.nick);
                parts.push('state=' + (netCon.state.connected ? 'connected' : 'disconnected'));
            } else {
                parts.push('nick=' + net.nick);
                parts.push('state=disconnect');
            }

            con.writeMsg('BOUNCER', 'listnetworks', parts.join(';'));
        });

        con.writeMsg('BOUNCER', 'listnetworks', 'RPL_OK');
    }

    if (subCmd === 'LISTBUFFERS') {
        handled = true;
        let netName = mParam(msg, 1, '');
        if (!netName) {
            con.writeMsg('BOUNCER', 'listbuffers', '*', 'ERR_INVALIDARGS');
            return;
        }

        let network = await con.userDb.getNetworkByName(con.state.authUserId, netName);
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
                con.writeMsg('BOUNCER', 'listbuffers', network.name, encodeTags(chan));
            }
        }

        con.writeMsg('BOUNCER', 'listbuffers', network.name, 'RPL_OK');
    }

    if (subCmd === 'DELBUFFER') {
        handled = true;
        let netName = mParam(msg, 1, '');
        let bufferName = mParam(msg, 2, '');
        if (!netName || !bufferName) {
            con.writeMsg('BOUNCER', 'delbuffer', '*', 'ERR_INVALIDARGS');
            return;
        }

        let network = await con.userDb.getNetworkByName(con.state.authUserId, netName);
        if (!network) {
            con.writeMsg('BOUNCER', 'delbuffer', '*', 'ERR_NETNOTFOUND');
            return;
        }

        let upstream = null;
        upstream = con.conDict.findUsersOutgoingConnection(con.state.authUserId, network.id);
        if (!upstream) {
            // TODO: If no upstream loaded, check if its in the db (network) and remove it from there
            con.writeMsg('BOUNCER', 'delbuffer', network.name, bufferName, 'RPL_OK');
            return;
        }

        
        let buffer = upstream.state.getBuffer(bufferName);
        if (!buffer) {
            // No buffer? No need to delete anything
            con.writeMsg('BOUNCER', 'delbuffer', network.name, bufferName, 'RPL_OK');
            return;
        }

        upstream.state.delBuffer(buffer.name);
        if (buffer.joined) {
            upstream.writeLine('PART', buffer.name);
        }

        con.writeMsg('BOUNCER', 'delbuffer', network.name, bufferName, 'RPL_OK');
    }

    if (subCmd === 'CHANGEBUFFER') {
        handled = true;
        let netName = mParam(msg, 1, '');
        let bufferName = mParam(msg, 2, '');
        if (!netName || !bufferName) {
            con.writeMsg('BOUNCER', 'changebuffer', '*', '*', 'ERR_INVALIDARGS');
            return;
        }

        let network = await con.userDb.getNetworkByName(con.state.authUserId, netName);
        if (!network) {
            con.writeMsg('BOUNCER', 'changebuffer', '*', '*', 'ERR_NETNOTFOUND');
            return;
        }

        let upstream = null;
        upstream = con.conDict.findUsersOutgoingConnection(con.state.authUserId, network.id);
        if (!upstream) {
            // TODO: If no upstream loaded, check if its in the db (network) and remove it from there
            con.writeMsg('BOUNCER', 'changebuffer', network.name, bufferName, 'ERR_BUFFERNOTFOUND');
            return;
        }

        let buffer = upstream.state.getBuffer(bufferName);
        if (!buffer) {
            con.writeMsg('BOUNCER', 'changebuffer', network.name, bufferName, 'ERR_BUFFERNOTFOUND');
            return;
        }

        let tags = messageTags.decode(mParam(msg, 3));
        if (tags && tags.seen) {
            let seen = new Date(tags.seen).getTime();
            if (!isNaN(seen)) {
                buffer.lastSeen = seen;
            }
        }
    }

    if (subCmd === 'ADDNETWORK') {
        handled = true;
        let tags = messageTags.decode(mParam(msg, 1));
        if (!tags || !tags.network || !tags.network.match(/^[a-z0-9_]+$/i)) {
            con.writeMsg('BOUNCER', 'addnetwork', '*', 'ERR_NEEDSNAME');
            return;
        }

        let network = await con.userDb.getNetworkByName(con.state.authUserId, tags.network);
        if (network) {
            con.writeMsg('BOUNCER', 'addnetwork', tags.network, 'ERR_NAMEINUSE');
            return;
        }

        let port = tags.port ?
            tags.port :
            6667;
        port = parseInt(tags.port, 10);
        if (isNaN(port) || port <= 0 || port > 65535) {
            con.writeMsg('BOUNCER', 'addnetwork', tags.network, 'ERR_INVALIDPORT');
            return;
        }

        try {
            await con.db.db('user_networks').insert({
                user_id: con.state.authUserId,
                name: tags.network,
                host: tags.host || '',
                port: port,
                tls: (tags.tls === '1'),
                nick: tags.nick || '',
                username: tags.user || '',
                realname: '-',
            });
        } catch (err) {
            l.error('[BOUNCER] Error adding network to user', err.stack);
            con.writeMsg('BOUNCER', 'addnetwork', tags.network, 'ERR_UNKNOWN', 'Error saving the network');
            return;
        }

        con.writeMsg('BOUNCER', 'addnetwork', tags.network, 'RPL_OK');
    }

    if (subCmd === 'CHANGENETWORK') {
        handled = true;
        let netName = mParam(msg, 1);
        let tags = messageTags.decode(mParam(msg, 2));
        if (!netName || !tags) {
            con.writeMsg('BOUNCER', 'changenetwork', '*', 'ERR_INVALIDARGS');
            return;
        }

        let network = await con.userDb.getNetworkByName(con.state.authUserId, netName);
        if (!network) {
            con.writeMsg('BOUNCER', 'changenetwork', netName, 'ERR_NETNOTFOUND');
            return;
        }

        let netUpdates = {};

        if (tags.port) {
            let port = tags.port ?
                tags.port :
                6667;
            port = parseInt(tags.port, 10);
            if (isNaN(port) || port <= 0 || port > 65535) {
                con.writeMsg('BOUNCER', 'changenetwork', netName, 'ERR_INVALIDPORT');
                return;
            }

            netUpdates.port = port;
        }

        if (tags.host) {
            netUpdates.host = tags.host;
        }

        if (tags.tls) {
            netUpdates.tls = (tags.tls === '1');
        }

        if (tags.nick) {
            netUpdates.nick = tags.nick;
        }

        if (tags.user) {
            netUpdates.username = tags.user;
        }

        if (Object.keys(netUpdates).length > 0) {
            try {
                await con.db.db('user_networks')
                    .where('id', network.id)
                    .update(netUpdates);
            } catch (err) {
                l.error('[BOUNCER] Error adding network to user', err.stack);
                con.writeMsg('BOUNCER', 'changenetwork', netName, 'ERR_UNKNOWN', 'Error saving the network');
                return;
            }
        }

        let upstream = null;
        upstream = con.conDict.findUsersOutgoingConnection(con.state.authUserId, network.id);
        if (upstream) {
            for (let prop in netUpdates) {
                if (prop === 'port') {
                    upstream.state.port = netUpdates.port;
                }

                if (prop === 'host') {
                    upstream.state.host = netUpdates.host;
                }

                if (prop === 'tls') {
                    upstream.state.tls = netUpdates.tls;
                }

                if (prop === 'user') {
                    upstream.state.username = netUpdates.user;
                }
            }

            await upstream.state.save();
        }

        con.writeMsg('BOUNCER', 'changenetwork', netName, 'RPL_OK');
    }

    if (subCmd === 'DELNETWORK') {
        handled = true;
        let netName = mParam(msg, 1);

        // Make sure the network exists
        let network = await con.userDb.getNetworkByName(con.state.authUserId, netName);
        if (!network) {
            con.writeMsg('BOUNCER', 'delnetwork', netName, 'ERR_NETNOTFOUND');
            return;
        }

        // Close any active upstream connections we have for this network
        let upstream = await con.conDict.findUsersOutgoingConnection(con.state.authUserId, network.id);
        if (upstream) {
            upstream.close();
            upstream.destroy();
        }


        await con.db.db('user_networks').where('id', network.id).delete();
        con.writeMsg('BOUNCER', 'delnetwork', netName, 'RPL_OK');
    }

    if (!handled) {
        if (subCmd == '' || subCmd[0] == ':') {
            subCmd = '*';
        }
        con.writeMsg('FAIL', 'BOUNCER', 'unknown_subcommand', subCmd, 'Unknown subcommand');
    }
};
