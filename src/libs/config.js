const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const toml = require('toml');
const _ = require('lodash');

let singletonInstance = null;

module.exports = class Config extends EventEmitter {
    constructor(filePath) {
        super();
        this.filePath = filePath;
        this.baseDir = path.resolve(path.dirname(filePath));
        this.c = {};
    }

    load() {
        let confContent = fs.readFileSync(this.filePath);
        let confObj = toml.parse(confContent.toString());

        this.emit('loaded', confObj);
        this.c = confObj;
        this.emit('updated');
    }

    get(key, def) {
        let val = _.get(this.c, key);
        return typeof val === 'undefined' ?
            def :
            val;
    }

    static instance(...args) {
        if (!singletonInstance) {
            singletonInstance = new Config(...args);
            singletonInstance.load();
        }

        return singletonInstance;
    }
}
