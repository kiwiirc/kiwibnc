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

describe('database table prefixes', () => {
    test('prefixes KiwiBNC user tables when configured', () => {
        const db = new Database(createConfig({
            users: 'users.db',
            table_prefix: 'bnc_',
        }));

        const selectSql = db.dbUsers('users').select('*').toSQL().sql;
        const joinSql = db.dbUsers('user_networks')
            .innerJoin('users', 'users.id', 'user_networks.user_id')
            .innerJoin('user_tokens', 'user_tokens.user_id', 'user_networks.user_id')
            .select('user_networks.*', 'users.password as _pass')
            .toSQL()
            .sql;

        expect(selectSql).toContain('`bnc_users`');
        expect(joinSql).toContain('`bnc_user_networks`');
        expect(joinSql).toContain('`bnc_users`');
        expect(joinSql).toContain('`bnc_user_tokens`');
        expect(joinSql).not.toContain('`user_networks`');
        expect(joinSql).not.toContain('`users`');
        expect(joinSql).not.toContain('`user_tokens`');

        return Promise.all([
            db.dbUsers.destroy(),
            db.dbConnections.destroy(),
        ]);
    });

    test('prefixes user migration metadata table in shared databases', async () => {
        const db = new Database(createConfig({
            state: 'connections.db',
            users: 'users.db',
            table_prefix: 'bnc_',
        }));

        expect(db.userMigrationTableName).toBe('bnc_knex_migrations');

        await db.dbUsers.destroy();
        await db.dbConnections.destroy();
    });
});
