const dgram = require('dgram');

let instance = null;

module.exports = class Stats {
    constructor(opts) {
        this.opts = opts;

        if (opts.host) {
            let [host, port] = (opts.host || '').split(':');
            port = parseInt(port, 10);
            if (isNaN(port)) {
                port = 0;
            }

            this.port = port;
            this.host = host;
        } else {
            this.port = 0;
            this.host = '';
        }

        this.prefix = opts.prefix ?
            opts.prefix + '.' :
            '';

        // dgramSocket lazily created within write()
        this.dgramSocket = null;

        // Keep a reference to the root Stats instance as makePrefix() creates new instances
        this.rootStats = opts.rootStats || this;
    }

    increment(key, delta=1) {
        this.write(`${this.prefix}${key}:${delta}|c`);
    }

    gauge(key, value) {
        this.write(`${this.prefix}${key}:${value}|g`);
    }

    timer(key, ms) {
        this.write(`${this.prefix}${key}:${ms}|ms`);
    }

    timerStart(key) {
        let start = Date.now();
        let stop = () => {
            this.timer(key, Date.now() - start);
        };

        return { stop };
    }

    write(line) {
        if (this.port && this.host) {
            this.rootStats.dgramSocket = this.rootStats.dgramSocket || dgram.createSocket('udp4');
            this.rootStats.dgramSocket.send(Buffer.from(line), this.port, this.host);
        }
    }

    makePrefix(newPrefix) {
        return new Stats({
            ...this.opts,
            prefix: this.prefix + newPrefix,
            rootStats: this.rootStats,
        });
    }

    static instance(...args) {
        instance = instance || new Stats(...args);
        return instance;
    }
}
