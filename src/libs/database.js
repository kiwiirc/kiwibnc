const path = require('path');
const fs = require('fs');
const knex = require('knex');

function isMysqlConnectionString(connectionString) {
    return !!connectionString &&
        (
            connectionString.indexOf('mysql://') > -1 ||
            connectionString.indexOf('mariadb://') > -1
        );
}

function timestampForFilename() {
    return (new Date()).toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z');
}

function nextRetiredPath(filePath) {
    const basePath = `${filePath}.retired-${timestampForFilename()}`;
    let retiredPath = `${basePath}.bak`;
    let counter = 1;

    while (fs.existsSync(retiredPath)) {
        retiredPath = `${basePath}-${counter}.bak`;
        counter++;
    }

    return retiredPath;
}

function logRetiredUsersDb(sourcePath, retiredPath) {
    const msg = `Retired stale SQLite users database ${sourcePath} to ${retiredPath} because database.users is configured for MySQL/MariaDB`;
    if (global.l && global.l.warn) {
        global.l.warn(msg);
    } else {
        console.warn(msg);
    }
}

function configuredSqliteUsersPath(config, configuredUsersConStr, hasConfiguredDatabase) {
    if (!hasConfiguredDatabase) {
        return null;
    }

    const usersConStr = configuredUsersConStr || 'users.db';
    if (usersConStr.startsWith('postgres://') ||
        isMysqlConnectionString(usersConStr)) {
        return null;
    }

    return config.relativePath(usersConStr);
}

function archiveStaleUsersDb(usersDbPath) {
    if (!usersDbPath) {
        return;
    }

    if (!fs.existsSync(usersDbPath)) {
        return;
    }

    if (!fs.statSync(usersDbPath).isFile()) {
        return;
    }

    const retiredPath = nextRetiredPath(usersDbPath);
    fs.renameSync(usersDbPath, retiredPath);
    logRetiredUsersDb(usersDbPath, retiredPath);
}

module.exports = class Database {
    constructor(config) {
        let hasConfiguredDatabase = !!(config.c && config.c.database);
        let configuredUsersConStr = config.c && config.c.database ?
            config.c.database.users :
            undefined;
        let dbConf = config.get('database', {});
        this.staleUsersDbPath = null;

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
        if (usersConStr.startsWith('postgres://')) {
            // postgres://someuser:somepassword@somehost:381/somedatabase
            usersDbCon.client = 'pg';
            usersDbCon.connection = usersConStr;
            let searchPathM = usersConStr.match(/searchPath=([^&]+)/);
            if (searchPathM) {
                usersDbCon.searchPath = searchPathM[1].split(',');
            }
        } else if (isMysqlConnectionString(usersConStr)) {
            this.staleUsersDbPath = configuredSqliteUsersPath(config, configuredUsersConStr, hasConfiguredDatabase);
            // mysql://user:password@127.0.0.1:3306/database
            // knex handles this connection string internally
            usersDbCon = usersConStr;
        } else {
            // No scheme:// part in the connection string, assume it's an sqlite filename
            usersDbCon.client = 'better-sqlite3';
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

    migrateConnections() {
        return this.dbConnections.migrate.latest({
            directory: path.join(__dirname, '..', 'dbschemas', 'connections'),
        });
    }

    migrateUsers() {
        return this.dbUsers.migrate.latest({
            directory: path.join(__dirname, '..', 'dbschemas', 'users'),
        });
    }

    async init() {
        await this.migrateConnections();
        await this.migrateUsers();
        archiveStaleUsersDb(this.staleUsersDbPath);
    }
}
