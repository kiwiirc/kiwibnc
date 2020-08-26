const SocketServer = require('../../src/sockets/socketserver');

const server = new SocketServer(null, null, {
    get: (key, def) => {
        return def;
    },
});

describe('sockets/socketserver.js', () => {
    it('should correctly set X-Forward-* headers', () => {
        // PROXY WITH HEADERS (VIA 127.0.0.1)
        expect(
            server.buildXHeaders({
                isSpdy: undefined,
                socket: {
                    remoteAddress: '127.0.0.1',
                },
                connection: {
                    remoteAddress: '127.0.0.1',
                    encrypted: undefined,
                    pair: undefined,
                    localPort: 80,
                },
                headers: {
                    host: '127.0.0.1',
                    'x-forwarded-for': '172.28.192.1',
                    'x-forwarded-host': 'testpc',
                    'x-forwarded-port': '3564',
                    'x-forwarded-proto': 'http',
                }
            })
        ).toEqual({
            'X-Forwarded-For': '172.28.192.1,127.0.0.1',
            'X-Forwarded-Host': 'testpc',
            'X-Forwarded-Port': '3564,80',
            'X-Forwarded-Proto': 'http,http',
        });

        // PROXY WITHOUT HEADERS (VIA 127.0.0.1)
        expect(
            server.buildXHeaders({
                isSpdy: undefined,
                socket: {
                    remoteAddress: '127.0.0.1',
                },
                connection: {
                    remoteAddress: '127.0.0.1',
                    encrypted: undefined,
                    pair: undefined,
                    localPort: 80,
                },
                headers: {
                    host: '127.0.0.1',
                    'x-forwarded-for': undefined,
                    'x-forwarded-host': undefined,
                    'x-forwarded-port': undefined,
                    'x-forwarded-proto': undefined,
                }
            })
        ).toEqual({
            'X-Forwarded-For': '0.0.0.0',
        });

        // DIRECT 127.0.0.1
        expect(
            server.buildXHeaders({
                isSpdy: undefined,
                socket: {
                    remoteAddress: '127.0.0.1',
                },
                connection: {
                    remoteAddress: '127.0.0.1',
                    encrypted: undefined,
                    pair: undefined,
                    localPort: 80,
                },
                headers: {
                    host: '127.0.0.1',
                    'x-forwarded-for': undefined,
                    'x-forwarded-host': undefined,
                    'x-forwarded-port': undefined,
                    'x-forwarded-proto': undefined,
                }
            })
        ).toEqual({
            'X-Forwarded-For': '0.0.0.0',
        });

        // DIRECT testpc
        expect(
            server.buildXHeaders({
                isSpdy: undefined,
                socket: {
                    remoteAddress: '172.28.192.1',
                },
                connection: {
                    remoteAddress: '172.28.192.1',
                    encrypted: undefined,
                    pair: undefined,
                    localPort: 80,
                },
                headers: {
                    host: 'testpc',
                    'x-forwarded-for': undefined,
                    'x-forwarded-host': undefined,
                    'x-forwarded-port': undefined,
                    'x-forwarded-proto': undefined,
                }
            })
        ).toEqual({
            'X-Forwarded-For': '172.28.192.1',
            'X-Forwarded-Host': 'testpc',
            'X-Forwarded-Port': 80,
            'X-Forwarded-Proto': 'http'
        });
    });
});