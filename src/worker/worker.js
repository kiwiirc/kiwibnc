const fs = require('fs');
const uuidv4 = require('uuid/v4');
const { ircLineParser } = require('irc-framework');
const Koa = require('koa');
const koaStatic = require('koa-static');
const KoaRouter = require('@koa/router');
const KoaMount = require('koa-mount');
const koaBody = require('koa-body');
const MessageStores = require('./messagestores/');
const ConnectionOutgoing = require('./connectionoutgoing');
const ConnectionIncoming = require('./connectionincoming');
const ConnectionDict = require('./connectiondict');
const hooks = require('./hooks');
const { parseBindString } = require('../libs/helpers');

async function run() {
    let app = await require('../libs/bootstrap')('worker');
    await app.initQueue('worker');
    await app.initDatabase();
    global.config = app.conf;


    app.messages = new MessageStores(app.conf);
    await app.messages.init();

    // Container for all connection instances
    app.cons = new ConnectionDict(app.db, app.userDb, app.messages, app.queue);

    app.prepareShutdown = () => prepareShutdown(app);
    process.on('SIGQUIT', () => {
        app.prepareShutdown();
    });

    initWebserver(app);
    initExtensions(app);
    broadcastStats(app);
    listenToQueue(app);

    // Give some time for the queue to connect + sync up
    setTimeout(async () => {
        await startServers(app);
        loadConnections(app);
    }, 1000);

    return app;
}

async function initExtensions(app) {
    let extensions = app.conf.get('extensions.loaded') || [];
    extensions.forEach(async extName => {
        try {
            let extPath = (extName[0] === '.' || extName[0] === '/') ?
                app.conf.relativePath(extName) :
                `../extensions/${extName}/`;

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

function broadcastStats(app) {
    function broadcast() {
        app.stats.gauge('stats.connections', app.cons.map.size);

        let mem = process.memoryUsage();
        app.stats.gauge('stats.memoryheapused', mem.heapUsed);
        app.stats.gauge('stats.memoryheaptotal', mem.heapTotal);
        app.stats.gauge('stats.memoryrss', mem.rss);

        setTimeout(broadcast, 10000);
    }

    broadcast();
}

function prepareShutdown(app) {
    // This worker will get restarted by the sockets process automatically
    l.info('Gracefully shutting down...');
    app.queue.stopListening().then(process.exit);
}

function listenToQueue(app) {
    let cons = app.cons;
    app.queue.listenForEvents();

    app.queue.on('reset', async (event) => {
        l.info('Sockets server was reset, flushing all connections');

        // Wipe out all incoming connection states. Incoming connections need to manually reconnect
        await app.db.dbConnections.raw('DELETE FROM connections WHERE type = ?', [ConnectionDict.TYPE_INCOMING]);

        // Since there are now no incoming connections, clear all incoming<>outgoing links
        await app.db.dbConnections.raw('UPDATE connections SET linked_con_ids = "[]"');

        // If we don't have any connections then we have nothing to clear out. We do
        // need to start our servers again though
        if (cons.size === 0) {
            startServers(app);
            return;
        }

        app.prepareShutdown();
    });

    // When the socket layer accepts a new incoming connection
    app.queue.on('connection.new', async (event) => {
        // If we have an origin from a websocket, make sure we have it whitelisted
        let origins = app.conf.get('listeners.websocket_origins', []);
        if (origins && origins.length > 0 && event.origin) {
            let foundOrigin = origins.find(o => (
                o.toLowerCase() === event.origin.toLowerCase()
            ));

            if (!foundOrigin) {
                l.error('Incoming connection from unknown origin.', event.origin);
                app.queue.sendToSockets('connection.close', {id: event.id});
                return;
            }
        }

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
            await con.onUpstreamConnected();
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

// Start any listening servers on interfaces specified in the config
async function startServers(app) {
    // Close all existing listeners first
    app.queue.sendToSockets('listeners.closeall');

    let binds = app.conf.get('listeners.bind', []);
    for (let i = 0; i < binds.length; i++) {
        let parts = parseBindString(binds[i]);
        if (!parts) {
            l.error('Invalid listening server type, ' + binds[i]);
            return;
        }

        let host = parts.hostname || '0.0.0.0';
        let port = parseInt(parts.port || '6667', 10);
        let type = (parts.proto || 'tcp').toLowerCase();

        // Treat 'ssl' as an alias to 'tls'
        if (type === 'ssl') {
            type = 'tls';
        }

        let listenOpts = {
            host: host,
            port: port,
            type: type,
            id: uuidv4(),
        };

        // Add any TLS certs and keys
        if (type === 'tls') {
            let listeners = app.conf.get('listeners');
            if (!listeners.tls_key || !listeners.tls_cert) {
                l.error('A TLS listener requires the tls_key and tls_cert config options set');
                continue;
            }

            try {
                listenOpts.key = fs.readFileSync(app.conf.relativePath(listeners.tls_key), 'utf8');
                listenOpts.cert = fs.readFileSync(app.conf.relativePath(listeners.tls_cert), 'utf8');
            } catch (err) {
                l.error('Error reading TLS key or certifcate', err.message);
                continue;
            }

            if (!listenOpts.key || !listenOpts.cert) {
                l.error('A TLS listener requires a valid key and certificate');
                continue;
            }
        }

        app.queue.sendToSockets('connection.listen', listenOpts);
    }
}

async function loadConnections(app) {
    let rows = await app.db.dbConnections.raw('SELECT conid, type, bind_host FROM connections');
    l.info(`Loading ${rows.length} connections`);
    let types = ['OUTGOING', 'INCOMING', 'LISTENING'];
    rows.forEach(async (row) => {
        l.debug(`connection ${row.conid} ${types[row.type]} ${row.bind_host}`);

        if (row.type === ConnectionDict.TYPE_INCOMING) {
            app.cons.loadFromId(row.conid, row.type);
        } else if (row.type === ConnectionDict.TYPE_OUTGOING) {
            let con = await app.cons.loadFromId(row.conid, row.type);            
            if (con.state.connected) {
                con.open();
            }
        } else if (row.type === ConnectionDict.TYPE_LISTENING) {
            let parts = parseBindString(row.bind_host);
            if (!parts) {
                l.error('Invalid listening server type, ' + row.bind_host);
                return;
            }
            let host = parts.hostname || '0.0.0.0';
            let port = parseInt(parts.port || '6667', 10);
            let type = (parts.proto || 'tcp').toLowerCase();

            app.queue.sendToSockets('connection.listen', {
                host: host,
                port: port,
                type: type,
                id: row.conid,
            });
        }
    });
}

async function initWebserver(app) {
    let basePath = app.conf.get('webserver.base_path', '/')
        .replace(/\/$/, ''); // strip trailing slashes
    if (basePath && basePath[0] !== '/') {
        // Base path must always be absolute
        basePath = '/' + basePath;
    }

    app.webserver = new Koa();
    app.webserver.context.basePath = basePath;

	let router = app.webserver.router = new KoaRouter({
        prefix: basePath, 
    });

    app.webserver.use(koaBody({ multipart: true }));
    app.webserver.use(router.routes());
    app.webserver.use(router.allowedMethods());

    let staticServ = koaStatic(app.conf.relativePath(app.conf.get('webserver.public_dir', './public_http')));
    app.webserver.use(KoaMount(basePath || '/', staticServ));

    let sockPath = app.conf.get('webserver.bind_socket', '/tmp/kiwibnc_httpd.sock');
    if (app.conf.get('webserver.enabled') && sockPath) {  
        try {
            // Make sure the socket doesn't already exist
            fs.unlinkSync(sockPath);
        } catch (err) {
        }

        app.webserver.listen(sockPath);
        l.debug(`Webserver running`);
    }
}

module.exports = run();
