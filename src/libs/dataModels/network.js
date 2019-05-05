const DatabaseSavable = require('./databasesavable');

class Network extends DatabaseSavable {
    constructor(db, crypt) {
        super(db, 'user_networks');
        this.crypt = crypt;
    }

    static factory(...ctorArgs) {
        return DatabaseSavable.createFactory(Network, ...ctorArgs)
    }

    get id() { return this.getData('id'); }

    get name() { return this.getData('name'); }
    set name(newVal) { return this.setData('name', newVal); }
    
    get user_id() { return this.getData('user_id'); }
    set user_id(newVal) { return this.setData('user_id', newVal); }
    
    get host() { return this.getData('host'); }
    set host(newVal) { return this.setData('host', newVal); }
    
    get port() { return this.getData('port'); }
    set port(newVal) { return this.setData('port', newVal); }
    
    get tls() { return this.getData('tls'); }
    set tls(newVal) { return this.setData('tls', newVal); }
    
    get nick() { return this.getData('nick'); }
    set nick(newVal) { return this.setData('nick', newVal); }
    
    get username() { return this.getData('username'); }
    set username(newVal) { return this.setData('username', newVal); }
    
    get realname() { return this.getData('realname'); }
    set realname(newVal) { return this.setData('realname', newVal); }
    
    get password() { return this.getData('password'); }
    set password(newVal) { return this.setData('password', newVal); }
    
    get sasl_account() { return this.getData('sasl_account'); }
    set sasl_account(newVal) { return this.setData('sasl_account', newVal); }
    
    get sasl_pass() {
        let pass = this.getData('sasl_pass');
        if (pass) {
            pass = this.crypt.decrypt(pass);
        }
        return pass;
    }
    set sasl_pass(newVal) {
        return this.setData('sasl_pass', this.crypt.encrypt(newVal));
    }
    
}

module.exports = Network;
