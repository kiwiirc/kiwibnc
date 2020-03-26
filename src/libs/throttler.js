class Throttler {
    constructor(interval, wrapFn=null) {
        this.interval = typeof interval === 'number' ?
            interval :
            1000;
        this.labels = new Object(null);
        this.isTicking = false;
        this.tick();

        if (wrapFn) {
            return this.wrap(wrapFn);
        }
    }

    async waitUntilReady(label) {
        let prom = new Promise((resolve, reject) => {
            this.labels[label] = this.labels[label] || [];
            this.labels[label].push(resolve);
        });

        process.nextTick(this.tick.bind(this));
        return prom;
    }

    tick(ignoreCheck) {
        if (!ignoreCheck && this.isTicking) {
            return;
        }

        this.isTicking = true;

        let numFnsWaiting = 0;
        for (let label in this.labels) {
            let r = this.labels[label].shift();
            if (r) {
                r();
            }

            if (this.labels[label].length === 0) {
                delete this.labels[label];
            } else {
                numFnsWaiting += this.labels[label].length;
            }
        }

        if (numFnsWaiting > 0) {
            this.ticker = setTimeout(this.tick.bind(this), this.interval, true);
        } else {
            this.isTicking = false;
        }
    }

    stop() {
        clearTimeout(this.ticker);
        this.isTicking = false;
    }

    wrap(fn) {
        let wrapLabel = '_wrapped' + (Math.random()*1e17).toString(36);
        let wrappedFn = async function throttledFunction(...args) {
            await wrappedFn.throttler.waitUntilReady(wrapLabel);
            fn(...args);
        };

        wrappedFn.stop = () => this.stop();
        wrappedFn.queueFn = async (fn) => {
            // Add an adhoc function to the throttle queue
            await wrappedFn.throttler.waitUntilReady(wrapLabel);
            fn();
        };
        wrappedFn.throttler = this;
        Object.defineProperty(wrappedFn, 'interval', {
            get() {
                return wrappedFn.throttler.interval;
            },
            set(newVal) {
                wrappedFn.throttler.interval = newVal;
            },
        });

        return wrappedFn;
    }
}

module.exports = Throttler;
