const path = require('path');
const knex = require('knex');

function decodeConnectionPart(value) {
    return decodeURIComponent(value.replace(/\+/g, '%20'));
}

function parseMysqlConnectionString(connectionString) {
    const scheme = connectionString.startsWith('mariadb://') ? 'mariadb://' : 'mysql://';
    const withoutScheme = connectionString.slice(scheme.length);
    const authEnd = withoutScheme.lastIndexOf('@');
    if (authEnd === -1) {
        throw new Error('Invalid mysql connection string: missing credentials');
    }

    const auth = withoutScheme.slice(0, authEnd);
    const hostPath = withoutScheme.slice(authEnd + 1);
    const userEnd = auth.indexOf(':');
    if (userEnd === -1) {
        throw new Error('Invalid mysql connection string: missing password');
    }

    const slash = hostPath.indexOf('/');
    const hostPort = slash === -1 ? hostPath : hostPath.slice(0, slash);
    const databaseAndQuery = slash === -1 ? '' : hostPath.slice(slash + 1);
    const queryStart = databaseAndQuery.indexOf('?');
    const database = queryStart === -1 ?
        databaseAndQuery :
        databaseAndQuery.slice(0, queryStart);
    const query = queryStart === -1 ? '' : databaseAndQuery.slice(queryStart + 1);

    let host = hostPort;
    let port;
    if (hostPort.startsWith('[')) {
        const hostEnd = hostPort.indexOf(']');
        host = hostEnd === -1 ? hostPort : hostPort.slice(1, hostEnd);
        if (hostEnd !== -1 && hostPort[hostEnd + 1] === ':') {
            port = Number(hostPort.slice(hostEnd + 2));
        }
    } else {
        const portStart = hostPort.lastIndexOf(':');
        if (portStart !== -1) {
            host = hostPort.slice(0, portStart);
            port = Number(hostPort.slice(portStart + 1));
        }
    }

    const connection = {
        host: decodeConnectionPart(host),
        user: decodeConnectionPart(auth.slice(0, userEnd)),
        password: decodeConnectionPart(auth.slice(userEnd + 1)),
        database: decodeConnectionPart(database),
    };
    if (port) {
        connection.port = port;
    }

    const params = new URLSearchParams(query);
    if (params.has('charset')) {
        connection.charset = params.get('charset');
    }

    return connection;
}

function isMysqlConnectionString(connectionString) {
    return !!connectionString &&
        (
            connectionString.startsWith('mysql://') ||
            connectionString.startsWith('mariadb://')
        );
}

module.exports = class Database {
    constructor(config) {
        let dbConf = config.get('database', {});

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
            // mysql://user:password@127.0.0.1:3306/database
            usersDbCon = {
                client: 'mysql',
                connection: parseMysqlConnectionString(usersConStr),
                acquireConnectionTimeout: 10000,
            };
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

    async init() {
        await this.dbConnections.migrate.latest({
            directory: path.join(__dirname, '..', 'dbschemas', 'connections'),
        });
        await this.dbUsers.migrate.latest({
            directory: path.join(__dirname, '..', 'dbschemas', 'users'),
        });
    }
}
