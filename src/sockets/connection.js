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
        this.connected = false;
        this.connecting = false;

        if (sock) {
            this.sock = sock;
            this.connected = true;
            this.socketLifecycle();
        }
    }

    socketLifecycle(tlsOpts) {
        let lastError = null;

        let completeConnection = () => {
            this.connected = true;
            this.connecting = false;
            lastError = null;
            this.sock.setEncoding('utf8');
            this.queue.sendToWorker('connection.open', {id: this.id});
            this.buffer.forEach((data)=> {
                this.forceWrite(data);
            });
        };

        let onClose = () => {
            l.debug(`[end ${this.id}]`);
            this.connected = false;
            this.queue.sendToWorker('connection.close', {
                id: this.id,
                error: lastError ? lastError.toString() : null,
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
                l.debug(`[in ${this.id}]`, [line.trimEnd()]);
                this.queue.sendToWorker('connection.data', {id: this.id, data: line.trimEnd()});
            });            
        };
        let onTimeout = () => {
            l.debug(`[timeout ${this.id}]`);
            lastError = new Error('Connection timeout');
            this.sock.destroy();
        };

        let bindEvents = () => {
            this.sock.on('close', onClose);
            this.sock.on('error', onError);
            this.sock.on('data', onData);
            this.sock.on('timeout', onTimeout);
        };
        let unbindEvents = () => {
            this.sock.off('close', onClose);
            this.sock.off('error', onError);
            this.sock.off('data', onData);
            this.sock.off('timeout', onTimeout);
        };

        // Bind the socket events before we connect so that we catch any end/close events
        bindEvents();
        this.sock.once('connect', () => {
            // We only use the timeout to determine connection timeouts so stop handling that now
            this.sock.off('timeout', onTimeout);

            // If we don't need any TLS handshakes, then this connection is done and
            // we are ready to go
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
        if (this.connecting || this.connected) {
            return;
        }

        l.info('connecting ' + this.id);

        this.connected = false;
        this.connecting = true;

        let sock = this.sock = new net.Socket({allowHalfOpen: false});
        let connectOpts = {
            port,
            host,
            localAddress: opts.bindAddress || undefined,
            localPort: opts.bindPort || undefined,
            family: opts.family || undefined,
        };

        sock.setTimeout(opts.connectTimeout || 5000);
        sock.connect(connectOpts);
        this.socketLifecycle(useTls ? { servername: opts.servername, tlsverify: opts.tlsverify } : null);
    }

    close() {
        if (this.sock) {
            this.sock.end();
        }
    }

    write(data) {
        if (!this.connected) {
            this.buffer.push(data);
        } else {
            this.forceWrite(data);
        }
    }

    forceWrite(data) {
        l.debug(`[out ${this.id}]`, [data]);
        this.sock.write(data, () => {
            l.trace(`[out ${this.id} complete]`);
        });
    }
}
