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
        let sql = [];
        sql.push(`
        CREATE TABLE IF NOT EXISTS connections (
            conid TEXT PRIMARY KEY,
            last_statesave INTEGER,
            host TEXT,
            port INTEGER,
            tls BOOLEAN,
            type INTEGER,
            connected BOOLEAN,
            server_prefix TEXT,
            registration_lines TEXT,
            isupports TEXT,
            caps TEXT,
            channels TEXT,
            nick TEXT,
            net_registered BOOLEAN,
            auth_user_id INTEGER,
            auth_network_id INTEGER,
            auth_admin BOOLEAN,
            linked_con_ids TEXT,
            logging BOOL,
            temp TEXT
        );
        `);

        sql.push(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT,
            password TEXT,
            created_at INTEGER,
            admin BOOLEAN
        );
        `);
        sql.push('CREATE UNIQUE INDEX IF NOT EXISTS users_username_uindex ON users (username);');

        sql.push(`
        CREATE TABLE IF NOT EXISTS user_networks (
            id INTEGER PRIMARY KEY,
            name TEXT,
            user_id INTEGER,
            host TEXT,
            port INTEGER,
            tls BOOLEAN,
            nick TEXT,
            username TEXT,
            realname TEXT,
            password TEXT
        );
        `);
        sql.push('CREATE UNIQUE INDEX IF NOT EXISTS user_networks_name_user_id_uindex ON user_networks (name, user_id);');

        for (let i=0; i<sql.length; i++) {
            await this.run(sql[i]);
        }
    }
}