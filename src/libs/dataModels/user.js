const bcrypt = require('bcrypt');
const DatabaseSavable = require('./databasesavable');

class User extends DatabaseSavable {
    constructor(db) {
        super(db);
    }

    static get table() { return 'users'; }
    static factory(...ctorArgs) {
        return DatabaseSavable.createFactory(User, ...ctorArgs)
    }

    get id() { return this.getData('id'); }

    get username() { return this.getData('username'); }
    set username(newVal) { return this.setData('username', newVal); }

    get password() { return this.getData('password'); }
    set password(newVal) {
        let hashed = bcrypt.hashSync(newVal, 8);
        return this.setData('password', hashed);
    }

    get created_at() { return this.getData('created_at'); }
    set created_at(newVal) { return this.setData('created_at', newVal); }

    get admin() { return this.getData('admin'); }
    set admin(newVal) { return this.setData('admin', newVal); }

    get bind_host() { return this.getData('bind_host'); }
    set bind_host(newVal) { return this.setData('bind_host', newVal); }

    checkPassword(password) {
        let hashed = this.password;
        return bcrypt.compareSync(password, hashed);
    }
}

module.exports = User;
