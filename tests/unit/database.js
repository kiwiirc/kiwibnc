'use strict';

const path = require('path');
const Database = require('../../src/libs/database');

function createConfig(database, baseDir = '') {
    return {
        get(key, def) {
            if (key === 'database') {
                return database;
            }
            return def;
        },
        relativePath(filePath) {
            if (filePath[0] === '/') {
                return filePath;
            }
            return path.join(baseDir, filePath);
        },
    };
}

describe('database sql user connections', () => {
    async function closeDb(db) {
        await db.dbUsers.destroy();
        await db.dbConnections.destroy();
    }

    test('parses mysql user dsn with raw slash password', async () => {
        const db = new Database(createConfig({
            users: 'mysql://kiwibnc:raw/pass@db.example:3307/kiwibnc',
        }));

        const connection = db.dbUsers.client.config.connection;
        expect(db.dbUsers.client.config.client).toBe('mysql');
        expect(connection.host).toBe('db.example');
        expect(connection.port).toBe(3307);
        expect(connection.user).toBe('kiwibnc');
        expect(connection.password).toBe('raw/pass');
        expect(connection.database).toBe('kiwibnc');

        await closeDb(db);
    });

    test('supports mariadb user dsn', async () => {
        const db = new Database(createConfig({
            users: 'mariadb://kiwibnc:secret@db.example:3306/kiwibnc',
        }));

        const connection = db.dbUsers.client.config.connection;
        expect(db.dbUsers.client.config.client).toBe('mysql');
        expect(connection.host).toBe('db.example');
        expect(connection.port).toBe(3306);
        expect(connection.user).toBe('kiwibnc');
        expect(connection.password).toBe('secret');
        expect(connection.database).toBe('kiwibnc');

        await closeDb(db);
    });

    test('passes mysql charset query parameter to knex connection', async () => {
        const db = new Database(createConfig({
            users: 'mysql://kiwibnc:secret@db.example/kiwibnc?charset=utf8mb4',
        }));

        const connection = db.dbUsers.client.config.connection;
        expect(connection.charset).toBe('utf8mb4');

        await closeDb(db);
    });

    test('treats paths containing mysql-like text as sqlite paths', async () => {
        const db = new Database(createConfig({
            users: './archive/mysql://users.db',
        }, '/tmp/kiwibnc'));

        expect(db.dbUsers.client.config.client).toBe('better-sqlite3');
        expect(db.dbUsers.client.config.connection.filename)
            .toBe(path.join('/tmp/kiwibnc', './archive/mysql://users.db'));

        await closeDb(db);
    });
});
