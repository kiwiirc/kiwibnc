class Throttler {
    constructor(interval, wrapFn=null) {
        this.interval = typeof interval === 'number' ?
            interval :
            1000;
        this.labels = new Object(null);
        this.tick();

        if (wrapFn) {
            return this.wrap(wrapFn);
        }
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

    stop() {
        clearTimeout(this.ticker);
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
