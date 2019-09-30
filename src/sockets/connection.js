const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');
const uuidv4 = require('uuid/v4');

module.exports = class SocketConnection extends EventEmitter {
    constructor(conId, queue, sock) {
        super();

        this.queue = queue;
        this.id = conId || uuidv4();
        this.type = 0;
        this.buffer = [];
        this.readBuffer = '';
        this.connectedEvent = 'connect';

        if (sock) {
            this.sock = sock;
            this.connected = true;
            this.socketLifecycle();
        }
    }

    socketLifecycle(tlsOpts) {
        let lastError;

        let completeConnection = () => {
            this.connected = true;
            this.sock.setEncoding('utf8');
            this.queue.sendToWorker('connection.open', {id: this.id});
            this.buffer.forEach((data)=> {
                this.forceWrite(data);
            });
        };

        let onClose = (withError) => {
            l.debug(`[end ${this.id}]`);
            this.connected = false;
            this.queue.sendToWorker('connection.close', {
                id: this.id,
                error: withError && lastError ? lastError.toString() : null,
            });
            this.emit('dispose');
        };
        let onError = (err) => {
            lastError = err;
        };
        let onData = (data) => {
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
        };

        let bindEvents = () => {
            this.sock.on('close', onClose);
            this.sock.on('error', onError);
            this.sock.on('data', onData);
        };
        let unbindEvents = () => {
            this.sock.off('close', onClose);
            this.sock.off('error', onError);
            this.sock.off('data', onData);
        };

        // Bind the socket events before we connect so that we catch any end/close events
        bindEvents();
        this.sock.once('connect', () => {
            if (!tlsOpts) {
                completeConnection();
                return;
            }

            // Override the existing socket with the new TLS wrapped socket
            unbindEvents();
            this.sock = tls.connect({
                socket: this.sock,
                servername: tlsOpts.servername || undefined,
                rejectUnauthorized: tlsOpts.tlsverify
            });

            bindEvents();
            this.sock.once('secureConnect', () => {
                completeConnection();
            });
        });
    }

    connect(host, port, useTls, opts={}) {
        l.info('connecting ' + this.id);

        this.connected = false;

        let sock = this.sock = new net.Socket({allowHalfOpen: false});
        let connectOpts = {
            port,
            host,
            localAddress: opts.bindAddress || undefined,
            localPort: opts.bindPort || undefined,
            family: opts.family || undefined,
        };

        sock.connect(connectOpts);
        this.socketLifecycle(useTls ? { servername: opts.servername, tlsverify: opts.tlsverify } : null);
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
