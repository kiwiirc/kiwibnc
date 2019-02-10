const uuidv4 = require('uuid/v4');
const { ircLineParser } = require('irc-framework');
const Database = require('../libs/database');
const Users = require('./users');
const MessageStore = require('./messagestores/sqlite');
const ConnectionOutgoing = require('./connectionoutgoing');
const ConnectionIncoming = require('./connectionincoming');
const ConnectionDict = require('./connectiondict');

async function run() {
    let app = await require('../libs/bootstrap')('worker');

    app.db = new Database(app.conf.get('database.path', './connections.db'));
    await app.db.init();

    app.userDb = new Users(app.db);

    app.messages = new MessageStore(app.conf.get('messages', {}));
    await app.messages.init();

    // Container for all connection instances
    app.cons = new ConnectionDict(app.db, app.userDb, app.messages, app.queue);

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

    app.queue.on('reset', async (opts, ack) => {
        // If we don't have any connections then we don't need to clear anything out. We do
        // need to start our servers again though
        if (cons.size === 0) {
            startServers(app);
            ack();
            return;
        }

        // Give some time for the queue to process some internal stuff
        app.queue.stopListening().then(async () => {
            // Wipe out all incoming connection states. Incoming connections need to manually reconnect
            await app.db.run('DELETE FROM connections WHERE type = ?', [ConnectionDict.TYPE_INCOMING]);
            setTimeout(() => {
                process.exit();
            }, 2000);
        });

        ack();
    });

    // When the socket layer accepts a new incoming connection
    app.queue.on('connection.new', async (opts, ack) => {
        l('loading from ID...');
        let c = await app.cons.loadFromId(opts.id, ConnectionDict.TYPE_INCOMING);
        l('got con. setting post+port');
        c.state.host = opts.host;
        c.state.port = opts.port;

        try {
            l('saving incoming connection');
            await c.state.save();
        } catch (err) {
            l('Error saving incoming connection.', err.message);
            app.queue.sendToSockets('connection.close', {id: c.id});
            c.destroy();
            ack();
            return;
        }

        l('calling onAccepted() incoming connection');
        c.onAccepted();
        l('onAccepted() completed');
        ack();
    });

    // When the socket layer has opened a new outgoing connection
    app.queue.on('connection.open', (opts, ack) => {
        let con = cons.get(opts.id);
        if (con) {
            con.onUpstreamConnected();
        }
        ack();
    });
    app.queue.on('connection.close', (opts, ack) => {
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
        ack();
    });
    app.queue.on('connection.data', (opts, ack) => {
        let con = cons.get(opts.id);
        if (!con) {
            l('Recieved data for unknown connection ' + opts.id);
            ack();
            return;
        }

        let line = opts.data.trim('\n\r');
        let msg = ircLineParser(line);
        if (!msg) {
            ack();
            return;
        }

        if (con instanceof ConnectionIncoming) {
            con.messageFromClient(msg, line);
        } else {
            con.messageFromUpstream(msg, line);
        }
        ack();
    });
}

// Start any listening servers on interfaces specified in the config, or any existing
// servers that were previously started outside of the config
async function startServers(app) {
    let existingBinds = await app.db.all('SELECT host, port FROM connections WHERE type = ?', [
        ConnectionDict.TYPE_LISTENING
    ]);
    let binds = app.conf.get('listeners.bind', []);

    for (let i = 0; i < binds.length; i++) {
        let parts = binds[i].split(':');
        let host = parts[0] || '0.0.0.0';
        let port = parseInt(parts[1] || '6667', 10);

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
    let types = ['OUTGOING', 'INCOMING', 'LISTENING'];
    rows.forEach(async (row) => {
        l(` connection ${row.conid} ${types[row.type]} ${row.host}:${row.port}`);
        /*
        let con = null;
        if (row.type === 0) {
            con = new ConnectionOutgoing(row.conid, app.db, app.messages, app.queue);
            con.trackInMap(app.cons);
            await con.state.maybeLoad();
            con.open();

        } else if (row.type === 1) {
            con = new ConnectionIncoming(row.conid, app.db, app.userDb, app.messages, app.queue);
            con.trackInMap(app.cons);
            await con.state.maybeLoad();

        } else
        */
        if (row.type === ConnectionDict.TYPE_INCOMING) {
            app.cons.loadFromId(row.conid, row.type);
        } else if (row.type === ConnectionDict.TYPE_OUTGOING) {
            let con = await app.cons.loadFromId(row.conid, row.type);            
            if (con.state.connected) {
                con.open();
            }
        } else if (row.type === ConnectionDict.TYPE_LISTENING) {
            app.queue.sendToSockets('connection.listen', {
                host: row.host,
                port: row.port,
                id: row.conid,
            });
            return;
        }
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
