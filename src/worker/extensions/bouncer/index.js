const { mParam, mParamU } = require('../../../libs/helpers');

module.exports.init = function init(hooks) {
    hooks.on('message_from_client', event => {
        if (event.message.command.toUpperCase() === 'BOUNCER') {
            return handleBouncerCommand(event);
        }
    });
};

async function handleBouncerCommand(event) {
    event.preventDefault();
    event.passthru = false;

    let msg = event.message;
    let con = event.client;

    let subCmd = mParamU(msg, 0, '');

    let encodeTags = require('irc-framework/src/messagetags').encode;

    if (subCmd === 'CONNECT') {
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
            upstream.close();
        }
    }

    if (subCmd === 'LISTNETWORKS') {
        let nets = await con.userDb.getUserNetworks(con.state.authUserId);
        nets.forEach((net) => {
            let parts = [];
            parts.push('network=' + net.name);
            parts.push('host=' + net.host);
            parts.push('port=' + net.port);
            parts.push('tls=' + net.tls ? '1' : '0');
            parts.push('host=' + net.host);

            let netCon = con.conDict.findUsersOutgoingConnection(con.state.authUserId, net.id);
            if (netCon) {
                parts.push('state=' + (netCon.state.connected ? 'connected' : 'disconnected'));
            } else {
                parts.push('state=disconnect');
            }

            con.writeMsg('BOUNCER', 'listnetworks', parts.join(';'));
        });

        con.writeMsg('BOUNCER', 'listnetwork', 'RPL_OK');
    }

    if (subCmd === 'LISTBUFFERS') {
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
                    joined: buffer.joined ? '1' : '0',
                    topic: buffer.topic,
                };
                con.writeMsg('BOUNCER', 'listbuffers', network.name, encodeTags(chan));
            }
        }

        con.writeMsg('BOUNCER', 'listbuffers', network.name, 'RPL_OK');
    }

    if (subCmd === 'DELBUFFER') {
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
        }

        upstream.state.delBuffer(buffer.name);
        if (buffer.joined) {
            upstream.writeLine('PART', buffer.name);
        }

        con.writeMsg('BOUNCER', 'delbuffer', network.name, bufferName, 'RPL_OK');
    }
};
