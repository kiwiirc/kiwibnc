const messageTags = require('irc-framework/src/messagetags');
const { mParam, mParamU, isoTime, notifyLevel } = require('../../libs/helpers');

let bncApp = null;

// Max size of the encoded kiwi.settings blob we'll accept/store per buffer,
// as a guard against a client stuffing large values into buffer settings.
const MAX_BUFFER_SETTINGS_LEN = 4096;

function safeParseSettings(val) {
    if (typeof val !== 'string' || val.length === 0 || val.length > MAX_BUFFER_SETTINGS_LEN) {
        return null;
    }

    let parsed;
    try {
        parsed = JSON.parse(val);
    } catch (err) {
        return null;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }

    // Copy onto a null-proto object, skipping keys that could pollute a prototype
    // if this object were ever assigned onto a normal object down the line.
    let clean = Object.create(null);
    for (let key of Object.keys(parsed)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
            continue;
        }
        clean[key] = parsed[key];
    }

    return clean;
}

function safeSeenIso(val) {
    let ts = Number(val);
    if (!Number.isFinite(ts) || ts <= 0) {
        return '';
    }

    let d = new Date(ts);
    if (!Number.isFinite(d.getTime())) {
        return '';
    }

    return isoTime(d);
}

function buildBufferTags(buffer, networkName, unreadCount, seenMs) {
    let tags = {
        network: networkName,
        buffer: buffer.name,
    };

    if (seenMs > 0) {
        let seen = safeSeenIso(seenMs);
        if (seen) {
            tags.seen = seen;
        }
    }

    if (typeof unreadCount === 'number') {
        tags.unread = String(unreadCount);
    }

    if (buffer.isChannel) {
        tags = {
            ...tags,
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
        tags.notify = levels[buffer.notifyLevel];
    }

    if (buffer.settings && Object.keys(buffer.settings).length > 0) {
        tags['kiwi.settings'] = JSON.stringify(buffer.settings);
    }

    return tags;
}

// Compute the seen timestamp shared between bouncer-cap clients. Keys prefixed
// with 'auto:' are written by non-bouncer clients (every PRIVMSG received) and
// would clobber the shared state, so they're excluded here.
function maxSeenTs(buffer) {
    let max = 0;
    if (buffer.lastSeen) {
        for (let cid in buffer.lastSeen) {
            if (cid.startsWith('auto:')) continue;
            let ts = Number(buffer.lastSeen[cid]);
            if (ts > max) max = ts;
        }
    }
    return max;
}

async function sendBufferListToClient(client, network, upstream) {
    if (!client || !clientSupportsBouncer(client)) {
        return;
    }

    if (!upstream) {
        client.writeMsg('BOUNCER', 'listbuffers', network.id, 'RPL_OK');
        return;
    }

    const userId = upstream.state.authUserId;
    const networkId = upstream.state.authNetworkId;
    const hasMessageStore = bncApp.messages && typeof bncApp.messages.countMessagesSince === 'function';
    const historyDepth = (bncApp.messages && bncApp.messages.connectHistory) || 50;

    for (let chanName in upstream.state.buffers) {
        let buffer = upstream.state.buffers[chanName];
        let seen = maxSeenTs(buffer);
        let unreadCount;
        if (hasMessageStore) {
            // If no bouncer-cap client has ever read this buffer, fall back to the
            // timestamp of the Nth most recent stored message (N = connect_history),
            // so the initial unread count is capped at a sensible window rather than
            // showing every message ever stored.
            if (seen === 0) {
                seen = await bncApp.messages.getNthLatestMessageTime(userId, networkId, buffer.name, historyDepth);
            }
            unreadCount = await bncApp.messages.countMessagesSince(userId, networkId, buffer.name, seen);
        }
        let tags = buildBufferTags(buffer, network.name, unreadCount, seen);
        client.writeMsg('BOUNCER', 'listbuffers', network.id, messageTags.encode(tags));
    }

    client.writeMsg('BOUNCER', 'listbuffers', network.id, 'RPL_OK');
}

async function sendBufferListToUsersClients(userId, networkId, excludeConId='') {
    let clients = bncApp.cons.findAllUsersClients(userId).filter((client) => {
        let sameNetwork = String(client.state.authNetworkId) === String(networkId);
        let notExcluded = !excludeConId || client.id !== excludeConId;
        return sameNetwork && notExcluded && client.state.caps.has('bouncer');
    });

    if (clients.length === 0) {
        return;
    }

    let upstream = bncApp.cons.findUsersOutgoingConnection(userId, networkId);
    let network = await clients[0].userDb.getUserNetwork(userId, networkId);
    if (!network) {
        return;
    }

    for (let i = 0; i < clients.length; i++) {
        await sendBufferListToClient(clients[i], network, upstream);
    }
}

const pendingBufferListSyncs = new Map();

function scheduleBufferListSync(userId, networkId) {
    const key = `${userId}:${networkId}`;

    if (pendingBufferListSyncs.has(key)) {
        return;
    }

    const timer = setTimeout(async () => {
        pendingBufferListSyncs.delete(key);

        try {
            await sendBufferListToUsersClients(
                userId,
                networkId,
                ''
            );
        } catch (err) {
            l.error(
                '[BOUNCER] Error syncing buffer list:',
                err.stack || err.message
            );
        }
    }, 1000);

    pendingBufferListSyncs.set(key, timer);
}

function clientSupportsBouncer(client) {
    return client.state.caps.has('bouncer') || client.state.tempGet('bouncer_requested');
}

module.exports.init = async function init(hooks, app) {
    bncApp = app;

    let sendConnectionState = async (upstream, state) => {
        let network = await app.userDb.getNetwork(upstream.state.authNetworkId);
        if (!network) {
            return;
        }

        app.cons.findAllUsersClients(upstream.state.authUserId).forEach(client => {
            if (clientSupportsBouncer(client)) {
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

    hooks.on('buffer_added', async (event) => {
        // Only sync PM buffers (not channels)
        if (event.buffer.isChannel) {
            return;
        }

        let upstream = event.upstream;
        let buffer = event.buffer;

        // A PM buffer recreated by an incoming message (e.g. after the client
        // closed it via DELBUFFER) starts again with an empty lastSeen. Without
        // an anchor, the unread fallback in sendBufferListToClient would count
        // the whole backlog. Anchor the seen timestamp to the message that
        // preceded the one that just arrived, so only newly received messages
        // count as unread.
        if (bncApp.messages &&
            typeof bncApp.messages.getNthLatestMessageTime === 'function' &&
            maxSeenTs(buffer) === 0
        ) {
            let anchor = await bncApp.messages.getNthLatestMessageTime(
                upstream.authUserId, upstream.authNetworkId, buffer.name, 1
            );
            if (anchor > 0) {
                buffer.lastSeen['anchor'] = anchor;
                if (typeof upstream.markDirty === 'function') {
                    upstream.markDirty();
                }
            }
        }

        // Sync to all clients of this user
        await sendBufferListToUsersClients(
            upstream.authUserId,
            upstream.authNetworkId,
            '' // No exclusion - all clients should see the new PM
        );
    });

    // Notify new bouncer clients of already-connected networks
    hooks.on('client_registered', async (event) => {
        const client = event.client;

        // Only for clients with bouncer capability
        if (!clientSupportsBouncer(client)) {
            return;
        }

        // Get all user's networks and send state for connected ones
        const networks = await client.userDb.getUserNetworks(client.state.authUserId);

        for (const network of networks) {
            const upstream = app.cons.findUsersOutgoingConnection(
                client.state.authUserId,
                network.id
            );

            if (upstream && upstream.state.connected) {
                await client.writeMsg('BOUNCER', 'state', network.id, network.name, 'connected');
            }
        }
        client.flushBuffer();
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
    con.state.tempSet('bouncer_requested', true);

    let subCmd = mParamU(msg, 0, '');

    let getNetworkId = (paramIdx) => {
        let netId = mParam(msg, paramIdx, '');
        return netId === '*' ?
            String(con.state.authNetworkId):
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
            // Don't link the client<>upstream connections. If the netId was * (use the active
            // connection) then it will already be linked, or if a specific netId was provided then
            // we are acting on an unrelated upstream.
            upstream = await con.makeUpstream(network, { linkConnections: false });
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
        await sendNetworkListToClients([con]);

        // After sending the network list, also send state messages for connected networks
        // KiwiIRC needs these to update the UI properly
        if (clientSupportsBouncer(con)) {
            const networks = await con.userDb.getUserNetworks(con.state.authUserId);
            for (const network of networks) {
                const upstream = bncApp.cons.findUsersOutgoingConnection(con.state.authUserId, network.id);
                if (upstream && upstream.state.connected) {
                    await con.writeMsg('BOUNCER', 'state', network.id, network.name, 'connected');
                }
            }
            con.flushBuffer();
        }
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
        await sendBufferListToClient(con, network, upstream);
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
        if (buffer.joined && !buffer.partReceived) {
            // The client may have sent a PART for this buffer too. If so, don't sent our own
            // otherwise the server will send an error with 2 PART commands.
            upstream.writeLine('PART', buffer.name);
        }

        upstream.state.markDirty();
        con.writeMsg('BOUNCER', 'delbuffer', network.id, bufferName, 'RPL_OK');

        scheduleBufferListSync(
            con.state.authUserId,
            network.id
        );
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
                buffer.lastSeen[con.state.clientid] = seen;
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

        if (tags && typeof tags['kiwi.settings'] === 'string') {
            let incoming = safeParseSettings(tags['kiwi.settings']);
            if (incoming) {
                // Clients always transmit their complete syncable set, so replace
                // rather than merge. Merging would resurrect keys the user removed
                // and let the stored object grow past MAX_BUFFER_SETTINGS_LEN.
                buffer.settings = incoming;
            }
        }

        upstream.state.markDirty();
        await sendBufferListToUsersClients(con.state.authUserId, network.id, con.id);
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

    for (const client of clients) {
        // Preserve ordering for KiwiIRC: listnetworks must be fully sent before any state updates.
        for (const line of lines) {
            await client.writeMsg(...line);
        }
        client.flushBuffer();
    }
}
