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

    app.queue.on('connection.data', async (event) => {
        let con = cons.get(event.id);
        if (!con) {
            l.warn('Couldn\'t find connection to send data to.', event.id);
        } else {
            con.write(event.data);
        }
    });

    app.queue.on('connection.open', async (event) => {
        let con = cons.get(event.id);
        if (con && con.connected) {
            // A connection can only be open once.
            // This also prevents a worker from restarting and syncing its connection states,
            // which may request socket opens when they already exist
            l.notice('Connection already open, ignoring');
            return;
        }

        if (!event.host || !event.port) {
            l.error('Missing hort or port for connection.open');
            return;
        }

        if (!con) {
            con = new SocketConnection(event.id, app.queue);
            cons.set(event.id, con);
        }

        throttledConnect(connectThrottler, con, event.host, event.port, event.tls);
    });

    app.queue.on('connection.close', async (event) => {
        let con = cons.get(event.id);
        if (!con) {
            return;
        }
        con.close();
        cons.delete(event.id);
    });

    app.queue.on('connection.listen', (event) => {
        if (cons.has(event.id)) {
            // A connection can only be open once.
            // This also prevents a worker from restarting and syncing its connection states,
            // which may request socket opens when they already exist
            l.notice('Connection already open, ignoring');
            return;
        }

        if (!event.host || !event.port) {
            l.error('Missing hort or port for connection.listen');
            return;
        }

        let srv = new SocketServer(event.id, app.queue);
        cons.set(event.id, srv);
        srv.listen(event.host, event.port || 0);

        srv.on('connection.new', (socket) => {
            let con = new SocketConnection(null, app.queue, socket);
            cons.set(con.id, con);
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
