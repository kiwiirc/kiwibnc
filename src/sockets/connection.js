const net = require('net');

module.exports = class SocketConnection {
    constructor(conId, queue, sock) {
        this.queue = queue;
        this.id = conId;
        this.buffer = [];
        this.readBuffer = '';

        if (sock) {
            this.sock = sock;
            this.connected = true;
        } else {
            this.sock = new net.Socket({allowHalfOpen: false});
            this.connected = false;
        }

        this.bindSocketEvents();
    }

    bindSocketEvents() {
        let lastError;

        this.sock.on('connect', () => {
            this.connected = true;
            this.queue.sendToWorker('connection.open', {id: this.id});
            this.buffer.forEach((data)=> {
                this.sock.write(data);
            });
        });
        this.sock.on('close', (withError) => {
            this.connected = false;
            this.queue.sendToWorker('connection.close', {id: this.id, error: withError ? lastError : null});
        });
        this.sock.on('error', (err) => {
            lastError = err;
        });
        this.sock.on('data', (data) => {
            this.readBuffer += data;

            var lines = this.readBuffer.split('\n');
            if (lines[lines.length - 1] !== '') {
                this.readBuffer = lines.pop();
            } else {
                lines.pop();
                this.readBuffer = '';
            }
    
            lines.forEach((line) => {
                this.queue.sendToWorker('connection.data', {id: this.id, data: line});
            });            
        });
    }

    connect(host, port, tls) {
        l('connecting ' + this.id);
        this.sock.connect(port, host);
    }

    close() {
        this.sock.end();
    }

    write(data) {
        if (!this.connected) {
            this.buffer.push(data);
        } else {
            this.sock.write(data);
        }
    }
}
