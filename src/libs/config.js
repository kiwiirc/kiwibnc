const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const toml = require('toml');
const _ = require('lodash');

let singletonInstance = null;

module.exports = class Config extends EventEmitter {
    constructor(workDir, filePath) {
        super();
        this.filePath = filePath;
        this.baseDir = workDir;
        this.c = {};
        this.env = {};
    }

    relativePath(pathInp) {
        // Keep absolute paths as absolute
        if (pathInp[0] === '/') {
            return pathInp;
        }

        return path.join(this.baseDir, pathInp);
    }

    load() {
        let confContent = fs.readFileSync(this.filePath).toString();
        // Load a .env file of overriding environment vars
        this.loadDotFile();

        // Replace $ENV_VAR with the environment var VAR in the config file
        confContent = confContent.replace(/\$ENV_([a-zA-Z0-9_]+)?/gm, (m, varName) => {
            return this.env[varName] || process.env[varName] || '';
        });

        let confObj = toml.parse(confContent);

        this.emit('loaded', confObj);
        this.c = confObj;
        this.emit('updated');
    }

    get(key, def) {
        let val = _.get(this.c, key);
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

    loadDotFile(dotfile) {
        let content = '';
        let filename = dotfile || process.env.DOTFILE || '.env';
        if (!filename) {
            return;
        }

        try  {
            content = fs.readFileSync(this.relativePath(filename), 'utf8');
        } catch (err) {
            return;
        }

        // Remove empty lines and #comment lines
        let lines = content.split('\n')
            .map(line => line.trim())
            .filter(line => !!line)
            .filter(line => line[0] !== '#');

        lines.forEach(line => {
            let pos = line.indexOf('=');
            if (pos === -1) {
                return;
            }

            let key = line.substr(0, pos).trim();
            let val = '';
            for (let i=pos+1; i<line.length;i++) {
                val += line[i];
            }

            this.env[key] = val.trim();
        });
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
