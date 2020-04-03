const IpcQueue = require('../libs/ipcqueue');
const AmqpQueue = require('../libs/queue');
const Stats = require('../libs/stats');
const Config = require('../libs/config');
const createLogger = require('../libs/logger');

module.exports = async function bootstrap(label, opts={}) {
    process.title = 'kiwibnc-' + label;

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

    let queue = null;
    if (conf.get('queue.amqp_host')) {
        l.info('Using queue rabbitmq');
        queue = new AmqpQueue(conf);
    } else {
        l.info('Using queue IPC');
        queue = new IpcQueue(conf);
    }

    try {
        if (opts.type === 'server') {
            await queue.initServer();
        } else if (opts.type === 'worker') {
            await queue.initWorker();
        }
    } catch (err) {
        console.error(`Error connecting to the queue: ${err.message}`);
        console.error(err);
        process.exit(1);
    }

    return {
        conf,
        queue,
        stats,
    }
}
