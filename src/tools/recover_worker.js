const fs = require('fs');
const Queue = require('../libs/queue');

(async function() {
    global.l = function(){};
    global.l.info = global.l.trace = global.l.error = global.l.debug = (...args)=>{
        //console.log(...args);
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

    let workerQ = new Queue(conf);

    try {
        await workerQ.connect();

        workerQ.listenForEvents();
    } catch (err) {
        console.error(`Error connecting to the queue: ${err.message}`);
        process.exit(1);
    }

    let expectValue = '';
    try {
        expectValue = fs.readFileSync('./lastmessage.txt') || '';
    } catch (err) {
        expectValue = '';
    }

    if (expectValue) {
        expectValue = parseInt(expectValue, 10);
        expectValue = isNaN(expectValue) ?
            '' :
            String(expectValue + 1);
    }

    workerQ.on('myevent', (event) => {
        let val = event.num;
        if (typeof val !== 'string') {
            return;
        }

        if (expectValue) {
            if (val === expectValue) {
                console.log('Found correct value of ' + expectValue);
            } else {
                console.log('Did not find the correct value of ' + expectValue + '. Instead found ' + val);
            }

            expectValue = null;
        }

        fs.writeFileSync('./lastmessage.txt', val);
    });
})();
