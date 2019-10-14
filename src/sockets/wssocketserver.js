const WebSocket = require('ws');
const { EventEmitter } = require('events');

module.exports = class WsSocketServer extends EventEmitter {
    constructor(conId, queue) {
        super();
        this.queue = queue;
        this.id = conId;
        this.type = 3;
        this.server = null;

        this.bindSocketEvents();
    }

    bindSocketEvents() {
        this.server.on('connection', (socket) => {
            socket.on('message', m => socket.emit('data', m + '\n'));
            socket.write = socket.send;
            this.emit('connection.new', socket);
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
        this.server = new WebSocket.Server({port, host});
        l.info(`WebSocket server listening on ${host}:${port} ${this.id}`);
        this.bindSocketEvents();
    }

    close() {
        this.server.close();
    }
}
