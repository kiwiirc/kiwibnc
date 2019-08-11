const crypto = require('crypto')
const zerorpc = require('zerorpc');
const Stats = require('./stats');
const EventEmitter = require('./eventemitter');

module.exports = class IpcQueue extends EventEmitter {
    constructor(conf) {
        super();
        this.toWorkerQueue = [];
        this.toWorkerQueueWaits = [];
        this.server = null;
        this.client = null;
        this.stats = Stats.instance().makePrefix('queue');

        // If a queue channel hasn't specifically been set, auto generate them
        if (!conf.get('queue.ipc_bind')) {
            // Use the database crypt_key setting to seed any queue names. This must
            // be done so that multiple instances of kiwibnc do not clash
            let cryptKey = conf.get('database.crypt_key', 'kiwibnc');
            let ipcChannelSeed = crypto.createHash('md5')
                .update(cryptKey + 'random string')
                .digest('hex');

            if (process.platform === 'win32') {
                // IPC on windows isn't supported, fall back to TCP
                // Generate the port from the hash. Using the first 3 chars as a hex value
                // and adding 2000 to ensure it is above the 1024 port value
                let port = parseInt(ipcChannelSeed.substr(0, 3), 16) + 2000
                this.serverBind = 'tcp://127.0.0.1:' + port;
                this.serverAddr = 'tcp://127.0.0.1:' + port;
            } else {
                let ipcChannel = ipcChannelSeed;
                this.serverBind = 'ipc://kiwibnc_' + ipcChannel;
                this.serverAddr = 'ipc://kiwibnc_' + ipcChannel;
            }
        } else {
            this.serverBind = conf.get('queue.ipc_bind', '');
            this.serverAddr = conf.get('queue.ipc_addr', this.serverBind);
        }
    }

    sendToWorker(type, data) {
        let payload = JSON.stringify([type, data]);
        l.trace('Queue sending to worker:', payload);
        this.stats.increment('sendtoworker');

        if (this.toWorkerQueueWaits.length > 0) {
            let pResolve = this.toWorkerQueueWaits.shift();
            pResolve(payload);
        } else {
            this.toWorkerQueue.push(payload);
        }
    }
    sendToSockets(type, data) {
        let payload = JSON.stringify([type, data]);
        l.trace('Queue sending to sockets: ' + payload);
        this.stats.increment('sendtosockets');

        this.client.invoke('message', payload, (error, result, more) => {
            if (error) {
                l.error('zeroMQ error:', error);
            }
        });
    }

    getNextWorkerQueueItem() {
        l.trace('getNextWorkerQueueItem() queue length =', this.toWorkerQueue.length);
        if (this.toWorkerQueue.length > 0) {
            return Promise.resolve(this.toWorkerQueue.shift());
        }

        // Wait until some data is available to send to the worker
        return new Promise((resolve, reject) => {
            // sendToWorker() will pick this up and call it when ready
            let callback = (payload) => {
                clearTimeout(timeout);
                resolve(payload);
            };
            this.toWorkerQueueWaits.push(callback);

            // We need to time it out so that it's not hanging forever
            let timeout = setTimeout(() => {
                this.toWorkerQueueWaits = this.toWorkerQueueWaits.filter(cb => cb !== callback);
                reject('timeout');
            }, 3000);
        });
    }

    async initServer() {
        let that = this;
        this.server = new zerorpc.Server({
            getMessage: function(arg1, reply) {
                that.getNextWorkerQueueItem()
                .then(item => {
                    reply(null, item);
                })
                .catch(err => {
                    if (err !== 'timeout') {
                        l.error('getNextWorkerQueueItem() error', err);
                    }

                    reply(null, '');
                });
            },
            message: function(payload, reply) {
                // message from a worker
                that.triggerPayload(payload).then(() => {
                    reply(null);
                });
            },
        });

        l.debug('initServer() using zeroMQ channel', this.serverBind);
        this.stats.increment('connecting');
        this.server.bind(this.serverBind);
    }

    async initWorker() {
        this.client = new zerorpc.Client();
        l.debug('initWorker() using zeroMQ channel', this.serverAddr);
        this.stats.increment('connecting');
        this.client.connect(this.serverAddr);
    }

    async listenForEvents() {
        // initServer() already bound server RPC handlers so we only need to start
        // listening for the worker. Workers have a this.client zeroMQ client instance
        if (!this.client) {
            return;
        }

        let getNextItem = () => {
            this.client.invoke('getMessage', '', (error, res, more) => {
                // message from a sockets server
                if (error) {
                    l.error('zeroMQ getMessage() error', error);
                    process.nextTick(getNextItem);
                    return;
                }

                this.triggerPayload(res).then(() => {
                    process.nextTick(getNextItem);
                });
            });
        };

        process.nextTick(getNextItem);
    }

    async triggerPayload(payload) {
        l.debug('Queue received:', payload);
        let obj = null;
        try {
            obj = JSON.parse(payload);
        } catch (err) {
            // Ignore JSON parse errors
        }
        if (!obj || obj.length !== 2) {
            this.stats.increment('message.ignored');
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
    }

    stopListening() {
        l.trace('stopListening()');
        return new Promise((resolve) => {
            this.stats.increment('stopping');

            if (this.client) {
                this.client.close();
            }

            if (this.server) {
                this.server.close();
            }

            resolve();
        });
    }
}
