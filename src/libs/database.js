const path = require('path');
const knex = require('knex');

module.exports = class Database {
    constructor(dbPath) {
		this.db = knex({
			client: 'sqlite3',
			connection: {
				filename: dbPath,
			},
			useNullAsDefault: true,
        });

        this.factories = Object.create(null);

        // The users db abstractions will set itself here
        this.users = null;
    }

    get(sql, params) {
        return this.db.raw(sql, params).then(rows => rows[0]);
    }

    all(sql, params) {
        return this.db.raw(sql, params);
    }

    run(sql, params) {
        return this.db.raw(sql, params);
    }

    async init() {
        return this.db.migrate.latest({ directory: path.join(__dirname, '..', 'dbschemas') });
    }
}
