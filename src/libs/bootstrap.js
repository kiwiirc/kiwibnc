const Queue = require('../libs/queue');
const Config = require('../libs/config');

let logLabel = '[]';
function l(...args) {
    console.log.apply(console, [(new Date()).toTimeString().split(' ')[0], logLabel, ...args]);
}

module.exports = async function bootstrap(label) {
    // Helper global logger
    logLabel = `[${label||''}]`;
    global.l = l;

    l(`## Starting ${label} ##`);

    let confPath = process.args.config || './config.ini';
    let conf = null;
    try {
        conf = Config.instance(confPath);
    } catch (err) {
        if (err.name && err.name === 'SyntaxError') {
            console.error(`Error parsing ${confPath}. Syntax error on line ${err.line}, column ${err.column}`);
            console.error(err.message);
        } else if (err.code === 'ENOENT') {
            console.error(`Error opening config file ${confPath}`);
        } else {
            console.error(err.message);
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
