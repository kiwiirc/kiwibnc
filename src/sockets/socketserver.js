const net = require('net');
const { EventEmitter } = require('events');

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
        this.server.on('connection', (socket) => {
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
        l.info(`listening on ${host}:${port} ${this.id}`);
        this.server.listen(port, host);
    }

    close() {
        this.server.close();
    }
}
