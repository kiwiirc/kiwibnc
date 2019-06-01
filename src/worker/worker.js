const path = require('path');
const uuidv4 = require('uuid/v4');
const { ircLineParser } = require('irc-framework');
const Database = require('../libs/database');
const Crypt = require('../libs/crypt');
const Users = require('./users');
const MessageStore = require('./messagestores/sqlite');
const ConnectionOutgoing = require('./connectionoutgoing');
const ConnectionIncoming = require('./connectionincoming');
const ConnectionDict = require('./connectiondict');
const hooks = require('./hooks');

async function run() {
    let app = await require('../libs/bootstrap')('worker');

    let cryptKey = app.conf.get('database.crypt_key', '');
    if (cryptKey.length !== 32) {
        console.error('Cannot start: config option database.crypt_key must be 32 characters long');
        process.exit();
    }
    app.crypt = new Crypt(cryptKey);

    app.db = new Database(app.conf.get('database.path', './connections.db'));
    await app.db.init();

    initModelFactories(app);

    app.userDb = new Users(app.db);

    app.messages = new MessageStore(app.conf.get('messages', {}));
    await app.messages.init();

    // Container for all connection instances
    app.cons = new ConnectionDict(app.db, app.userDb, app.messages, app.queue);

    initExtensions(app);
    listenToQueue(app);

    // Give some time for the queue to connect + sync up
    setTimeout(async () => {
        await startServers(app);
        loadConnections(app);
    }, 1000);
}

async function initExtensions(app) {
    let extensions = app.conf.get('extensions.loaded') || [];
    extensions.forEach(async extName => {
        try {
            let extPath = (extName[0] === '.' || extName[0] === '/') ?
                path.join(app.conf.baseDir, extName) :
                `./extensions/${extName}/`;

            l.info('Loading extension ' + extPath);
            let ext = require(extPath);
            await ext.init(hooks, app);
        } catch (err) {
            l.error('Error loading extension ' + extName + ': ', err.stack);
        }
    });

    // Extensions can add their hooks before the builtin hooks so that they have
    // a chance to override any if they need
    hooks.addBuiltInHooks();
};

function initModelFactories(app) {
    app.db.factories.Network = require('../libs/dataModels/network').factory(app.db, app.crypt);
    app.db.factories.User = require('../libs/dataModels/user').factory(app.db);
}

function listenToQueue(app) {
    let cons = app.cons;
    app.queue.listenForEvents(app.queue.queueToWorker);

    app.queue.on('reset', async (event) => {
        // Wipe out all incoming connection states. Incoming connections need to manually reconnect
        await app.db.run('DELETE FROM connections WHERE type = ?', [ConnectionDict.TYPE_INCOMING]);
        await app.db.run('UPDATE connections SET linked_con_ids = "[]"');

        // If we don't have any connections then we don't need to clear anything out. We do
        // need to start our servers again though
        if (cons.size === 0) {
            startServers(app);
            return;
        }

        // Give some time for the queue to process some internal stuff
        app.queue.stopListening().then(async () => {
            setTimeout(() => {
                process.exit();
            }, 2000);
        });
    });

    // When the socket layer accepts a new incoming connection
    app.queue.on('connection.new', async (event) => {
        l.debug('New incoming connection', event.id);
        let c = await app.cons.loadFromId(event.id, ConnectionDict.TYPE_INCOMING);
        c.state.host = event.host;
        c.state.port = event.port;

        try {
            await c.state.save();
        } catch (err) {
            l.error('Error saving incoming connection.', err.message);
            app.queue.sendToSockets('connection.close', {id: c.id});
            c.destroy();
            return;
        }

        await c.onAccepted();
    });

    // When the socket layer has opened a new outgoing connection
    app.queue.on('connection.open', async (event) => {
        let con = cons.get(event.id);
        if (con) {
            con.onUpstreamConnected();
        }
    });
    app.queue.on('connection.close', async (event) => {
        if (event.error) {
            l.debug(`Connection ${event.id} closed. Error: ${event.error.code}`);
        } else {
            l.debug(`Connection ${event.id} closed.`);
        }

        let con = cons.get(event.id);
        if (con && con instanceof ConnectionOutgoing) {
            await con.onUpstreamClosed(event.error);
        } else if (con && con instanceof ConnectionIncoming) {
            await con.onClientClosed(event.error);
        }
    });
    app.queue.on('connection.data', async (event) => {
        let con = cons.get(event.id);
        if (!con) {
            l.warn('Recieved data for unknown connection ' + event.id);
            return;
        }

        let line = event.data.trim('\n\r');
        let msg = ircLineParser(line);
        if (!msg) {
            return;
        }

        if (con instanceof ConnectionIncoming) {
            await con.messageFromClient(msg, line);
        } else {
            await con.messageFromUpstream(msg, line);
        }
    });
}

// Start any listening servers on interfaces specified in the config if they do not
// exist as an active connection already
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
    l.info(`Loading ${rows.length} connections`);
    let types = ['OUTGOING', 'INCOMING', 'LISTENING'];
    rows.forEach(async (row) => {
        l.debug(`connection ${row.conid} ${types[row.type]} ${row.host}:${row.port}`);

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
        }
    });
}

module.exports = run();
