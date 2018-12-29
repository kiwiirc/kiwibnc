const uuidv4 = require('uuid/v4');
const SocketConnection = require('./connection');
const SocketServer = require('./socketserver');
const Throttler = require('../libs/throttler');

// Wrapper around a connections connect() function so that connections to the
// same host:port combo are throttled
async function throttledConnect(throttle, connection, host, port, tls) {
    let key = host.toLowerCase() + ':' + port.toString();
    await throttle.waitUntilReady(key);
    connection.connect(host, port, tls);
}

async function run() {
    let app = await require('../libs/bootstrap')('sockets');

    let cons = new Map();
    let connectThrottler = new Throttler(app.conf.get('connections.throttle', 1000));

    // Tell the worker that we're starting up. All connections should be purged
    app.queue.sendToWorker('reset', {reason: 'startup'});

    app.queue.listenForEvents(app.queue.queueToSockets);

    app.queue.on('connection.data', (opts) => {
        l('connection.data', opts);
        let con = cons.get(opts.id);
        if (!con) {
            l('Couldn\'t find connection to send data to.', opts.id);
            return;
        }
        con.write(opts.data);
    });

    app.queue.on('connection.open', (opts) => {
        if (cons.has(opts.id)) {
            // A connection can only be open once.
            // This also prevents a worker from restarting and syncing its connection states,
            // which may request socket opens when they already exist
            l('Connection already open, ignoring');
            return;
        }

        let con = new SocketConnection(opts.id, app.queue);
        cons.set(opts.id, con);
        throttledConnect(connectThrottler, con, opts.host, opts.port, opts.tls);
    });

    app.queue.on('connection.close', (opts) => {
        let con = cons.get(opts.id);
        if (!con) {
            return;
        }
        con.close();
        cons.delete(opts.id);
    });

    app.queue.on('connection.listen', (opts) => {
        if (cons.has(opts.id)) {
            // A connection can only be open once.
            // This also prevents a worker from restarting and syncing its connection states,
            // which may request socket opens when they already exist
            l('Connection already open, ignoring');
            return;
        }

        let srv = new SocketServer(opts.id, app.queue);
        cons.set(opts.id, srv);
        srv.listen(opts.host, opts.port || 0);

        srv.on('connection.new', (socket) => {
            let newId = uuidv4();
            let con = new SocketConnection(newId, app.queue, socket);
            cons.set(newId, con);
            app.queue.sendToWorker('connection.new', {
                id: con.id,
                host: socket.remoteAddress,
                port: socket.remotePort,
                family: socket.remoteFamily,
                server: srv.id,
            });
        });
    });
}

module.exports = run();
