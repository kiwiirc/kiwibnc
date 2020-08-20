const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');
const http = require('http');
const httpProxy = require('http-proxy');
const WebSocket = require('ws');

module.exports = class SocketServer extends EventEmitter {
    constructor(conId, queue, conf) {
        super();
        this.queue = queue;
        this.appConfig = conf;
        this.id = conId;
        this.type = 3;
        this.server = null;
    }

    bindSocketEvents() {
        // We need a HTTP server for the WebSocket server to bind on as we can pass a TCP
        // connection to the HTTP server but not the WebSocket server directly.
        let httpd = http.createServer((request, response) => {
            const defaultSockPath = process.platform === "win32" ?
                '\\\\.\\pipe\\kiwibnc_httpd.sock' :
                '/tmp/kiwibnc_httpd.sock';

            let sockPath = this.appConfig.get('webserver.bind_socket', defaultSockPath);
            if (!this.appConfig.get('webserver.enabled') || !sockPath) {
                return;
            }

            proxy.on('proxyReq', (proxyReq, req, res, options) => {
                proxyReq.setHeader('X-Forwarded-For', req.connection.remoteAddress || req.socket.remoteAddress || '');
                proxyReq.setHeader('X-Forwarded-Host', req.headers.host || '');
                proxyReq.setHeader('X-Forwarded-Port',
                    req.connection.localPort || req.headers.host ? (req.headers.host.split(':')[1] || '') : ''
                );
                proxyReq.setHeader('X-Forwarded-Proto',
                    (req.isSpdy || req.connection.encrypted || req.connection.pair) ? 'https' : 'http'
                );
            });

            // Reverse proxy this HTTP request to the unix socket where the worker
            // process will pick it up and handle
            proxy.web(request, response, {
                proxyTimeout: 5000,
                timeout: 5000,
                target: {
                    socketPath: sockPath
                },
            });
        });
        let proxy = httpProxy.createProxyServer({});
        let wsServ = new WebSocket.Server({server: httpd});
        let socketTypes = new SocketTypeChecker();

        // Ignore errors. Just listen for them so the BNC process doesn't crash
        proxy.on('error', () => {});

        wsServ.on('connection', (socket, req) => {
            socket.on('error', (err) => {
                // Just capture any rogue socket errors so that they don't bubble up to the process.
            });

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

        socketTypes.on('http', (socket) => {
            // HTTP socket but not a websocket. Pass it to the httpd to handle
            httpd.emit('connection', socket);
        });

        // server.setTicketKeys is only available on a TLS server, so we can use it to check
        // if this is a TLS or plaintext server
        let socketConnectEventName = this.server.setTicketKeys ?
            'secureConnection' :
            'connection';
        this.server.on(socketConnectEventName, (socket) => {
            socket.on('error', (err) => {
                // Just capture any rogue socket errors so that they don't bubble up to the process.
                // WebSocket/http/ws will handle errors where needed and do any cleanup
            });

            // Pass the TCP socket to socketTypes to determine if it contains websocket headers
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

    listen(host, port, tlsOpts={}) {
        if (this.server) {
            this.server.removeAllListeners();
        }

        if (!tlsOpts.cert) {
            this.server = new net.Server({allowHalfOpen: false});
        } else {
            this.server = tls.createServer({
                key: tlsOpts.key,
                cert: tlsOpts.cert,
            });
        }

        this.bindSocketEvents();

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
        let buf = Buffer.alloc(0);
        let isHttp = false;
        let httpVerbs = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH'];
        // We need the minimum amount of data of [longest HTTP verb + " "] length to determine the type of traffic
        let minBufSizeNeeded = httpVerbs.reduce((accum, currentVal) => Math.max(accum, currentVal.length), 0) + 1;

        let isHttpData = dataStr => {
            let verb = dataStr.substr(0, dataStr.indexOf(' '));
            if (!verb) {
                return false;
            }

            return httpVerbs.includes(verb.toUpperCase());
        };

        let checkHttpData = str => {
            if (!str.includes('\r\n\r\n')) {
                // Keep waiting for all the headers to arrive
                return;
            }

            if (str.includes('UPGRADE: WEBSOCKET') && str.includes('CONNECTION: UPGRADE')) {
                // A websocket connection
                clean();
                this.emit('ws', socket);
                socket.emit('data', buf);
            } else {
                // HTTP request, but not websocket. We don't accept these.
                clean();
                this.emit('http', socket);
                socket.emit('data', buf);
            }
        };

        let onData = (rawData) => {
            buf = Buffer.concat([buf, rawData], buf.length + rawData.length);
            if (!isHttp && buf.length < minBufSizeNeeded) {
                return;
            }

            let str = buf.toString().toUpperCase();
            if (isHttp) {
                // We already determined that this is HTTP traffic, now just waiting for headers
                // too arrive so that we can check for any Upgrade header
                checkHttpData(str)
            } else if (isHttpData(str)) {
                // Now we know the data is HTTP, mark is so that we can keep collecting its headers
                // for further checks.
                isHttp = true;
                checkHttpData(str);
            } else {
                // Not HTTP, treat it as a plain socket. Probably an IRC client
                clean();
                this.emit('socket', socket);
                socket.emit('data', buf);
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
