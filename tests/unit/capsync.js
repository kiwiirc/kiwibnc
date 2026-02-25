'use strict';

const { createMockState } = require('../helpers/mocks');

describe('syncAvailableCaps', () => {
    let ConnectionIncoming;
    let hooks;

    beforeEach(() => {
        global.l = Object.assign(jest.fn(), { debug: jest.fn(), info: jest.fn(), error: jest.fn(), trace: jest.fn() });
        global.config = { get: jest.fn().mockReturnValue(null) };

        jest.resetModules();
        jest.doMock('../../src/worker/hooks', () => ({
            emit: jest.fn(async (eventName, event) => {
                if (eventName === 'available_caps') {
                    event.caps.add('batch');
                    event.caps.add('cap-notify');
                    event.caps.add('server-time');
                    event.caps.add('extended-join');
                }
                return { prevent: false, event };
            }),
        }));

        hooks = require('../../src/worker/hooks');
        ConnectionIncoming = require('../../src/worker/connectionincoming');
    });

    afterEach(() => {
        delete global.l;
        delete global.config;
        jest.resetModules();
    });

    function createClient(state) {
        const conDict = new Map();
        const queue = { sendToSockets: jest.fn() };
        const client = new ConnectionIncoming('in-1', {}, {}, {}, queue, conDict);
        client.state = state;
        client.state.authUserId = 1;
        client.state.authNetworkId = 1;
        client.writeMsgFrom = jest.fn();
        client.writeFromBnc = jest.fn();
        client.cachedUpstreamId = 'up-1';
        conDict.set('up-1', {
            id: 'up-1',
            state: {
                serverPrefix: 'irc.test.server',
                linkedIncomingConIds: new Set(),
                linkIncomingConnection: jest.fn(),
            },
        });

        return client;
    }

    it('should send CAP NEW when new capabilities become available', async () => {
        const state = createMockState(['batch', 'cap-notify'], {
            nick: 'guest',
            netRegistered: true,
            tempData: {
                capver: 302,
                caps_offered: ['batch', 'cap-notify', 'server-time'],
            },
        });
        const client = createClient(state);

        await client.syncAvailableCaps();

        expect(hooks.emit).toHaveBeenCalledWith('available_caps', expect.any(Object));
        expect(client.writeMsgFrom).toHaveBeenCalledWith(
            'irc.test.server',
            'CAP',
            'guest',
            'NEW',
            'extended-join'
        );
    });

    it('should send CAP DEL when previously offered capabilities disappear', async () => {
        hooks.emit.mockImplementation(async (eventName, event) => {
            if (eventName === 'available_caps') {
                event.caps.add('batch');
                event.caps.add('cap-notify');
                event.caps.add('server-time');
            }
            return { prevent: false, event };
        });

        const state = createMockState(['batch', 'cap-notify'], {
            nick: 'guest',
            netRegistered: true,
            tempData: {
                capver: 302,
                caps_offered: ['batch', 'cap-notify', 'server-time', 'extended-join'],
            },
        });
        const client = createClient(state);

        await client.syncAvailableCaps();

        expect(client.writeMsgFrom).toHaveBeenCalledWith(
            'irc.test.server',
            'CAP',
            'guest',
            'DEL',
            'extended-join'
        );
    });

    it('should send CAP LS fallback when client does not support cap-notify', async () => {
        const state = createMockState([], {
            nick: 'guest',
            netRegistered: true,
            tempData: {
                capver: 301,
                caps_offered: ['batch'],
            },
        });
        const client = createClient(state);

        await client.syncAvailableCaps();

        expect(client.writeFromBnc).toHaveBeenCalledWith(
            'CAP',
            '*',
            'LS',
            'batch cap-notify server-time extended-join'
        );
    });
});
