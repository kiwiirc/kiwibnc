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
        let val = process.env['BNC_' + key.toUpperCase().replace(/\./g, '_')];
        if (typeof val !== 'undefined') {
            // If the value looks to be a JSON structure, parse it
            if (val[0] === '[' || val[0] === '{' || val[0] === '"') {
                val = JSON.parse(val);
            }

            return val;
        }

        val = _.get(this.c, key);
        if (typeof val === 'object') {
            // Replace any property values if there is an environment var overriding it
            for (let prop in val) {
                let envVal = process.env['BNC_' + (key + '.' + prop).toUpperCase().replace(/\./g, '_')];
                if (typeof envVal !== 'undefined') {
                    // If the value looks to be a JSON structure, parse it
                    if (envVal[0] === '[' || envVal[0] === '{' || envVal[0] === '"') {
                        envVal = JSON.parse(envVal);
                    }

                    val[prop] = envVal;
                }
            }

            return val;
        } else if (typeof val !== 'undefined') {
            return val;
        }

        return def;
    }

    set(key, val) {
        _.set(this.c, key, val);
    }

    static instance(...args) {
        if (!singletonInstance) {
            singletonInstance = new Config(...args);
            singletonInstance.load();
        }

        return singletonInstance;
    }
}
