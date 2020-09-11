const Queue = require('../libs/queue');

(async function() {

    let socketQ = await init();

    await testRecover(socketQ);

    console.log('Complete.');
    process.exit();
})();

async function init() {
    global.l = function(){};
    global.l.info = global.l.trace = global.l.error = global.l.debug = (...args)=>{
        // we don't need this output
    };

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

    let socketQ = new Queue(conf);

    try {
        await socketQ.initServer();
        socketQ.listenForEvents();
    } catch (err) {
        console.error(`Error connecting to the queue: ${err.message}`);
        process.exit(1);
    }

    return socketQ;
}

async function testRecover(socketQ) {
    let closing = false;
    let onSigint = async () => {
        process.off('SIGINT', onSigint);
        closing = true;
        await socketQ.stopListening();
        process.exit();
    };
    process.on('SIGINT', onSigint);

    function sleep(len) {
        return new Promise(r => {
            setTimeout(r, len);
        });
    }

    let cnt = 1;
    while(1) {
        if (closing) {
            break;
        }

        await socketQ.sendToWorker('myevent', {
            num: String(cnt)
        });
        if (cnt % 3000 === 0) await sleep(50);
        cnt++;
    }
}
