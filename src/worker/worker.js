const uuidv4 = require('uuid/v4');
const { ircLineParser } = require('irc-framework');
const Database = require('../libs/database');
const Users = require('./users');
const MessageStore = require('./messagestores/sqlite');
const ConnectionOutgoing = require('./connectionoutgoing');
const ConnectionIncoming = require('./connectionincoming');

async function run() {
    let app = await require('../libs/bootstrap')('worker');

    app.db = new Database(app.conf.get('database.path', './connections.db'));
    await app.db.init();

    app.userDb = new Users(app.db);

    app.messages = new MessageStore(app.conf.get('messages', {}));
    await app.messages.init();

    // Container for all connection instances
    app.cons = new Map();

    listenToQueue(app);

    // Give some time for the queue to connect + sync up
    setTimeout(async () => {
        await startServers(app);
        loadConnections(app);
    }, 1000);
}

function listenToQueue(app) {
    let cons = app.cons;
    app.queue.listenForEvents(app.queue.queueToWorker);

    app.queue.on('reset', async (opts) => {
        // If we don't have any connections then we don't need to clear anything out. We do
        // need to start our servers again though
        if (cons.size === 0) {
            startServers(app);
            return;
        }

        // Give some time for the queue to process some internal stuff
        app.queue.stopListening().then(() => {
            // Wipe out all connection states other than listening servers. Listening servers should
            // be restarted
            app.db.run('DELETE FROM connections WHERE type != 2');
            setTimeout(() => {
                process.exit();
            }, 2000);
        });
    });

    // When the socket layer accepts a new incoming connection
    app.queue.on('connection.new', async (opts) => {
        let c = new ConnectionIncoming(opts.id, app.db, app.userDb, app.messages, app.queue);
        c.trackInMap(cons);
        c.state.host = opts.host;
        c.state.port = opts.port;

        try {
            l('saving incoming connection');
            await c.state.save();
        } catch (err) {
            l('Error saving incoming connection.', err.message);
            app.queue.sendToSockets('connection.close', {id: c.id});
            c.destroy();
            return;
        }

        l('calling onAccepted() incoming connection');
        c.onAccepted();
    });

    // When the socket layer has opened a new outgoing connection
    app.queue.on('connection.open', (opts) => {
        let con = cons.get(opts.id);
        if (con) {
            con.onUpstreamConnected();
        }
    });
    app.queue.on('connection.close', (opts) => {
        if (opts.error) {
            l(`Connection ${opts.id} closed. Error: ${opts.error.code}`);
        } else {
            l(`Connection ${opts.id} closed.`);
        }

        let con = cons.get(opts.id);
        if (con && con instanceof ConnectionOutgoing) {
            con.onUpstreamClosed();
        } else if (con && con instanceof ConnectionIncoming) {
            con.onClientClosed();
        }
    });
    app.queue.on('connection.data', (opts) => {
        let con = cons.get(opts.id);
        if (!con) {
            l('Recieved data for unknown connection ' + opts.id);
            return;
        }

        let line = opts.data.trim('\n\r');
        let msg = ircLineParser(line);
        if (!msg) {
            return;
        }

        if (con instanceof ConnectionIncoming) {
            con.messageFromClient(msg, line);
        } else {
            con.messageFromUpstream(msg, line);
        }
    });
}

// Start any listening servers on interfaces specified in the config, or any existing
// servers that were previously started outside of the config
async function startServers(app) {
    let existingBinds = await app.db.all('SELECT host, port FROM connections WHERE type = 2');
    let binds = app.conf.get('listeners.bind', []);

    for (let i = 0; i < binds.length; i++) {
        let parts = binds[i].split(':');
        let host = parts[0] || '0.0.0.0';
        let port = parts[1] || '6667';

        let exists = existingBinds.find((con) => {
            return con.host === host && con.port === port;
        });

        !exists && app.queue.sendToSockets('connection.listen', {
            host: host,
            port: port,
            id: uuidv4(),
        });
    }
}

async function loadConnections(app) {
    let rows = await app.db.all('SELECT conid, type, host, port FROM connections');
    l(`Loading ${rows.length} connections`);
    rows.forEach(async (row) => {
        l(` connection ${row.conid} ${row.type} ${row.host}:${row.port}`);
        let con = null;
        if (row.type === 0) {
            con = new ConnectionOutgoing(row.conid, app.db, app.messages, app.queue);
            con.trackInMap(app.cons);
            await con.state.maybeLoad();
            openConnection(app, con);

        } else if (row.type === 1) {
            con = new ConnectionIncoming(row.conid, app.db, app.userDb, app.messages, app.queue);
            con.trackInMap(app.cons);
            await con.state.maybeLoad();

        } else if (row.type === 2) {
            app.queue.sendToSockets('connection.listen', {
                host: row.host,
                port: row.port,
                id: row.conid,
            });
            return;
        }
    });
}

function openConnection(app, con) {
    app.queue.sendToSockets('connection.open', {
        host: con.state.host,
        port: con.state.port,
        tls: con.state.tls,
        id: con.id,
    });
}

    /*
    let c = new ConnectionOutgoing(uuidv4(), app.db, app.queue);
    c.trackInMap(cons);
    c.state.host = 'irc.freenode.net';
    c.state.port = 6667;
    c.state.tls = false;
    await c.state.save();
    app.queue.sendToSockets('connection.open', {
        host: c.state.host,
        port: c.state.port,
        tls: c.state.tls,
        id: c.id,
    });
    */

    /*
    app.queue.sendToSockets('connection.listen', {
        host: '0.0.0.0',
        port: 3001,
        id: uuidv4(),
    });
    */
module.exports = run();
