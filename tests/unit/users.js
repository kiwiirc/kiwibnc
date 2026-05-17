'use strict';

jest.mock('bcrypt', () => ({
    compare: jest.fn(),
}));

const Users = require('../../src/worker/users');

describe('worker users', () => {
    let originalConfig;

    beforeEach(() => {
        originalConfig = global.config;
        global.config = {
            get: jest.fn(() => -1),
        };
    });

    afterEach(() => {
        global.config = originalConfig;
    });

    test('addNetwork persists channels', async () => {
        const saved = [];
        const db = {
            factories: {
                Network: jest.fn(() => ({
                    save: jest.fn(function save() {
                        saved.push(this);
                    }),
                })),
            },
        };
        const users = new Users(db);

        const network = await users.addNetwork(42, {
            name: 'ExampleNet',
            host: 'irc.example.test',
            port: 6667,
            tls: false,
            nick: 'testuser',
            username: 'testuser',
            realname: 'testuser',
            channels: '#lobby,#help',
        });

        expect(network.channels).toBe('#lobby,#help');
        expect(saved).toHaveLength(1);
        expect(saved[0].channels).toBe('#lobby,#help');
    });
});
