'use strict';

const {
    createMockMessage,
    createMockClient,
    createMockUpstream
} = require('../helpers/mocks');

/**
 * Tests for the extended-join capability hook in src/worker/hooks.js
 *
 * These tests verify that the extended-join hook properly handles
 * the case where multiple clients have different capability sets,
 * without mutating the shared message object.
 */

describe('extended-join capability hook', () => {
    let IrcMessage;
    let commandHooks;

    beforeAll(() => {
        // Get the IrcMessage class
        IrcMessage = require('irc-framework').Message;
    });

    beforeEach(() => {
        // Clear module cache to get fresh hooks instance
        delete require.cache[require.resolve('../../src/worker/hooks')];
        commandHooks = require('../../src/worker/hooks');
        commandHooks.addBuiltInHooks();
    });

    afterEach(() => {
        // Clean up listeners by clearing the events object
        commandHooks.events = Object.create(null);
    });

    /**
     * Helper to simulate the message_to_client hook for a given client and message
     * Returns the event object that was processed by the hooks (may have modified message)
     */
    async function emitMessageToClient(client, message) {
        const result = await commandHooks.emit('message_to_client', {
            client,
            message
        });
        // The EventEmitter wraps the event and returns it in result.event
        return result.event;
    }

    it('should not mutate original message when client lacks extended-join', async () => {
        // Create a client WITHOUT extended-join capability
        const client = createMockClient('client-1', ['server-time']);
        client.upstream = createMockUpstream();

        // Create an extended-join message with account and realname
        const originalMessage = new IrcMessage('JOIN', '#channel', 'accountname', 'Real Name');
        originalMessage.prefix = 'newnick!user@host';
        originalMessage.nick = 'newnick';
        originalMessage.ident = 'user';
        originalMessage.hostname = 'host';
        originalMessage.tags = { time: '2024-01-01T00:00:00.000Z' };

        // Store original params for comparison
        const originalParams = [...originalMessage.params];

        // Emit the hook
        const event = await emitMessageToClient(client, originalMessage);

        // Original message should NOT be mutated
        expect(originalMessage.params).toEqual(originalParams);
        expect(originalMessage.params.length).toBe(3);
        expect(originalMessage.params[0]).toBe('#channel');
        expect(originalMessage.params[1]).toBe('accountname');
        expect(originalMessage.params[2]).toBe('Real Name');
    });

    it('should preserve all message fields in new message (prefix, nick, ident, hostname, tags)', async () => {
        const client = createMockClient('client-1', ['server-time']);
        client.upstream = createMockUpstream();

        const originalMessage = new IrcMessage('JOIN', '#channel', 'accountname', 'Real Name');
        originalMessage.prefix = 'newnick!user@host';
        originalMessage.nick = 'newnick';
        originalMessage.ident = 'user';
        originalMessage.hostname = 'host';
        originalMessage.tags = { time: '2024-01-01T00:00:00.000Z', msgid: 'abc123' };

        const event = await emitMessageToClient(client, originalMessage);

        // Event message should be a new object with correct fields
        expect(event.message).not.toBe(originalMessage);
        expect(event.message.command).toBe('JOIN');
        expect(event.message.prefix).toBe('newnick!user@host');
        expect(event.message.nick).toBe('newnick');
        expect(event.message.ident).toBe('user');
        expect(event.message.hostname).toBe('host');
        expect(event.message.tags.time).toBe('2024-01-01T00:00:00.000Z');
    });

    it('should only modify JOIN messages with >2 params', async () => {
        const client = createMockClient('client-1', ['server-time']);
        client.upstream = createMockUpstream();

        // JOIN with only 1 param (no extended-join from upstream)
        const simpleJoin = new IrcMessage('JOIN', '#channel');
        simpleJoin.prefix = 'newnick!user@host';
        simpleJoin.nick = 'newnick';

        const event = await emitMessageToClient(client, simpleJoin);

        // Should not create a new message for simple JOIN
        expect(event.message).toBe(simpleJoin);
        expect(event.message.params).toEqual(['#channel']);
    });

    it('should pass original message to clients WITH extended-join capability', async () => {
        // Client HAS extended-join capability
        const client = createMockClient('client-1', ['extended-join', 'server-time']);
        client.upstream = createMockUpstream();

        const originalMessage = new IrcMessage('JOIN', '#channel', 'accountname', 'Real Name');
        originalMessage.prefix = 'newnick!user@host';
        originalMessage.nick = 'newnick';
        originalMessage.ident = 'user';
        originalMessage.hostname = 'host';

        const event = await emitMessageToClient(client, originalMessage);

        // Message should be unchanged (same object)
        expect(event.message).toBe(originalMessage);
        expect(event.message.params.length).toBe(3);
        expect(event.message.params[0]).toBe('#channel');
        expect(event.message.params[1]).toBe('accountname');
        expect(event.message.params[2]).toBe('Real Name');
    });

    it('should send stripped message to clients WITHOUT extended-join capability', async () => {
        const client = createMockClient('client-1', ['server-time']);
        client.upstream = createMockUpstream();

        const originalMessage = new IrcMessage('JOIN', '#channel', 'accountname', 'Real Name');
        originalMessage.prefix = 'newnick!user@host';
        originalMessage.nick = 'newnick';
        originalMessage.ident = 'user';
        originalMessage.hostname = 'host';

        const event = await emitMessageToClient(client, originalMessage);

        // Event message should only have channel param
        expect(event.message.params.length).toBe(1);
        expect(event.message.params[0]).toBe('#channel');
    });

    it('should handle multiple clients with mixed capabilities correctly', async () => {
        // This is the core regression test for the mutation bug
        const clientWithCap = createMockClient('client-with', ['extended-join', 'server-time']);
        const clientWithoutCap = createMockClient('client-without', ['server-time']);

        const upstream = createMockUpstream();
        clientWithCap.upstream = upstream;
        clientWithoutCap.upstream = upstream;

        // Create the original message
        const originalMessage = new IrcMessage('JOIN', '#channel', 'accountname', 'Real Name');
        originalMessage.prefix = 'newnick!user@host';
        originalMessage.nick = 'newnick';
        originalMessage.ident = 'user';
        originalMessage.hostname = 'host';

        // Simulate what happens in messageFromUpstream - the same message object
        // is used for multiple clients

        // First, client WITHOUT extended-join processes
        const eventWithout = await emitMessageToClient(clientWithoutCap, originalMessage);

        // Then, client WITH extended-join processes using the SAME original message
        const eventWith = await emitMessageToClient(clientWithCap, originalMessage);

        // Client without extended-join should get stripped message
        expect(eventWithout.message.params.length).toBe(1);
        expect(eventWithout.message.params[0]).toBe('#channel');

        // Client WITH extended-join should get full message with account/realname
        // This was the bug - before the fix, this would also be stripped
        expect(eventWith.message.params.length).toBe(3);
        expect(eventWith.message.params[0]).toBe('#channel');
        expect(eventWith.message.params[1]).toBe('accountname');
        expect(eventWith.message.params[2]).toBe('Real Name');

        // Original message should still be intact
        expect(originalMessage.params.length).toBe(3);
    });
});
