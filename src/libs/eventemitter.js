class EventEmitter {
    constructor() {
        this.events = Object.create(null);
    }

    addListener(...args) {
        return this.on(...args);
    }
    on(eventName, fn) {
        this.events[eventName] = this.events[eventName] || [];
        this.events[eventName].push(fn);
        return () => {
            this.off(eventName, fn);
        };

        return this;
    }

    once(eventName, fn) {
        let onceOff = this.on(eventName, (...args) => {
            onceOff();
            fn(...args);
        });

        return this;
    }

    removeListener(...args) {
        return this.off(...args);
    }
    off(eventName, fn) {
        if (!fn) {
            delete this.events[eventName];
            return;
        }

        let pos = this.events[eventName].lastIndexOf(fn);
        if (pos > -1) {
            this.events[eventName].splice(pos, 1);
        }

        return this;
    }

    async emit(eventName, eventArgs) {
        let ret = {
            prevent: false,
            skipped: false,
            event: eventArgs,
        };

        let callbacks = this.events[eventName];
        if (!callbacks) {
            return ret;
        }

        // Clone the array so that modifying the main events array doesn't effect
        // the callbacks array we have here
        callbacks = Array.from(callbacks);

        let preventing = false;
        let skipping = false;
        let eventObj = Object.assign({}, eventArgs, {
            preventDefault() {
                // Stop all other events and tell the caller to stop whatever it's trying to do
                ret.prevent = true;
                return this;
            },
            skipFurtherEvents() {
                // Skip all other future events
                ret.skipped = true;
                return this;
            },
        });

        ret.event = eventObj;

        for (let i=0; i<callbacks.length; i++) {
            await callbacks[i](eventObj);
            if (skipping) {
                break;
            }
        }

        return ret;
    }

    listenerCount(eventName) {
        return this.events[eventName] ?
            this.events[eventName].length :
            0;
    }

    listeners(eventName) {
        return this.events[eventName] ?
            Array.from(this.events[eventName]) :
            [];
    }
}

module.exports = EventEmitter;
