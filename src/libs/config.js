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

    relativePath(pathInp) {
        // Keep absolute paths as absolute
        if (pathInp[0] === '/') {
            return pathInp;
        }

        return path.join(this.baseDir, pathInp);
    }

    load() {
        let confContent = fs.readFileSync(this.filePath);
        let confObj = toml.parse(confContent.toString());

        this.emit('loaded', confObj);
        this.c = confObj;
        this.emit('updated');
    }

    get(key, def) {
        let val = process.env[key.toUpperCase()];
        if (typeof val !== 'undefined') {
            // If the value looks to be a JSON structure, parse it
            if (val[0] === '[' || val[0] === '{' || val[0] === '"') {
                val = JSON.parse(val);
            }

            return val;
        }

        val = _.get(this.c, key);
        if (typeof val !== 'undefined') {
            return val;
        }

        return def;
    }

    static instance(...args) {
        if (!singletonInstance) {
            singletonInstance = new Config(...args);
            singletonInstance.load();
        }

        return singletonInstance;
    }
}
