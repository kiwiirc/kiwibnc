const Queue = require('../libs/queue');
const Config = require('../libs/config');

function createLogger(label) {
    let logLabel = `[${label||''}]`;
    let out = function(...args) {
        console.log(...[(new Date()).toTimeString().split(' ')[0], logLabel, ...args]);
    };
    let outErr = function(...args) {
        console.error(...[(new Date()).toTimeString().split(' ')[0], logLabel, ...args]);
    };

    // Allow logger() logger.warn() logger.info() etc
    let logger = function(...args) {
        logger.info(...args);
    };

    let levels = logger.levels = {
        trace: 0,
        debug: 1,
        info: 2,
        notice: 3,
        warn: 4,
        error: 5,
    };
    logger.level = logger.levels.notice;
    logger.colour = true;

    let levelTooLow = (level) => {
        return logger.level > level;
    };

    let colours = {
        black: '\x1b[30m',
        red: '\x1b[31m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        blue: '\x1b[34m',
        magenta: '\x1b[35m',
        cyan: '\x1b[36m',
        white: '\x1b[37m',
        reset: '\x1b[0m',
    };
    let colourWrap = (text, colour) => {
        return logger.colour ?
            colours[colour] + text + colours.reset :
            text;
    };

    // Logging to different levels
    logger.trace = function(...args) {
        if (levelTooLow(levels.trace)) return;
        out(colourWrap('l_trace', 'yellow'), ...args);
    };
    logger.debug = function(...args) {
        if (levelTooLow(levels.debug)) return;
        out(colourWrap('l_debug', 'yellow'), ...args);
    };
    logger.info = function(...args) {
        if (levelTooLow(levels.info)) return;
        out(colourWrap('l_info', 'green'), ...args);
    };
    logger.notice = function(...args) {
        if (levelTooLow(levels.notice)) return;
        out(colourWrap('l_notice', 'magenta'), ...args);
    };
    logger.warn = function(...args) {
        if (levelTooLow(levels.warn)) return;
        out(colourWrap('l_warn', 'red'), ...args);
    };
    logger.error = function(...args) {
        if (levelTooLow(levels.error)) return;
        outErr(colourWrap('l_error', 'red'), ...args);
    };

    return logger;
}

module.exports = async function bootstrap(label) {
    // Helper global logger
    global.l = createLogger(label);
    global.l.level = global.l.levels.debug;
    global.l.colour = false;

    l(`## Starting ${label} ##`);

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

    let queue = new Queue(conf.get('queue.host', 'amqp://localhost'), {
        sockets: conf.get('queue.sockets_queue'),
        worker: conf.get('queue.worker_queue'),
    });

    try {
        await queue.connect();
    } catch (err) {
        console.error(`Error connecting to the queue: ${err.message}`);
        process.exit(1);
    }

    return {
        conf,
        queue,
    }
}
