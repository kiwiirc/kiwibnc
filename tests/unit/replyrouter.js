'use strict';

const {
    createMockClient,
    createMockReplyRoute
} = require('../helpers/mocks');

/**
 * Tests for the replyrouter extension in src/extensions/replyrouter/
 *
 * These tests verify that:
 * 1. The filter() approach correctly handles array cleanup (no forEach+splice bugs)
 * 2. Stale entries are cleaned up after 30 seconds
 * 3. Expected replies are correctly routed to requesting clients
 */

describe('replyrouter expecting_replies cleanup', () => {
    let replyRouterModule;
    let hooks;

    beforeEach(() => {
        // Create a mock hooks object
        hooks = {
            handlers: {},
            on: function(event, handler) {
                if (!this.handlers[event]) {
                    this.handlers[event] = [];
                }
                this.handlers[event].push(handler);
            },
            emit: async function(event, data) {
                if (this.handlers[event]) {
                    for (const handler of this.handlers[event]) {
                        await handler(data);
                    }
                }
            }
        };

        // Suppress debug logging
        global.l = { debug: jest.fn() };

        // Clear module cache and reload
        delete require.cache[require.resolve('../../src/extensions/replyrouter/index')];
        replyRouterModule = require('../../src/extensions/replyrouter/index');
        replyRouterModule.init(hooks);
    });

    afterEach(() => {
        delete global.l;
    });

    it('should correctly remove ending reply from middle of array', async () => {
        const client = createMockClient('client-1', []);

        // Set up three expecting entries: WHO1, LIST, WHO2
        const expecting = [
            createMockReplyRoute({
                replies: [{ cmd: '352', ending: false }, { cmd: '315', ending: true }],
                source: 'WHO1',
                added: Date.now()
            }),
            createMockReplyRoute({
                replies: [{ cmd: '322', ending: false }, { cmd: '323', ending: true }],
                source: 'LIST',
                added: Date.now()
            }),
            createMockReplyRoute({
                replies: [{ cmd: '352', ending: false }, { cmd: '315', ending: true }],
                source: 'WHO2',
                added: Date.now()
            })
        ];

        client.state.tempSet('expecting_replies', expecting);

        // Simulate receiving RPL_LISTEND (323) - should remove LIST entry (middle)
        const event = {
            message: { command: '323' },
            clients: [client]
        };

        await hooks.emit('message_to_clients', event);

        const remaining = client.state.tempGet('expecting_replies');
        expect(remaining.length).toBe(2);
        expect(remaining[0].source).toBe('WHO1');
        expect(remaining[1].source).toBe('WHO2');
    });

    it('should handle consecutive ending replies without skipping entries', async () => {
        // This is the regression test for the forEach+splice bug
        const client = createMockClient('client-1', []);

        // Set up three entries that will all end with the same numeric
        const expecting = [
            createMockReplyRoute({
                replies: [{ cmd: '352', ending: false }, { cmd: '315', ending: true }],
                source: 'WHO1',
                added: Date.now()
            }),
            createMockReplyRoute({
                replies: [{ cmd: '352', ending: false }, { cmd: '315', ending: true }],
                source: 'WHO2',
                added: Date.now()
            }),
            createMockReplyRoute({
                replies: [{ cmd: '352', ending: false }, { cmd: '315', ending: true }],
                source: 'WHO3',
                added: Date.now()
            })
        ];

        client.state.tempSet('expecting_replies', expecting);

        // Simulate receiving RPL_ENDOFWHO (315) - with old forEach+splice bug,
        // this would skip entries. With filter(), all should be removed.
        const event = {
            message: { command: '315' },
            clients: [client]
        };

        await hooks.emit('message_to_clients', event);

        const remaining = client.state.tempGet('expecting_replies');
        // All three should be removed since they all end with 315
        // tempSet(key, null) deletes the key, so tempGet returns undefined
        expect(remaining).toBeFalsy();
    });

    it('should remove stale entries older than 30 seconds', async () => {
        const client = createMockClient('client-1', []);

        const now = Date.now();
        const expecting = [
            createMockReplyRoute({
                replies: [{ cmd: '352', ending: false }, { cmd: '315', ending: true }],
                source: 'FRESH',
                added: now // Fresh entry
            }),
            createMockReplyRoute({
                replies: [{ cmd: '322', ending: false }, { cmd: '323', ending: true }],
                source: 'STALE',
                added: now - 31000 // 31 seconds old, should be removed
            })
        ];

        client.state.tempSet('expecting_replies', expecting);

        // Emit a command that matches the fresh entry (non-ending)
        const event = {
            message: { command: '352' },
            clients: [client]
        };

        await hooks.emit('message_to_clients', event);

        const remaining = client.state.tempGet('expecting_replies');
        expect(remaining.length).toBe(1);
        expect(remaining[0].source).toBe('FRESH');
    });

    it('should keep non-ending and non-stale entries', async () => {
        const client = createMockClient('client-1', []);

        const expecting = [
            createMockReplyRoute({
                replies: [{ cmd: '352', ending: false }, { cmd: '315', ending: true }],
                source: 'WHO',
                added: Date.now()
            }),
            createMockReplyRoute({
                replies: [{ cmd: '322', ending: false }, { cmd: '323', ending: true }],
                source: 'LIST',
                added: Date.now()
            })
        ];

        client.state.tempSet('expecting_replies', expecting);

        // Emit a non-ending reply for WHO (352)
        const event = {
            message: { command: '352' },
            clients: [client]
        };

        await hooks.emit('message_to_clients', event);

        const remaining = client.state.tempGet('expecting_replies');
        // Both should remain - 352 is non-ending for WHO, and LIST is unrelated
        expect(remaining.length).toBe(2);
    });

    it('should set expecting_replies to null when array becomes empty', async () => {
        const client = createMockClient('client-1', []);

        const expecting = [
            createMockReplyRoute({
                replies: [{ cmd: '315', ending: true }],
                source: 'WHO',
                added: Date.now()
            })
        ];

        client.state.tempSet('expecting_replies', expecting);

        // Emit the ending reply
        const event = {
            message: { command: '315' },
            clients: [client]
        };

        await hooks.emit('message_to_clients', event);

        const remaining = client.state.tempGet('expecting_replies');
        // tempSet(key, null) deletes the key, so tempGet returns undefined
        expect(remaining).toBeFalsy();
    });
});

describe('replyrouter passthrough commands', () => {
    let replyRouterModule;
    let hooks;

    beforeEach(() => {
        hooks = {
            handlers: {},
            on: function(event, handler) {
                if (!this.handlers[event]) {
                    this.handlers[event] = [];
                }
                this.handlers[event].push(handler);
            },
            emit: async function(event, data) {
                if (this.handlers[event]) {
                    for (const handler of this.handlers[event]) {
                        await handler(data);
                    }
                }
            }
        };

        global.l = { debug: jest.fn() };

        delete require.cache[require.resolve('../../src/extensions/replyrouter/index')];
        replyRouterModule = require('../../src/extensions/replyrouter/index');
        replyRouterModule.init(hooks);
    });

    afterEach(() => {
        delete global.l;
    });

    it('should skip processing for PRIVMSG commands (fast path)', async () => {
        const client = createMockClient('client-1', []);

        // Set up expecting entries
        const expecting = [
            createMockReplyRoute({
                replies: [{ cmd: 'PRIVMSG', ending: true }], // Nonsensical but tests fast path
                source: 'TEST',
                added: Date.now()
            })
        ];

        client.state.tempSet('expecting_replies', expecting);

        const event = {
            message: { command: 'PRIVMSG' },
            clients: [client]
        };

        await hooks.emit('message_to_clients', event);

        // The expecting_replies should NOT be modified because PRIVMSG uses fast path
        const remaining = client.state.tempGet('expecting_replies');
        expect(remaining.length).toBe(1);
    });

    it('should process non-passthrough commands normally', async () => {
        const client = createMockClient('client-1', []);

        const expecting = [
            createMockReplyRoute({
                replies: [{ cmd: '311', ending: false }, { cmd: '318', ending: true }],
                source: 'WHOIS',
                added: Date.now()
            })
        ];

        client.state.tempSet('expecting_replies', expecting);

        // 318 is RPL_ENDOFWHOIS - not a passthrough command
        const event = {
            message: { command: '318' },
            clients: [client]
        };

        await hooks.emit('message_to_clients', event);

        // Should be removed because 318 is an ending reply
        const remaining = client.state.tempGet('expecting_replies');
        // tempSet(key, null) deletes the key, so tempGet returns undefined
        expect(remaining).toBeFalsy();
    });
});
