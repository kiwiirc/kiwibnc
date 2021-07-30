/**
 * Internals extension
 * 
 * Browse the internal state of the BNC at runtime. List all connections and their properties, then
 * dig into an individual connection to see its IRC or client connection state.
 * While great for debugging and developing on kiwibnc, it will reveal every bit of info about a
 * connection including all channels/keys/passwords/etc. This may not be great in production!
 */

module.exports.init = async function init(hooks, app) {
    hooks.on('available_isupports', async event => {
        event.tokens.push('kiwibnc/httpapi');
    });

    app.webserver.router.get('/internals/', async ctx => {
        let query = ctx.request.query;
        
        let out = '<h2>KiwiBNC internals</h2>\n';

        if (query.conid) {
            let con = app.cons.get(query.conid);
            if (!con) {
                ctx.body = `Connection ${query.conid} not found`;
                return;
            }

            // Connection info table
            let ignoreProps = 'db buffers'.split(' ');
            let rows = [];
            for (let prop in con.state) {
                if (ignoreProps.includes(prop)) {
                    continue;
                }

                let val = '';
                try {
                    if (con.state[prop] instanceof Set) {
                        val = JSON.stringify([...con.state[prop].values()]);
                    } else {
                        val = JSON.stringify(con.state[prop]);
                    }
                } catch (err) {
                    val = '';
                }
                rows.push({
                    Property: prop,
                    Value: val,
                });
            }

            out += '<a href="/internals/">Back to connection list</a>';
            out += `<h3>Connection state for ${conTypeToStr(con.state.type)} ${query.conid}</h3>`;
            out += buildTable(rows);


            // Buffers table
            rows = [];
            let bufferUsersRows = [];
            for (let bufferId of Object.keys(con.state.buffers)) {
                let buffer = con.state.buffers[bufferId];
                rows.push({
                    id: JSON.stringify(bufferId),
                    name: JSON.stringify(buffer.name),
                    key: JSON.stringify(buffer.key),
                    joined: JSON.stringify(buffer.joined),
                    shouldBeJoined: JSON.stringify(buffer.shouldBeJoined),
                    partReceived: JSON.stringify(buffer.partReceived),
                    topic: JSON.stringify(buffer.topic),
                    modes: JSON.stringify(buffer.modes),
                    status: JSON.stringify(buffer.status),
                    isChannel: JSON.stringify(buffer.isChannel),
                    lastSeen: JSON.stringify(buffer.lastSeen),
                    notifyLevel: JSON.stringify(buffer.notifyLevel),
                });

                for (let userId of Object.keys(buffer.users)) {
                    let user = buffer.users[userId];
                    bufferUsersRows.push({
                        Buffer: buffer.name,
                        User: JSON.stringify(userId),
                        '': JSON.stringify(user),
                    });
                }
            }

            out += `<h3>Buffers</h3>`;
            out += buildTable(rows);

            out += `<h3>User Lists</h3>`;
            out += buildTable(bufferUsersRows);

        } else {
            let rows = [];
            app.cons.map.forEach(con => {
                let row = {};
                rows.push(row);

                let state = con.state;

                row.id = `<a href="?conid=${state.conId}">${state.conId}</a>`;
                //row.id = state.conId;
                row.type = conTypeToStr(state.type),
                row.connected = state.connected;
                row.nick = state.nick;
                row.account = state.account;
                row.clientid = state.clientid;
                row.username = state.username;
                row.host = state.host;
                row.port = state.port;
                row.tls = state.tls;
                row.netRegistered = state.netRegistered;
                row.receivedMotd = state.receivedMotd;
                row.authUserId = state.authUserId;
                row.authNetworkId = state.authNetworkId;
                row.authNetworkName = state.authNetworkName;
                row.authAdmin = state.authAdmin;
            });

            out += '<h3>Connections</h3>';
            out += buildTable(rows);
        }

        ctx.body = out;
    });
};

function conTypeToStr(type) {
    let types = ['Outgoing', 'Incoming', 'Server'];
    return types[type] || `Unknown-${type}`;
}
function buildTable(rows) {
    let out = '<table border=1>';
    out += '<tr>';
    for(let colName in rows[0]) {
        out += `<th>${colName}</td>`;
    }
    out += '</tr>';

    rows.forEach(row => {
        out += '<tr>';
        for(let colName in row) {
            out += `<td>${row[colName]}</td>`;
        }
        out += '</tr>';
    });
    out += '</table>';

    return out;
}
