const fs = require('fs-extra');
const IpcQueue = require('../libs/ipcqueue');
const AmqpQueue = require('../libs/queue');
const Stats = require('../libs/stats');
const Config = require('../libs/config');
const Database = require('../libs/database');
const Users = require('../worker/users');
const Crypt = require('../libs/crypt');
const createLogger = require('../libs/logger');

module.exports = async function bootstrap(label) {
    process.title = 'kiwibnc-' + label;

    await prepareConfig();

    // Helper global logger
    global.l = createLogger(label);
    global.l.level = global.l.levels.debug;
    global.l.colour = false;

    l.debug(`Starting ${label}`);

    let confPath = process.args.config || './config.ini';
    let conf = null;
    try {
        l.info(`Using config file ${confPath}`);
        conf = Config.instance(confPath);

        // Set some logging config for the rest of the logging output
        l.level = l.levels[conf.get('log.level', 'info')];
        l.colour = conf.get('log.colour', false);
    } catch (err) {
        if (err.name && err.name === 'SyntaxError') {
            l.error(`Error parsing ${confPath}. Syntax error on line ${err.line}, column ${err.column}`);
            l.error(err.message);
        } else if (err.code === 'ENOENT') {
            l.error(`Error opening config file ${confPath}`);
        } else {
            l.error(err);
        }
        process.exit(0)
    }

    let statsConfig = conf.get('stats', {});
    statsConfig.prefix = statsConfig.prefix ?
        'bnc.' + statsConfig.prefix + '.' + label :
        'bnc.' + label;

    // Create the defualt Stats instance withour config
    let stats = Stats.instance(statsConfig);
    stats.increment('processstart');

    let app = {
        conf,
        stats,
        initDatabase: () => initDatabase(app),
        initQueue: (type) => initQueue(app, type),
    }

    return app;
}

async function initQueue(app, type) {
    let queue = null;
    if (app.conf.get('queue.amqp_host')) {
        l.info('Using queue rabbitmq');
        queue = new AmqpQueue(app.conf);
    } else {
        l.info('Using queue IPC');
        queue = new IpcQueue(app.conf);
    }

    try {
        if (type === 'server') {
            await queue.initServer();
        } else if (type === 'worker') {
            await queue.initWorker();
        }
    } catch (err) {
        console.error(`Error connecting to the queue: ${err.message}`);
        process.exit(1);
    }

    app.queue = queue;
};

async function initDatabase(app) {
    let cryptKey = app.conf.get('database.crypt_key', '');
    if (cryptKey.length !== 32) {
        console.error('Cannot start: config option database.crypt_key must be 32 characters long');
        process.exit(1);
    }
    app.crypt = new Crypt(cryptKey);

    app.db = new Database(app.conf);
    await app.db.init();

    app.userDb = new Users(app.db);
    app.db.users = app.userDb;

    app.db.factories.Network = require('../libs/dataModels/network').factory(app.db, app.crypt);
    app.db.factories.User = require('../libs/dataModels/user').factory(app.db);
}

async function prepareConfig() {
    let configOption = process.args.options.find(o => o.long === '--config');
    let isDefaultConfig = (configOption && process.args.config === configOption.defaultValue);
    let configExists = await fs.pathExists(process.args.config);

    if (configExists) {
        return;
    }

    if (!isDefaultConfig && !configExists) {
        console.error('Config file does not exist,', process.args.config);
        process.exit(1);
    }

    if (isDefaultConfig) {
        let configPath = path.dirname(process.args.config);
        console.log('Creating new config profile at ' + configPath);
        try {
            await fs.copy(path.join(__dirname, '../configProfileTemplate'), configPath);
        } catch (err) {
            console.error('Failed to create new config profile.', err.message);
            process.exit(1);
        }
    }
}
