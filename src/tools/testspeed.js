const Queue = require('../libs/queue');
const IpcQueue = require('../libs/ipcqueue');

(async function() {

    let [ socketQ, workerQ ] = await init(true, true);

    await testSpeed(socketQ, workerQ);
    console.log('Complete.');
    process.exit();
})();

async function init(worker, sockets) {
    global.l = function(){};
    global.l.info = global.l.trace = global.l.error = global.l.debug = (...args)=>{
        // console.log(...args);
        // we don't need this output
    };

    // Mock the config object
    let conf = {
        data: {
            'queue.amqp_host': 'amqp://127.0.0.1',
            'queue.sockets_queue': 'q_sockets',
            'queue.worker_queue': 'q_worker',
        },
        get(name) {
            return this.data[name];
        },
    };

    let workerQ = null;
    let socketQ = null;

    if (conf.get('queue.amqp_host')) {
        workerQ = new Queue(conf);
        socketQ = new Queue(conf);
    } else {
        workerQ = new IpcQueue(conf);
        socketQ = new IpcQueue(conf);
    }

    try {
        worker && await workerQ.initWorker();
        sockets && await socketQ.initServer();

        worker && workerQ.listenForEvents();
        sockets && socketQ.listenForEvents();
    } catch (err) {
        console.error(`Error connecting to the queue: ${err.message}`);
        process.exit(1);
    }

    return [ socketQ, workerQ ];
}

async function testSpeed(socketQ, workerQ) {
    async function sendMessage() {
        return new Promise(async (resolve) => {
            workerQ.once('myevent', (event) => {
                resolve();
            });

            await socketQ.sendToWorker('myevent', 'payload data');
        });
    }

    let maxRuns = 10;
    let currentRun = 1;
    let runs = [];
    let cnt = 0;

    let tmr = setInterval(() => {
        console.log(`Run ${currentRun}/${maxRuns} ${cnt}/s`);
        runs.push(cnt);
        cnt = 0;

        if (currentRun >= maxRuns) {
            clearInterval(tmr);
            tmr = null;
        }
        currentRun++;
    }, 1000);

    console.log('Benchmarking messages sent and received per second...');
    while(tmr) {
        await sendMessage();
        cnt++;
    }

    let sum = runs.reduce((prev, cur, idx, arr) => prev + cur, 0);
    let avg = Math.floor(sum / runs.length);
    console.log(`Average ${avg} messages each second`);
}
