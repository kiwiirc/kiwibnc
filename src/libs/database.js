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
        let sql = `
        CREATE TABLE IF NOT EXISTS connections (
            conid TEXT PRIMARY KEY,
            last_statesave INTEGER,
            host TEXT,
            port INTEGER,
            tls BOOLEAN,
            type INTEGER,
            connected BOOLEAN,
            isupports TEXT,
            caps TEXT,
            channels TEXT,
            nick TEXT
        );
        `;
        await this.run(sql);
    }
}