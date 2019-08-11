const EventEmitter = require('./eventemitter');
const Stats = require('./stats');
const amqp = require('amqplib/callback_api');

module.exports = class Queue extends EventEmitter {
    constructor(conf) {
        super();
        this.host = conf.get('queue.amqp_host', 'amqp://localhost');
        this.queueToSockets = conf.get('queue.sockets_queue', 'control');
        this.queueToWorker = conf.get('queue.worker_queue', 'connections');
        this.channel = null;
        this.consumerTag = '';
        this.closing = false;
        this.stats = Stats.instance().makePrefix('queue');
    }

    async connect() {
        let channel = await this.getChannel();
        await channel.assertQueue(this.queueToSockets, {durable: true});
        await channel.assertQueue(this.queueToWorker, {durable: true});
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
        let msgQueue = [];
        let processing = false;

        let processNext = () => {
            processing = false;
            processMsgQueue();
        };

        let processMsgQueue = async () => {
            if (processing) {
                return;
            }

            if (msgQueue.length === 0) {
                processing = false;
                return;
            }

            processing = true;

            let id = 'msg' + ++nextMsgId;
            let msg = msgQueue.shift();
            l.debug('Queue received:', id, msg.content.toString());
            let obj = JSON.parse(msg.content.toString());

            if (!obj || obj.length !== 2) {
                this.stats.increment('message.ignored');
                this.channel.ack(msg);
                processNext();
                return;
            }

            this.stats.increment('message.received');
            let messageTmr = this.stats.timerStart('message.received.' + obj[0]);

            // Don't bother emitting if we have no events for it
            if (this.listenerCount(obj[0]) > 0) {
                try {
                    await this.emit(obj[0], obj[1]);
                } catch (error) {
                    l.error(error.stack);
                }
            }

            messageTmr.stop();
            this.channel.ack(msg);
            processNext();
        }

        this.channel.consume(queueName, (msg) => {
            if (this.closing) {
                return;
            }

            
            this.consumerTag = msg.fields.consumerTag;
            msgQueue.push(msg);
            processMsgQueue();
        }, {noAck: false, exclusive: true});
    }

    stopListening() {
        return new Promise((resolve, reject) => {
            this.stats.increment('stopping');
            this.closing = true;

            if (!this.consumerTag) {
                resolve();
                return;
            }

            this.channel.cancel(this.consumerTag, (err, ok) => {
                resolve();
            });
        });
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
