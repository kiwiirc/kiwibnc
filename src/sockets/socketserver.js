const net = require('net');
const { EventEmitter } = require('events');
const http = require('http');
const WebSocket = require('ws');

module.exports = class SocketServer extends EventEmitter {
    constructor(conId, queue) {
        super();
        this.queue = queue;
        this.id = conId;
        this.type = 3;
        this.server = new net.Server({allowHalfOpen: false});

        this.bindSocketEvents();
    }

    bindSocketEvents() {
        // We need a HTTP server for the WebSocket server to bind on as we can pass a TCP
        // connection to the HTTP server but not the WebSocket server directly.
        let httpd = http.createServer();
        let wsServ = new WebSocket.Server({server: httpd});
        let socketTypes = new SocketTypeChecker();

        wsServ.on('connection', (socket, req) => {
            // The websocket connection ready to be used. Patch it to match TCP connection
            // events and functions
            patchWebsocket(socket, req);
            this.emit('connection.new', socket);
        });

        socketTypes.on('socket', (socket) => {
            // Plain TCP socket detected
            this.emit('connection.new', socket);
        });

        socketTypes.on('ws', (socket) => {
            // TCP socket containing websocket headers, pass it through the httpd
            // so it can parse it and trigger any wsServ events for a real websocket instance
            httpd.emit('connection', socket);
        });

        this.server.on('connection', (socket) => {
            // A TCP socket. Pass it to socketTypes to determine if it contains websocket headers
            // or not.
            socketTypes.determine(socket);
        });

        this.server.on('close', (withError) => {
            this.queue.sendToWorker('connection.close', {id: this.id, error: withError ? lastError : null});
        });
        this.server.on('error', (err) => {
            this.queue.sendToWorker('connection.error', {id: this.id, error: err});
            this.server.close();
        });
        this.server.on('listening', (err) => {
            this.queue.sendToWorker('connection.listening', {id: this.id, address: this.server.address()});
        });
    }

    listen(host, port) {
        l.info(`listening on ${host}:${port} ${this.id}`);
        this.server.listen(port, host);
    }

    close() {
        this.server.close();
    }
}

function patchWebsocket(ws, req) {
    // Route some events and alias some methods to match what a connection instance expects
    ws.on('message', m => ws.emit('data', m + '\n'));
    ws.write = ws.send;
    ws.end = ws.close;

    ws.remoteAddress = req.connection.remoteAddress;
    ws.remotePort = req.connection.remotePort;
    ws.remoteFamily = req.connection.remoteFamily;
    ws.httpOrigin = req.headers['origin'];
}

class SocketTypeChecker extends EventEmitter {
    constructor() {
        super();
    }

    determine(socket) {
        let onData = (data) => {
            clean();

            let str = data.toString().toUpperCase();
            if (str.startsWith('GET')) {
                this.emit('ws', socket);
                socket.emit('data', data);
            } else {
                this.emit('socket', socket);
                socket.emit('data', data);
            }
        };

        let clean = () => {
            socket.off('data', onData);
            socket.off('close', clean);
        };

        socket.on('data', onData);
        socket.on('close', clean);
    }
}
