const EventEmitter = require('./eventemitter');
const ParallelQueue = require('./ParallelQueue');
const WaitGroup = require('./WaitGroup');
const Stats = require('./stats');
const amqp = require('amqplib/callback_api');
const { args } = require('commander');

module.exports = class Queue extends EventEmitter {
    constructor(conf) {
        super();
        this.host = conf.get('queue.amqp_host', 'amqp://localhost');
        this.queueToSockets = conf.get('queue.sockets_queue', 'q_sockets');
        this.queueToWorker = conf.get('queue.worker_queue', 'q_worker');
        this.channel = null;
        this.consumerTag = '';
        this.closing = false;
        this.closingWg = new WaitGroup();
        this.stats = Stats.instance().makePrefix('queue');
    }

    async connect() {
        let channel = await this.getChannel();
        await channel.assertQueue(this.queueToSockets, {durable: true});
        await channel.assertQueue(this.queueToWorker, {durable: true});
        await channel.prefetch(1000);
        this.channel = channel;
    }

    async initServer() {
        this.queueName = this.queueToSockets;
        await this.connect();
    }

    async initWorker() {
        this.queueName = this.queueToWorker;
        await this.connect();
    }

    async sendToWorker(type, data) {
        if (!this.channel) {
            await this.connect();
        }

        let payload = JSON.stringify([type, data]);
        l.trace('Queue sending to worker:', payload);
        this.stats.increment('sendtoworker');
        this.channel.sendToQueue(this.queueToWorker, Buffer.from(payload), {persistent: true});
    }

    async sendToSockets(type, data) {
        if (!this.channel) {
            await this.connect();
        }

        let payload = JSON.stringify([type, data]);
        l.trace('Queue sending to sockets: ' + payload);
        this.stats.increment('sendtosockets');
        this.channel.sendToQueue(this.queueToSockets, Buffer.from(payload), {persistent: true});
    }

    async listenForEvents() {
        if (!this.channel) {
            await this.connect();
        }

        let queueName = this.queueName;
        this.closing = false;

        l.info('Listening on queue ' + queueName);
        let nextMsgId = 1;
        let q = new ParallelQueue();

        let cnt=0;
        let lastCnt=0;
        let inFlight = 0;
        let processMsgQueue = async () => {
            if (this.closing) {
                return;
            }

            if (inFlight >= 1000) {
                // Limit the number of messages we can process at once
                return;
            }

            let qMessage = q.get();
            if (!qMessage) {
                return;
            }

            this.closingWg.add('listenForEvents');
            let event = qMessage.item.event;
            let messageTmr = this.stats.timerStart('message.received.' + event[0]);

            inFlight++;
            try {
                await this.emit(event[0], event[1]);
            } catch (error) {
                l.error(error.stack);
            }
            inFlight--;

            messageTmr.stop();
            qMessage.ack();
            this.channel.ack(qMessage.item.amqpMsg);

            cnt++;
            if (now() - lastCnt > 5) {
                let queues = q.blocks[0]?.queues;
                let numQueues = queues ? Object.keys(queues).length : 0;
                l.debug(new Date(), 'Messages in 5sec:', cnt, 'inFlight:', inFlight, 'Num. queues:', numQueues);
                lastCnt = now();
                cnt = 0;
            }

            this.closingWg.done('listenForEvents');

            process.nextTick(() => {
                processMsgQueue();
            });
        };

        this.channel.consume(queueName, (msg) => {
            if (this.closing) {
                return;
            }

            // msg can be null in some cases such as a purged queue
            if (!msg) {
                return;
            }

            // consumerTag is the same for every message here, but keeps tabs of it for future
            // use anyway.
            this.consumerTag = msg.fields.consumerTag;

            let id = 'msg' + ++nextMsgId;
            l.trace('Queue received:', id, msg.content.toString());
            let obj = JSON.parse(msg.content.toString());

            // Messages are expected to be an array of 2 items: [event_name, obj_of_params]
            if (!obj || obj.length !== 2) {
                this.stats.increment('message.ignored');
                this.channel.ack(msg);
                return;
            }

            this.stats.increment('message.received');

            // Don't bother emitting if we have no events for it
            if (this.listenerCount(obj[0]) > 0) {
                if (obj[1] && obj[1].id) {
                    // This event is related to a connection ID
                    let conId = obj[1].id;
                    q.add('connection', conId, {amqpMsg: msg, event: obj});
                } else {
                    // An internal bnc event
                    q.add('bnc', 'internal', {amqpMsg: msg, event: obj});
                }

            } else {
                this.channel.ack(msg);
            }

            process.nextTick(() => {
                processMsgQueue();
            });
        }, {noAck: false, exclusive: false});
    }

    stopListening() {
        this.closing = true;

        return new Promise((resolve, reject) => {
            this.stats.increment('stopping');

            if (!this.consumerTag) {
                resolve();
                return;
            }

            this.closingWg.add('channel.cancel');
            this.channel.cancel(this.consumerTag, (err, ok) => {
                this.closingWg.done('channel.cancel');
                resolve();
            });
        })
        .then(() => this.closingWg.wait());
    }

    getChannel() {
        return new Promise((resolve, reject) => {
            this.stats.increment('connecting');
            let connectTmr = this.stats.timerStart('connecting.time');

            amqp.connect(this.host, (err, conn) => {
                connectTmr.stop();

                if (err) {
                    this.stats.increment('connecting.fail');
                    reject(err);
                    return;
                }

                this.stats.increment('connecting.success');
                this.stats.increment('connecting.time');
                conn.createChannel((err, channel) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    resolve(channel);
                });
            });
        });
    }
}


function now() {
    return Math.floor(Date.now() / 1000);
}


