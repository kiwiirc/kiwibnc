const Queue = require('../libs/queue');

(async function() {

    let [ socketQ, workerQ ] = await init(true, true);

    await testSpeed(socketQ, workerQ);
    console.log('Complete.');
    process.exit();
})();

async function init(worker, sockets) {
    global.l = function(){};
    global.l.info = global.l.trace = global.l.error = global.l.debug = (...args)=>{
        // we don't need this output
    };

    let workerQ = new Queue('amqp://localhost', {
        sockets: 'testqueue_sockets',
        worker: 'testqueue_worker',
    });
    let socketQ = new Queue('amqp://localhost', {
        sockets: 'testqueue_sockets',
        worker: 'testqueue_worker',
    });

    try {
        worker && await workerQ.connect();
        sockets && await socketQ.connect();

        worker && workerQ.listenForEvents('testqueue_worker');
        sockets && socketQ.listenForEvents('testqueue_sockets');
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
