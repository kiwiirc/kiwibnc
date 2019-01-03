const sqlite3 = require('sqlite3');

module.exports = class Database {
    constructor(dbPath) {
        this.db = new sqlite3.Database(dbPath);
    }

    get(sql, params) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    reject(err);
                }

                resolve(row);
            });
        });
    }

    all(sql, params) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                }

                resolve(rows);
            });
        });
    }

    run(sql, params) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, (err) => {
                if (err) {
                    reject(err);
                }

                resolve();
            });
        });
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
            linked_con_ids TEXT,
            temp TEXT
        );
        `);

        sql.push(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT,
            password TEXT,
            created_at INTEGER
        );
        `);

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

        for (let i=0; i<sql.length; i++) {
            await this.run(sql[i]);
        }
    }
}