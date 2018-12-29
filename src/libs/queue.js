const EventEmitter = require('events');
const amqp = require('amqplib/callback_api');

module.exports = class Queue extends EventEmitter {
    constructor(amqpHost, opts={sockets:'', worker:''}) {
        super();
        this.host = amqpHost || 'amqp://localhost';
        this.queueToSockets = opts.sockets || 'control';
        this.queueToWorker = opts.worker || 'connections';
        this.channel = null;
        this.consumerTag = '';
        this.closing = false;
    }

    async connect() {
        let channel = await this.getChannel();
        channel.assertQueue(this.queueToSockets, {durable: true});
        channel.assertQueue(this.queueToWorker, {durable: true});
        this.channel = channel;
    }

    async sendToWorker(type, data) {
        if (!this.channel) {
            await this.connect();
        }

        let payload = JSON.stringify([type, data]);
        l('Queue sending to worker:', payload);
        this.channel.sendToQueue(this.queueToWorker, Buffer.from(payload), {persistent: true});
    }

    async sendToSockets(type, data) {
        if (!this.channel) {
            await this.connect();
        }

        let payload = JSON.stringify([type, data]);
        l('Queue sending to sockets:', payload);
        this.channel.sendToQueue(this.queueToSockets, Buffer.from(payload), {persistent: true});
    }

    async listenForEvents(queueName) {
        if (!this.channel) {
            await this.connect();
        }

        this.closing = false;

        l('Listening on queue ' + queueName);
        this.channel.consume(queueName, (msg) => {
            if (this.closing) {
                return;
            }

            this.consumerTag = msg.fields.consumerTag;
            l('Queue recieved:', msg.content.toString());
            let obj = JSON.parse(msg.content.toString());
            if (obj && obj.length === 2) {
                let ackMsg = () => {
                    this.channel.ack(msg);
                };
                this.emit(obj[0], obj[1], ackMsg);
            }

            this.channel.ack(msg);
        }, {noAck: false, exclusive: true});
    }

    stopListening() {
        return new Promise((resolve, reject) => {
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
            amqp.connect(this.host, (err, conn) => {
                if (err) {
                    reject(err);
                    return;
                }

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
