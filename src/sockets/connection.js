const net = require('net');
const uuidv4 = require('uuid/v4');

module.exports = class SocketConnection {
    constructor(conId, queue, sock) {
        this.queue = queue;
        this.id = conId || uuidv4();
        this.buffer = [];
        this.readBuffer = '';

        if (sock) {
            this.sock = sock;
            this.connected = true;
        } else {
            this.sock = new net.Socket({allowHalfOpen: false});
            this.sock.setEncoding('utf8');
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
                this.forceWrite(data);
            });
        });
        this.sock.on('close', (withError) => {
            l.debug(`[end ${this.id}]`);
            this.connected = false;
            this.queue.sendToWorker('connection.close', {id: this.id, error: withError ? lastError : null});
        });
        this.sock.on('error', (err) => {
            lastError = err;
        });
        this.sock.on('data', (data) => {
            this.readBuffer += data;

            let lines = this.readBuffer.split('\n');
            if (lines[lines.length - 1] !== '') {
                this.readBuffer = lines.pop();
            } else {
                lines.pop();
                this.readBuffer = '';
            }
    
            lines.forEach((line) => {
                l.debug(`[in  ${this.id}]`, [line.trimEnd()]);
                this.queue.sendToWorker('connection.data', {id: this.id, data: line.trimEnd()});
            });            
        });
    }

    connect(host, port, tls) {
        l.info('connecting ' + this.id);
        this.sock.connect(port, host);
    }

    close() {
        this.sock.end();
    }

    write(data) {
        if (!this.connected) {
            this.buffer.push(data);
        } else {
            this.forceWrite(data);
        }
    }

    forceWrite(data) {
        l.debug(`[out ${this.id}]`, [data.trimEnd()]);
        this.sock.write(data);
    }
}
