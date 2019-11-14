const path = require('path');
const knex = require('knex');

module.exports = class Database {
    constructor(config) {
		this.dbConnections = knex({
			client: 'sqlite3',
			connection: {
                // config.path is legacy
				filename: config.state || config.path || 'connections.db',
			},
			useNullAsDefault: true,
        });

		this.dbUsers = knex({
			client: 'sqlite3',
			connection: {
				filename: config.users || 'users.db',
			},
			useNullAsDefault: true,
        });

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
