const fs = require('fs');
const uuidv4 = require('uuid/v4');
const { ircLineParser } = require('irc-framework');
const Koa = require('koa');
const koaStatic = require('koa-static');
const KoaRouter = require('@koa/router');
const KoaMount = require('koa-mount');
const koaBody = require('koa-body');
const IpCidr = require("ip-cidr");
const MessageStores = require('./messagestores/');
const ConnectionOutgoing = require('./connectionoutgoing');
const ConnectionIncoming = require('./connectionincoming');
const ConnectionDict = require('./connectiondict');
const hooks = require('./hooks');
const { parseBindString, now } = require('../libs/helpers');

async function run() {
    let app = await require('../libs/bootstrap')('worker');
    await app.initQueue('worker');
    app.queue.sendToSockets('config.reload');
    global.config = app.conf;

    try {
        await initDatabase(app);
    } catch (err) {
        l.error('Error connecting to the database.', err.message);
        process.exit(1);
    }

    app.messages = new MessageStores(app.conf);
    await app.messages.init();

    // Container for all connection instances
    app.cons = new ConnectionDict(app.db, app.userDb, app.messages, app.queue);

    app.prepareShutdown = () => prepareShutdown(app);
    process.on('SIGQUIT', () => {
        app.prepareShutdown();
    });

    // process.send only exists if we were forked from the sockets layer. Hijack SIGINT so
    // that ctrl+c in kiwibnc doesn't do anything to us. Sockets layer will send SIGQUIT to
    // us if needed.
    if (process.send) {
        process.on('SIGINT', () => {
            // noop
        });
    }


    initWebserver(app);
    initStatus(app);
    await initExtensions(app);
    broadcastStats(app);
    await startServers(app);
    await loadConnections(app);

    // Now that all the connection states have been laoded, start accepting events for them
    listenToQueue(app);

    return app;
}

async function initExtensions(app) {
    let extensions = app.conf.get('extensions.loaded') || [];
    for(let i=0; i<extensions.length; i++){
        let extName = extensions[i];
        try {
            let extPath = (extName[0] === '.' || extName[0] === '/') ?
                app.conf.relativePath(extName) :
                `../extensions/${extName}/`;

            l.info('Loading extension ' + extPath);
            let ext = require(extPath);
            if (ext && typeof ext.init === 'function') {
                await ext.init(hooks, app);
            }
        } catch (err) {
            l.error('Error loading extension ' + extName + ': ', err.stack);
        }
    }

    // Extensions can add their hooks before the builtin hooks so that they have
    // a chance to override any if they need
    hooks.addBuiltInHooks();
};

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

async function prepareShutdown(app) {
    // This worker will get restarted by the sockets process automatically
    l.info('Gracefully shutting down...');
    await app.queue.stopListening();
    process.exit();
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
    app.queue.on('connection.error', async (event) => {
        l.error(`Server error ${event.id} ${event.error.message}`);
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

        let msg = ircLineParser(event.data);
        if (!msg) {
            let snippet = event.data.substr(0, 300);
            if (event.data.length > 300) {
                snippet += '...';
            }
            l.warn('Recieved malformed IRC line from connection ' + event.id + ' - ' + snippet);
            return;
        }

        if (con instanceof ConnectionIncoming) {
            await con.messageFromClient(msg, event.data);
        } else {
            await con.messageFromUpstream(msg, event.data);
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

// Connect to the database, logging warnings if it takes too long
async function initDatabase(app) {
    let dbConnectTmr = setInterval(() => {
        l.warn('Waiting for the database connection...');
    }, 5000);

    try {
        await app.initDatabase();
        clearInterval(dbConnectTmr);
    } catch (err) {
        clearInterval(dbConnectTmr);
        throw err;
    }
}

async function initWebserver(app) {
    let basePath = app.conf.get('webserver.base_path', '/')
        .replace(/\/$/, ''); // strip trailing slashes
    if (basePath && basePath[0] !== '/') {
        // Base path must always be absolute
        basePath = '/' + basePath;
    }

    app.webserver = new Koa();
    app.webserver.proxy = true;
    app.webserver.context.basePath = basePath;

    app.webserver.on('error', (error) => {
        if (error.code === 'EPIPE' || error.code === 'ECONNRESET') {
            // These errors are expected as clients always disconnect at random times before
            // waiting for a response, or general network issues
            return;
        } else {
            l.error('Webserver error', error);
        }
    });

    let router = app.webserver.router = new KoaRouter({
        prefix: basePath,
    });

    app.webserver.use(koaBody({ multipart: true }));
    app.webserver.use(router.routes());
    app.webserver.use(router.allowedMethods());

    let staticServ = koaStatic(app.conf.relativePath(app.conf.get('webserver.public_dir', './public_http')));
    app.webserver.use(KoaMount(basePath || '/', staticServ));

    const defaultSockPath = process.platform === "win32" ?
        '\\\\.\\pipe\\kiwibnc_httpd.sock' :
        '/tmp/kiwibnc_httpd.sock';
    let sockPath = app.conf.get('webserver.bind_socket', defaultSockPath);

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

async function initStatus(app) {
    if (!app.conf.get('webserver.status_enabled', true)) {
        return;
    }

    // Trim any trailing slashes from the status URL path
    const statusPath = app.conf.get('webserver.status_path', '/status').replace(/\/$/, '');
    const router = app.webserver.router;

    router.get('status', statusPath, statusAuth, async (ctx) => {
        ctx.body = '<a href="connections">Connections</a>';
    });

    router.get('status', statusPath + '/connections', statusAuth, async (ctx) => {
        const cons = app.cons;
        const conTypes = ['outgoing', 'incoming', 'server'];
        ctx.response.body = '';
        cons.map.forEach((con, key) => {
            const columns = [];
            columns.push(key);
            columns.push(conTypes[con.state.type]);
            columns.push(con.state.host + ':' + con.state.port);
            columns.push(con.state.authUserId);
            ctx.response.body += columns.join(',') + '\n';
        });

        ctx.response.status = 200;
    });

    router.get('status.con', statusPath + '/connections/:con_id', statusAuth, async (ctx) => {
        const cons = app.cons;
        const con = cons.get(ctx.params.con_id);
        if (!con) {
            ctx.response.status = 404;
            return;
        }

        const ignoreKeys = ['db'];
        const lastKeys = ['isupports', 'registrationLines'];
        const data = Object.create(null);
        Object.entries(con.state).forEach(([k, v]) => {
            if (ignoreKeys.includes(k)) {
                return;
            }
            if (k === 'sasl') {
                data.sasl = {}
                data.sasl.account = v.account;
                // Don't reveal the password, just a bool if there is one
                data.sasl.password = v.password !== '';
                return;
            }
            if (k === 'password') {
                // Don't reveal the password, just a bool if there is one
                data.password = v !== '';
                return;
            }
            data[k] = v;
        });

        ctx.response.body = JSON.stringify(data, Object.keys(data).sort(
            // Sort so lastKeys are at the end to make it more user readable
            (a, b) => {
                if (lastKeys.includes(a) && lastKeys.includes(b)) {
                    return lastKeys.indexOf(a) > lastKeys.indexOf(b) ? 1 : -1;
                }
                if (lastKeys.includes(a)) {
                    return 1;
                }
                if (lastKeys.includes(b)) {
                    return -1;
                }
                return a.localeCompare(b);
            }
        ), 4);
        ctx.response.status = 200;
    });
}

async function statusAuth(ctx, next, role, redirect) {
    const allowed = global.config.get('webserver.status_allowed_hosts', ['127.0.0.1/8']);

    for (let i = 0; i < allowed.length; i++) {
        const cidr = new IpCidr(allowed[i]);
        if (!cidr.isValid()) {
            l.error('CIDR is invalid:', allowed[i]);
            continue;
        }
        if (cidr.contains(ctx.ip)) {
            return await next();
        }
    }
    ctx.response.status = 401;
}

module.exports = run();
