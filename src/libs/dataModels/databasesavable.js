class DatabaseSavable {
    constructor(db, table) {
        this._db = db;
        this._table = table;
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
            let id = await this._db.db(this._table).insert(cols);
            if (id) {
                this.setData('id', id);
            }
            this._dirty = false;
        } else {
            let id = this.getData('id');
            let updateCols = { ...cols };
            delete updateCols.id;
            await this._db.db(this._table).where('id', id).update(updateCols);
            this._dirty = false;
        }
    }

    static createFactory(Ctor, ...ctorArgs) {
        let factory = function(...args) {
            return new Ctor(...ctorArgs.concat(args));
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
        }

        return factory;
    }

}

module.exports = DatabaseSavable;
