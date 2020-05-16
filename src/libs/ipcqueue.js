const crypto = require('crypto')
const rpc = require('rpc-over-ipc');
const Stats = require('./stats');
const EventEmitter = require('./eventemitter');

module.exports = class IpcQueue extends EventEmitter {
    constructor(conf) {
        super();
        this.isWorker = false;
        this.toWorkerQueue = [];
        this.toWorkerQueueWaits = [];
        this.stopPromise = null;
        this.stats = Stats.instance().makePrefix('queue');
    }

    sendToWorker(type, data) {
        let payload = JSON.stringify([type, data]);
        l.trace('Queue sending to worker:', payload);
        this.stats.increment('sendtoworker');

        if (this.toWorkerQueueWaits.length > 0) {
            // There are promises waiting for worker data, resolve one of them with the payload
            let pResolve = this.toWorkerQueueWaits.shift();
            pResolve(payload);
        } else {
            // Nothing waiting for worker data yet, add payload to the queue ready to be picked up
            this.toWorkerQueue.push(payload);
        }
    }
    sendToSockets(type, data) {
        let payload = JSON.stringify([type, data]);
        l.trace('Queue sending to sockets: ' + payload);
        this.stats.increment('sendtosockets');

        rpc.call(process, 'message', [payload], (error, result) => {
            if (error) {
                l.error('RPC error:', error);
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
        let failedReplies = [];
        this.on('_workerProcess', event => {
            let workerClosed = false;
            let workerProc = event.workerProc;

            workerProc.on('exit', () => {
                workerClosed = true;
            });

            rpc.register(workerProc, 'getMessage', (reply) => {
                if (failedReplies.length > 0) {
                    let item = failedReplies.shift();
                    reply(null, item);
                    return;
                }

                this.getNextWorkerQueueItem()
                .then(item => {
                    if (workerClosed) {
                        l.debug('Worker process closed, queing up reply for next worker');
                        failedReplies.push(item);
                        return;
                    }

                    reply(null, item);
                })
                .catch(err => {
                    // timeout = no new messages for a worker yet. not a bad thing
                    if (err !== 'timeout') {
                        l.error('getNextWorkerQueueItem() error', err);
                    }

                    // It doesn't matter if a worker doesn't get this reply as there's no data in it
                    if (!workerClosed) {
                        reply(null, '');
                    }
                });
            });
            
            rpc.register(workerProc, 'message', (payload, reply) => {
                // message from a worker
                this.triggerPayload(payload).then(() => {
                    reply(null);
                });
            });
        });

        l.debug('initServer()');
    }

    async initWorker() {
        if (!process.send) {
            throw new Error('This is not a worker process');
        }

        this.isWorker = true;
    }

    async listenForEvents() {
        if (!this.isWorker) {
            return;
        }

        let getNextItem = () => {
            rpc.call(process, 'getMessage', (error, message) => {
                // message from a sockets server
                if (error) {
                    l.error('RPC getMessage() error', error);
                    process.nextTick(getNextItem);
                    return;
                }

                this.triggerPayload(message).then(() => {
                    if (this.stopPromise) {
                        // Waiting to stop listening for events, stop now
                        this.stopPromise.resolve();
                        this.stopPromise = null;
                    } else {
                        process.nextTick(getNextItem);
                    }
                });
            });
        };

        process.nextTick(getNextItem);
    }

    async triggerPayload(payload) {
        l.trace('Queue received:', payload);
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
            this.stopPromise = { resolve };
        });
    }
}
