const SocketServer = require('../../src/sockets/socketserver');

const server = new SocketServer(null, null, {
    get: (key, def) => {
        return def;
    },
});

function mockRequest(remoteAddr, url, headers={}) {
    const m = url.match(/^(?<scheme>https?):\/\/(?<host>(?<hostname>[^:/]+)(:(?<port>[^/]+))?)(?<path>.+)?$/i);
    if (!m) {
        throw new Error('Invalid url for mock request');
    }

    const hostname = m.groups.hostname || '';
    const host = m.groups.host || '';
    const scheme = m.groups.scheme || 'http';
    const port = parseInt(m.groups.port || (scheme === 'https' ? '443' : '80'), 10)
    const path = m.groups.path || '/';

    return {
        isSpdy: undefined,
        socket: {
            remoteAddress: remoteAddr,
        },
        connection: {
            remoteAddress: remoteAddr,
            encrypted: scheme === 'https',
            pair: undefined,
            localPort: String(port),
        },
        headers: {
            host: (port === 80 || port === 443) ? host : hostname,
            ...headers,
        }
    };
}

describe('sockets/socketserver.js', () => {
    it('should correctly set X-Forward-* headers', () => {
        // browser > proxy[127.0.0.1, sets x-* headers] > kiwibnc
        expect(
            server.buildXHeaders(mockRequest('127.0.0.1', 'http://kiwibnc.com/', {
                'x-forwarded-for': '172.28.192.1',
                'x-forwarded-host': 'kiwibnc.com',
                'x-forwarded-port': '3564',
                'x-forwarded-proto': 'http',
            }))
        ).toEqual({
            'X-Forwarded-For': '172.28.192.1, 127.0.0.1',
            'X-Forwarded-Host': 'kiwibnc.com',
            'X-Forwarded-Port': '3564',
            'X-Forwarded-Proto': 'http',
        });

        // browser[127.0.0.1] > kiwibnc[127.0.0.1]
        expect(
            server.buildXHeaders(mockRequest('127.0.0.1', 'http://127.0.0.1/'))
        ).toEqual({
            'X-Forwarded-For': '0.0.0.0',
        });

        // browser > proxy[127.0.0.2, within whitelisted cidr range] > kiwibnc
        expect(
            server.buildXHeaders(mockRequest('127.0.0.20', 'http://kiwibnc.com/', {
                'x-forwarded-for': '172.28.192.1',
                'x-forwarded-host': 'kiwibnc.com',
                'x-forwarded-port': '3564',
                'x-forwarded-proto': 'http',
            }))
        ).toEqual({
            'X-Forwarded-For': '172.28.192.1, 127.0.0.20',
            'X-Forwarded-Host': 'kiwibnc.com',
            'X-Forwarded-Port': '3564',
            'X-Forwarded-Proto': 'http',
        });

        // browser[172.28.192.1] > kiwibnc
        expect(
            server.buildXHeaders(mockRequest('172.28.192.1', 'http://kiwibnc.com/'))
        ).toEqual({
            'X-Forwarded-For': '172.28.192.1',
            'X-Forwarded-Host': 'kiwibnc.com',
            'X-Forwarded-Port': '80',
            'X-Forwarded-Proto': 'http'
        });

        // browser[172.28.192.1, spoofed headers] > kiwibnc
        expect(
            server.buildXHeaders(mockRequest('172.28.192.1', 'http://kiwibnc.com/', {
                'X-Forwarded-For': '1.1.1.1',
                'X-Forwarded-Host': 'spoofed.com',
                'X-Forwarded-Proto': 'https'
            }))
        ).toEqual({
            'X-Forwarded-For': '172.28.192.1',
            'X-Forwarded-Host': 'kiwibnc.com',
            'X-Forwarded-Port': '80',
            'X-Forwarded-Proto': 'http'
        });

        // browser[172.28.192.1, https] > kiwibnc
        expect(
            server.buildXHeaders(mockRequest('172.28.192.1', 'https://kiwibnc.com/'))
        ).toEqual({
            'X-Forwarded-For': '172.28.192.1',
            'X-Forwarded-Host': 'kiwibnc.com',
            'X-Forwarded-Port': '443',
            'X-Forwarded-Proto': 'https'
        });

    });
});