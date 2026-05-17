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

        // Set the data path now so that any relativePath() calls use it correctly
        if (confObj.data_dir) {
            this.baseDir = path.resolve(confObj.data_dir);
        } else {
            // Relative to the config file
            this.baseDir = path.resolve(path.dirname(this.filePath));
        }

        this.emit('loaded', confObj);
        this.c = confObj;
        this.emit('updated');
    }

    get(key, def) {
        let envKey = 'BNC_' + key.toUpperCase().replace(/\./g, '_');
        let directEnvVal = process.env[envKey];
        if (typeof directEnvVal !== 'undefined') {
            return this.parseEnvValue(directEnvVal);
        }

        let val = _.get(this.c, key);
        if (typeof val === 'undefined') {
            let envPrefix = 'BNC_' + key.toUpperCase().replace(/\./g, '_') + '_';
            for (let envName in process.env) {
                if (!envName.startsWith(envPrefix)) {
                    continue;
                }

                val = val || {};
                let prop = envName.slice(envPrefix.length).toLowerCase();
                if (prop) {
                    val[prop] = this.parseEnvValue(process.env[envName]);
                }
            }
        }

        if (typeof val === 'object') {
            // Replace any property values if there is an environment var overriding it
            for (let prop in val) {
                let envVal = process.env['BNC_' + (key + '.' + prop).toUpperCase().replace(/\./g, '_')];
                if (typeof envVal !== 'undefined') {
                    val[prop] = this.parseEnvValue(envVal);
                }
            }

            let envPrefix = 'BNC_' + key.toUpperCase().replace(/\./g, '_') + '_';
            for (let envName in process.env) {
                if (!envName.startsWith(envPrefix)) {
                    continue;
                }

                let prop = envName.slice(envPrefix.length).toLowerCase();
                if (prop && typeof val[prop] === 'undefined') {
                    val[prop] = this.parseEnvValue(process.env[envName]);
                }
            }

            return val;
        } else if (typeof val !== 'undefined') {
            return val;
        }

        return def;
    }

    parseEnvValue(envVal) {
        // If the value looks to be a JSON structure, parse it
        if (envVal[0] === '[' || envVal[0] === '{' || envVal[0] === '"') {
            return JSON.parse(envVal);
        }

        return envVal;
    }

    loadDotFile(dotfile) {
        let content = '';
        let filename = dotfile || process.env.DOTFILE || '.env';
        if (!filename) {
            return;
        }

        try  {
            // the dotfile is always by the side of the config file
            let configFilePath = path.dirname(this.filePath);
            let filePath = path.resolve(path.join(configFilePath, filename));
            content = fs.readFileSync(filePath, 'utf8');
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
