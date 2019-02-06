module.exports = watcher;

// Used to watch an object activity (getters/setters/deletions) via a Proxy
function watcher(label, d) {
    function decorateProp(prop) {
        if (typeof prop !== 'string') {
            return `(${typeof prop})`;
        }

        if (prop.indexOf('.') > -1) {
            return `[${prop}]`;
        }

        return `.${prop}`;
    }

    return new Proxy(d || {}, {
        get(obj, prop) {
            console.log(label + decorateProp(prop), 'get()', obj[prop]);
            return obj[prop];
        },
        set(obj, prop, val) {
            console.log(label + decorateProp(prop), 'set()', val);
            if (typeof val === 'object') {
                obj[prop] = watcher(`${label}${decorateProp(prop)}`, val);
            } else {
                obj[prop] = val;
            }
            return true;
        },
        deleteProperty(obj, prop) {
            console.log(label + decorateProp(prop), 'delete()');
            delete obj[prop];
        },
    });
}
