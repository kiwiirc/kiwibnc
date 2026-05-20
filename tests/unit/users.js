'use strict';

jest.mock('bcrypt', () => ({
    compare: jest.fn(),
}));

const Users = require('../../src/worker/users');

describe('worker/users.js', () => {
    it('awaits authUserToken lookup before updating token access metadata', async () => {
        const row = { id: 42, username: 'testuser' };
        const query = {
            innerJoin: jest.fn(function innerJoin() { return this; }),
            where: jest.fn(function where() { return this; }),
            first: jest.fn(() => Promise.resolve(row)),
        };
        const db = {
            dbUsers: jest.fn(() => query),
            factories: {
                User: {
                    fromDbResult: jest.fn((result) => result),
                },
            },
        };
        const users = new Users(db);
        users.updateUserTokenAccess = jest.fn(() => Promise.resolve(1));

        const user = await users.authUserToken('__t1token', '127.0.0.1');

        expect(user).toEqual(row);
        expect(users.updateUserTokenAccess).toHaveBeenCalledWith(42, '__t1token', '127.0.0.1');
    });
});
