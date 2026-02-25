'use strict';

const {
    createMockMessage,
    createMockState,
    createMockUpstream
} = require('../helpers/mocks');

/**
 * Tests for writeMsgFast numeric fast-path in src/worker/connectionincoming.js
 *
 * These tests verify that the fast-path for numeric IRC responses
 * correctly handles capability-based message transformation.
 */

describe('writeMsgFast numeric fast-path', () => {
    let ConnectionIncoming;
    let mockDb;
    let mockUserDb;
    let mockMessages;
    let mockQueue;
    let mockConDict;

    beforeEach(() => {
        // Suppress logging
        global.l = Object.assign(jest.fn(), { debug: jest.fn(), info: jest.fn(), error: jest.fn(), trace: jest.fn() });
        global.config = { get: jest.fn().mockReturnValue(null) };

        // Mock dependencies
        mockDb = {};
        mockUserDb = {};
        mockMessages = {};
        mockQueue = {
            sendToSockets: jest.fn()
        };
        mockConDict = new Map();

        // Clear module cache
        delete require.cache[require.resolve('../../src/worker/connectionincoming')];

        // Mock hooks module
        jest.doMock('../../src/worker/hooks', () => ({
            emit: jest.fn().mockResolvedValue({ prevent: false, event: {} })
        }));

        ConnectionIncoming = require('../../src/worker/connectionincoming');
    });

    afterEach(() => {
        delete global.l;
        delete global.config;
        jest.resetModules();
    });

    function createTestClient(caps = [], upstreamCaps = []) {
        // Create a fresh Map for each test client
        const testConDict = new Map();
        // Constructor signature: (_id, db, userDb, messages, queue, conDict)
        const client = new ConnectionIncoming(null, mockDb, mockUserDb, mockMessages, mockQueue, testConDict);
        client.state = createMockState(caps);
        client.state.netRegistered = true;
        client.state.authUserId = 1;
        client.state.authNetworkId = 1;

        // Set up upstream through the cachedUpstreamId mechanism
        const mockUpstream = createMockUpstream({ caps: upstreamCaps, id: 'mock-upstream' });
        testConDict.set('mock-upstream', mockUpstream);
        client.cachedUpstreamId = 'mock-upstream';

        // Mock the write method to capture output
        client.write = jest.fn();

        return client;
    }

    describe('server-time handling', () => {
        it('should add server-time tag when client has capability', () => {
            const client = createTestClient(['server-time']);

            const msg = createMockMessage('352', [
                'testnick', '#channel', 'user', 'host', 'server', 'nick', 'H', '0 realname'
            ]);
            msg.tags = {};

            client.writeMsgFast(msg);

            expect(client.write).toHaveBeenCalled();
            const written = client.write.mock.calls[0][0];
            // Should contain @time= tag
            expect(written).toMatch(/@time=/);
        });

        it('should preserve existing server-time tag when client has capability', () => {
            const client = createTestClient(['server-time']);

            const msg = createMockMessage('352', [
                'testnick', '#channel', 'user', 'host', 'server', 'nick', 'H', '0 realname'
            ]);
            msg.tags = { time: '2024-01-01T12:00:00.000Z' };

            client.writeMsgFast(msg);

            expect(client.write).toHaveBeenCalled();
            const written = client.write.mock.calls[0][0];
            expect(written).toContain('2024-01-01T12:00:00.000Z');
        });

        it('should remove server-time tag when client lacks capability', () => {
            const client = createTestClient([]);  // No caps

            const msg = createMockMessage('352', [
                'testnick', '#channel', 'user', 'host', 'server', 'nick', 'H', '0 realname'
            ]);
            msg.tags = { time: '2024-01-01T12:00:00.000Z' };

            client.writeMsgFast(msg);

            expect(client.write).toHaveBeenCalled();
            const written = client.write.mock.calls[0][0];
            // Should NOT contain @time=
            expect(written).not.toMatch(/@time=/);
        });
    });

    describe('multi-prefix handling for WHO (352)', () => {
        it('should strip extra prefixes when client lacks multi-prefix', () => {
            const client = createTestClient(
                ['server-time'],  // Client caps (no multi-prefix)
                ['multi-prefix']  // Upstream has multi-prefix
            );

            // WHO reply with multiple prefixes: H@%+ means Here, Op, Halfop, Voice
            const msg = createMockMessage('352', [
                'testnick', '#channel', 'user', 'host', 'server', 'nick', 'H@%+', '0 realname'
            ]);
            msg.tags = {};

            client.writeMsgFast(msg);

            expect(client.write).toHaveBeenCalled();
            const written = client.write.mock.calls[0][0];
            // Should have stripped to just H@ (Here + first prefix @)
            expect(written).toContain(' H@ ');
        });

        it('should preserve all prefixes when client has multi-prefix', () => {
            const client = createTestClient(
                ['server-time', 'multi-prefix'],  // Client has multi-prefix
                ['multi-prefix']
            );

            const msg = createMockMessage('352', [
                'testnick', '#channel', 'user', 'host', 'server', 'nick', 'H@%+', '0 realname'
            ]);
            msg.tags = {};

            client.writeMsgFast(msg);

            expect(client.write).toHaveBeenCalled();
            const written = client.write.mock.calls[0][0];
            // All prefixes preserved
            expect(written).toContain('H@%+');
        });

        it('should handle Away status correctly', () => {
            const client = createTestClient(
                ['server-time'],
                ['multi-prefix']
            );

            // Away user with multiple prefixes
            const msg = createMockMessage('352', [
                'testnick', '#channel', 'user', 'host', 'server', 'nick', 'A*@%', '0 realname'
            ]);
            msg.tags = {};

            client.writeMsgFast(msg);

            expect(client.write).toHaveBeenCalled();
            const written = client.write.mock.calls[0][0];
            // Should be A*@ (Away, IRCop, first prefix)
            expect(written).toContain(' A*@ ');
        });
    });

    describe('multi-prefix and userhost-in-names handling for NAMES (353)', () => {
        it('should strip extra prefixes from NAMES when client lacks multi-prefix', () => {
            const client = createTestClient(
                ['server-time'],  // No multi-prefix
                ['multi-prefix', 'userhost-in-names']
            );

            // NAMES reply with multiple prefixes per user
            const msg = createMockMessage('353', [
                'testnick', '=', '#channel', '@%+user1 @user2 +user3'
            ]);
            msg.tags = {};

            client.writeMsgFast(msg);

            expect(client.write).toHaveBeenCalled();
            const written = client.write.mock.calls[0][0];
            // Should strip to single prefix: @user1 @user2 +user3
            expect(written).toContain('@user1 @user2 +user3');
        });

        it('should strip userhost from NAMES when client lacks userhost-in-names', () => {
            const client = createTestClient(
                ['server-time', 'multi-prefix'],  // Has multi-prefix but not userhost-in-names
                ['multi-prefix', 'userhost-in-names']
            );

            // NAMES reply with user@host format
            const msg = createMockMessage('353', [
                'testnick', '=', '#channel', '@nick1!user1@host1 +nick2!user2@host2 nick3!user3@host3'
            ]);
            msg.tags = {};

            client.writeMsgFast(msg);

            expect(client.write).toHaveBeenCalled();
            const written = client.write.mock.calls[0][0];
            // Should strip to just nicks with prefixes: @nick1 +nick2 nick3
            expect(written).toContain('@nick1 +nick2 nick3');
        });

        it('should preserve all info when client has both caps', () => {
            const client = createTestClient(
                ['server-time', 'multi-prefix', 'userhost-in-names'],
                ['multi-prefix', 'userhost-in-names']
            );

            const msg = createMockMessage('353', [
                'testnick', '=', '#channel', '@%+nick1!user1@host1 @nick2!user2@host2'
            ]);
            msg.tags = {};

            client.writeMsgFast(msg);

            expect(client.write).toHaveBeenCalled();
            const written = client.write.mock.calls[0][0];
            // All info preserved
            expect(written).toContain('@%+nick1!user1@host1 @nick2!user2@host2');
        });

        it('should handle empty prefix list correctly', () => {
            const client = createTestClient(
                ['server-time'],
                ['multi-prefix']
            );

            // Users with no prefixes
            const msg = createMockMessage('353', [
                'testnick', '=', '#channel', 'user1 user2 user3'
            ]);
            msg.tags = {};

            client.writeMsgFast(msg);

            expect(client.write).toHaveBeenCalled();
            const written = client.write.mock.calls[0][0];
            expect(written).toContain('user1 user2 user3');
        });
    });

    describe('message-tags handling', () => {
        it('should strip all tags when client has neither message-tags nor server-time', () => {
            const client = createTestClient([]);  // No caps

            const msg = createMockMessage('352', [
                'testnick', '#channel', 'user', 'host', 'server', 'nick', 'H', '0 realname'
            ]);
            msg.tags = {
                time: '2024-01-01T12:00:00.000Z',
                msgid: 'abc123',
                '+custom': 'value'
            };

            client.writeMsgFast(msg);

            expect(client.write).toHaveBeenCalled();
            const written = client.write.mock.calls[0][0];
            // Should not have any @ prefix (no tags)
            expect(written).not.toMatch(/^@/);
        });
    });
});
