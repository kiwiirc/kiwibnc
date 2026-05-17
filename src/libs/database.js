const path = require('path');
const knex = require('knex');

const USER_DB_TABLES = new Set([
    'connections',
    'users',
    'user_networks',
    'user_tokens',
]);

module.exports = class Database {
    constructor(config) {
        let dbConf = config.get('database', {});
        let userTablePrefix = dbConf.table_prefix || '';
        this.userMigrationTableName = `${userTablePrefix}knex_migrations`;
        let wrapUserIdentifier = (value, origImpl) => {
            let prefixedValue = USER_DB_TABLES.has(value) ?
                `${userTablePrefix}${value}` :
                value;
            return origImpl(prefixedValue);
        };

		this.dbConnections = knex({
			client: 'better-sqlite3',
			connection: {
                // dbConf.path is legacy
				filename: config.relativePath(dbConf.state || dbConf.path || 'connections.db'),
			},
            useNullAsDefault: true,
            pool: { propagateCreateError: false },
        });

        let usersConStr = dbConf.users || 'users.db';
        let usersDbCon = {
			client: 'better-sqlite3',
            connection: null,
            acquireConnectionTimeout: 10000,
        };
        if (usersConStr.indexOf('postgres://') > -1) {
            // postgres://someuser:somepassword@somehost:381/somedatabase
            usersDbCon.client = 'pg';
            usersDbCon.connection = usersConStr;
            usersDbCon.wrapIdentifier = wrapUserIdentifier;
            let searchPathM = usersConStr.match(/searchPath=([^&]+)/);
            if (searchPathM) {
                usersDbCon.searchPath = searchPathM[1].split(',');
            }
        } else if (usersConStr.indexOf('mysql://') > -1) {
            // mysql://user:password@127.0.0.1:3306/database
            // knex handles this connection string internally
            usersDbCon = usersConStr;
        } else {
            // No scheme:// part in the connection string, assume it's an sqlite filename
            usersDbCon.client = 'better-sqlite3';
            usersDbCon.useNullAsDefault = true;
            usersDbCon.connection = { filename: config.relativePath(usersConStr) };
            usersDbCon.pool = { propagateCreateError: false };
            usersDbCon.wrapIdentifier = wrapUserIdentifier;
        }

        this.dbUsers = knex(usersDbCon);

        // Some older extensions make use of .db for user data access
        this.db = this.dbUsers;

        this.factories = Object.create(null);

        // The users db abstractions will set itself here
        this.users = null;
    }

    get(sql, params) {
        return this.dbUsers.raw(sql, params).then(rows => rows[0]);
    }

    all(sql, params) {
        return this.dbUsers.raw(sql, params);
    }

    run(sql, params) {
        return this.dbUsers.raw(sql, params);
    }

    migrateConnections() {
        return this.dbConnections.migrate.latest({
            directory: path.join(__dirname, '..', 'dbschemas', 'connections'),
        });
    }

    migrateUsers() {
        return this.dbUsers.migrate.latest({
            directory: path.join(__dirname, '..', 'dbschemas', 'users'),
            tableName: this.userMigrationTableName,
        });
    }

    async init() {
        await this.migrateConnections();
        await this.migrateUsers();
    }
}
