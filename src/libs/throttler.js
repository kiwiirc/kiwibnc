class Throttler {
    constructor(interval) {
        this.interval = interval || 1000;
        this.labels = new Object(null);
        this.tick();
    }

    async waitUntilReady(label) {
        return new Promise((resolve, reject) => {
            this.labels[label] = this.labels[label] || [];
            this.labels[label].push(resolve);
        });
    }

    tick() {
        for (let label in this.labels) {
            let r = this.labels[label].shift();
            if (r) {
                r();
            }

            if (this.labels[label].length === 0) {
                delete this.labels[label];
            }
        }

        this.ticker = setTimeout(this.tick.bind(this), this.interval);
    }
}

module.exports = Throttler;
