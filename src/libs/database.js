const path = require('path');
const knex = require('knex');

module.exports = class Database {
    constructor(config) {
        let dbConf = config.get('database', {});

		this.dbConnections = knex({
			client: 'sqlite3',
			connection: {
                // dbConf.path is legacy
				filename: config.relativePath(dbConf.state || dbConf.path || 'connections.db'),
			},
            useNullAsDefault: true,
            pool: { propagateCreateError: false },
        });

        let usersConStr = dbConf.users || 'users.db';
        let usersDbCon = {
			client: 'sqlite3',
            connection: null,
            acquireConnectionTimeout: 10000,
        };
        if (usersConStr.indexOf('postgres://') > -1) {
            // postgres://someuser:somepassword@somehost:381/somedatabase
            usersDbCon.client = 'pg';
            usersDbCon.connection = usersConStr;
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
            usersDbCon.client = 'sqlite3';
            usersDbCon.useNullAsDefault = true;
            usersDbCon.connection = { filename: config.relativePath(usersConStr) };
            usersDbCon.pool = { propagateCreateError: false };
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

    async init() {
        await this.dbConnections.migrate.latest({
            directory: path.join(__dirname, '..', 'dbschemas', 'connections'),
        });
        await this.dbUsers.migrate.latest({
            directory: path.join(__dirname, '..', 'dbschemas', 'users'),
        });
    }
}
