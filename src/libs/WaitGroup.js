// WaitGrop ported from Golang.

module.exports = class WaitGroup {
    constructor() {
        this.finished = false;
        this.count = 0;
        this.waits = [];
        this.l = [];
        this.debug = false;
    }

    add(l) {
        this.count++;
        if (this.debug) {
            this.l.push(l);
            console.log('Added:', l, 'Remaining:', this.count, this.l.join(' '));
        }
    }

    done(l) {
        if (this.count <= 0) {
            throw new Error('WaitGroup count cannot be below 0');
        }
        this.count--;
        if (this.debug) {
            let idx = this.l.indexOf(l);
            if (idx > -1) this.l.splice(idx, 1);
        }
        this.debug && console.log('Done:', l, 'Remaining:', this.count, this.l.join(' '));
        this.checkCount();
    }

    wait() {
        if (this.finished || this.count === 0) {
            return Promise.resolve();
        }

        this.finished = true;
        return new Promise(resolve => {
            this.waits.push(resolve);
            this.debug && setInterval(() => {
                console.log(this.count, this.l.join(' '));
            }, 1000);
        });
    }

    checkCount() {
        if (this.finished) {
            return;
        }

        if (this.count === 0) {
            this.debug && console.log(`WaitGroup at 0. Calling ${this.waits.length} waits`);
            this.waits.forEach(r => r());
        }
    }
}
