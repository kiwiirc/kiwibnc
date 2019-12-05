class DatabaseSavable {
    constructor(db) {
        this._db = db;
        this._table = this.constructor.table;
        this._data = Object.create(null);
        this._dirty = false;
    }

    setData(column, val) {
        if (typeof column === 'object') {
            for (let prop in column) {
                this.setData(prop, column[prop]);
            }

            return;
        }

        let prop = this._data[column];
        if (prop && prop.val === val) {
            return;
        }

        prop = prop || { col: column, val: '', dirty: true };
        prop.val = val;
        prop.dirty = true;
        this._data[column] = prop;
        this._dirty = true;
    }

    getData(column) {
        let prop = this._data[column];
        return prop ?
            prop.val :
            undefined;
    }

    loadData(obj) {
        this._data = Object.create(null);
        for (let prop in obj) {
            this._data[prop] = { col: prop, val: obj[prop], dirty: false };
        }
        this._dirty = false;
    }

    async save() {
        if (!this._dirty) {
            return;
        }

        let cols = Object.create(null);
        for (let prop in this._data) {
            let col = this._data[prop];
            if (col.dirty) {
                cols[prop] = this._data[prop].val;
            }
        }

        if (!this.getData('id')) {
            let id = await this._db.dbUsers(this._table).insert(cols).returning('id');
            // knexjs returns the inserted ID within an array
            id = id[0];
            if (id) {
                this._data.id = { col: 'id', val: id, dirty: false };
            }
            this._dirty = false;
        } else {
            let id = this.getData('id');
            let updateCols = { ...cols };
            delete updateCols.id;
            if (Object.keys(updateCols).length > 0) {
                await this._db.dbUsers(this._table).where('id', id).update(updateCols);
            }
            this._dirty = false;
        }
    }

    static createFactory(Ctor, ...ctorArgs) {
        // The first argument to a model will always be the Database instance
        let db = ctorArgs[0];
        let table = Ctor.table;

        let factory = function(...args) {
            return new Ctor(...ctorArgs.concat(args));
        };

        factory.query = function query() {
            let query = db.dbUsers(table);
            // Wrap the queries .then() with our own so that we can return a model
            let originalThen = query.then;
            query.then = (...args) => {
                return originalThen.call(query, factory.fromDbResult).then(...args);
            };
            return query;
        };

        factory.fromDbResult = function fromDbResult(rs) {
            let ret = null;
            if (Array.isArray(rs)) {
                ret = rs.map(row => factory.fromDbResult(row));
            } else if(rs) {
                ret = factory();
                ret.loadData(rs);
            }

            return ret;
        };

        return factory;
    }

}

module.exports = DatabaseSavable;
