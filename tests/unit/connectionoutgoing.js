'use strict';

const {
    createMockMessage,
    createMockClient,
    createMockState
} = require('../helpers/mocks');

/**
 * Tests for WHO reply streaming in src/worker/connectionoutgoing.js
 *
 * These tests verify the direct WHO streaming implementation that bypasses
 * the replyrouter to avoid timeout issues with large WHO responses.
 */

describe('WHO reply streaming', () => {
    let ConnectionOutgoing;
    let mockDb;
    let mockMessages;
    let mockQueue;
    let mockConDict;
    let upstream;

    beforeEach(() => {
        // Suppress logging
        global.l = Object.assign(jest.fn(), { debug: jest.fn(), info: jest.fn(), error: jest.fn() });
        global.config = { get: jest.fn().mockReturnValue(null) };

        // Mock dependencies
        mockDb = {};
        mockMessages = {};
        mockQueue = {
            sendToSockets: jest.fn()
        };
        mockConDict = new Map();

        // Clear module cache
        delete require.cache[require.resolve('../../src/worker/connectionoutgoing')];

        // Mock the hooks module to prevent actual hook processing
        jest.doMock('../../src/worker/hooks', () => ({
            emit: jest.fn().mockResolvedValue({ prevent: false, event: { clients: [] } })
        }));

        // Mock upstreamcommands to not do actual processing
        jest.doMock('../../src/worker/upstreamcommands', () => ({
            run: jest.fn().mockResolvedValue(false)
        }));

        ConnectionOutgoing = require('../../src/worker/connectionoutgoing');

        upstream = new ConnectionOutgoing('upstream-1', mockDb, mockMessages, mockQueue, mockConDict);
        upstream.state.netRegistered = true;
        upstream.state.connected = true;
        upstream.state.maybeLoad = jest.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
        delete global.l;
        delete global.config;
        jest.resetModules();
    });

    it('should route WHO replies to the client that requested them', async () => {
        const client = createMockClient('client-1', ['server-time']);
        client.state.netRegistered = true;

        mockConDict.set('client-1', client);
        upstream.whoClientQueue.push('client-1');

        // Simulate WHO reply (352 RPL_WHOREPLY)
        const whoReply = createMockMessage('352', [
            'testnick', '#channel', 'user', 'host', 'server', 'nick', 'H', '0 realname'
        ]);

        await upstream.messageFromUpstream(whoReply, '');

        expect(client.writeMsgFast).toHaveBeenCalledWith(whoReply);
    });

    it('should maintain FIFO order for multiple WHO requests', async () => {
        const clientA = createMockClient('client-A', ['server-time']);
        const clientB = createMockClient('client-B', ['server-time']);
        clientA.state.netRegistered = true;
        clientB.state.netRegistered = true;

        mockConDict.set('client-A', clientA);
        mockConDict.set('client-B', clientB);

        // A sends WHO first, then B
        upstream.whoClientQueue.push('client-A');
        upstream.whoClientQueue.push('client-B');

        // First WHO reply should go to A
        const whoReply1 = createMockMessage('352', ['nick', '#channel1', 'user', 'host', 'server', 'nick', 'H', '0 realname']);
        await upstream.messageFromUpstream(whoReply1, '');

        expect(clientA.writeMsgFast).toHaveBeenCalledWith(whoReply1);
        expect(clientB.writeMsgFast).not.toHaveBeenCalled();
    });

    it('should pop queue on RPL_ENDOFWHO (315)', async () => {
        const clientA = createMockClient('client-A', ['server-time']);
        const clientB = createMockClient('client-B', ['server-time']);
        clientA.state.netRegistered = true;
        clientB.state.netRegistered = true;

        mockConDict.set('client-A', clientA);
        mockConDict.set('client-B', clientB);

        upstream.whoClientQueue.push('client-A');
        upstream.whoClientQueue.push('client-B');

        // End of WHO for A
        const endOfWho = createMockMessage('315', ['nick', '#channel', 'End of /WHO list.']);
        await upstream.messageFromUpstream(endOfWho, '');

        expect(clientA.writeMsgFast).toHaveBeenCalled();
        expect(upstream.whoClientQueue.length).toBe(1);
        expect(upstream.whoClientQueue[0]).toBe('client-B');

        // Next WHO reply should go to B
        clientA.writeMsgFast.mockClear();
        const whoReply = createMockMessage('352', ['nick', '#channel2', 'user', 'host', 'server', 'nick', 'H', '0 realname']);
        await upstream.messageFromUpstream(whoReply, '');

        expect(clientB.writeMsgFast).toHaveBeenCalledWith(whoReply);
        expect(clientA.writeMsgFast).not.toHaveBeenCalled();
    });

    it('should pop queue on ERR_NOSUCHSERVER (402)', async () => {
        const client = createMockClient('client-1', ['server-time']);
        client.state.netRegistered = true;

        mockConDict.set('client-1', client);
        upstream.whoClientQueue.push('client-1');

        // Error response
        const errorReply = createMockMessage('402', ['nick', 'target', 'No such server']);
        await upstream.messageFromUpstream(errorReply, '');

        expect(client.writeMsgFast).toHaveBeenCalledWith(errorReply);
        expect(upstream.whoClientQueue.length).toBe(0);
    });

    it('should skip unregistered clients but keep queue entry until ending', async () => {
        const client = createMockClient('client-1', ['server-time']);
        client.state.netRegistered = false; // Not registered

        mockConDict.set('client-1', client);
        upstream.whoClientQueue.push('client-1');

        // WHO reply - should be skipped
        const whoReply = createMockMessage('352', ['nick', '#channel', 'user', 'host', 'server', 'nick', 'H', '0 realname']);
        await upstream.messageFromUpstream(whoReply, '');

        expect(client.writeMsgFast).not.toHaveBeenCalled();
        // Queue should still have the entry
        expect(upstream.whoClientQueue.length).toBe(1);

        // End of WHO should still pop the queue
        const endOfWho = createMockMessage('315', ['nick', '#channel', 'End of /WHO list.']);
        await upstream.messageFromUpstream(endOfWho, '');

        expect(upstream.whoClientQueue.length).toBe(0);
    });

    it('should fall through to normal routing when queue is empty', async () => {
        const hooks = require('../../src/worker/hooks');
        const UpstreamCommands = require('../../src/worker/upstreamcommands');

        // Allow passthrough to normal processing
        UpstreamCommands.run.mockResolvedValue(undefined); // undefined = passthrough

        // Queue is empty
        expect(upstream.whoClientQueue.length).toBe(0);

        // WHO reply with empty queue should go through normal routing
        const whoReply = createMockMessage('352', ['nick', '#channel', 'user', 'host', 'server', 'nick', 'H', '0 realname']);
        await upstream.messageFromUpstream(whoReply, '');

        // Should have gone through hooks.emit
        expect(hooks.emit).toHaveBeenCalled();
    });

    it('should not affect non-WHO numerics', async () => {
        const client = createMockClient('client-1', ['server-time']);
        client.state.netRegistered = true;

        mockConDict.set('client-1', client);
        upstream.whoClientQueue.push('client-1');

        const hooks = require('../../src/worker/hooks');
        const UpstreamCommands = require('../../src/worker/upstreamcommands');
        UpstreamCommands.run.mockResolvedValue(undefined);

        // LIST reply (322) should NOT be intercepted by WHO queue
        const listReply = createMockMessage('322', ['nick', '#channel', '10', 'Channel topic']);
        await upstream.messageFromUpstream(listReply, '');

        // Should not go to writeMsgFast (WHO path)
        expect(client.writeMsgFast).not.toHaveBeenCalled();
        // Should go through normal hook processing
        expect(hooks.emit).toHaveBeenCalled();

        // WHO queue should be unchanged
        expect(upstream.whoClientQueue.length).toBe(1);
    });

    it('should handle disconnected client gracefully', async () => {
        // Client not in conDict (disconnected)
        upstream.whoClientQueue.push('disconnected-client');

        const whoReply = createMockMessage('352', ['nick', '#channel', 'user', 'host', 'server', 'nick', 'H', '0 realname']);

        // Should not throw
        await expect(upstream.messageFromUpstream(whoReply, '')).resolves.not.toThrow();

        // End of WHO should still pop the queue
        const endOfWho = createMockMessage('315', ['nick', '#channel', 'End of /WHO list.']);
        await upstream.messageFromUpstream(endOfWho, '');

        expect(upstream.whoClientQueue.length).toBe(0);
    });
});
