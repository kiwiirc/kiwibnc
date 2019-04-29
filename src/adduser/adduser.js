const Database = require('../libs/database');
const Users = require('../worker/users');
var readlineSync = require('readline-sync');

async function run() {
    let app = await require('../libs/bootstrap')('adduser');

    app.db = new Database(app.conf.get('database.path', './connections.db'));
    await app.db.init();

    app.userDb = new Users(app.db);

    // username
    var username = '';
    while (true) {
        username = String(readlineSync.question('Username: ')).trim();

        if (0 < username.length) {
            // username is ok, break
            break;
        }
    }

    // password
    var password = '';
    while (true) {
        password = String(readlineSync.question('Password: ', {hideEchoBack: true})).trim();

        if (0 < password.length) {
            // password is ok, break
            break;
        }
    }

    // whether new user is an admin
    var userIsAdmin = false;
    var answer = readlineSync.question('Admin account? ', {limit: ['true', 't', 'yes', 'y', '1', 'false', 'f', 'no', 'n', '0']}).toLowerCase()
    if (answer == 'true' || answer == 't' || answer == 'yes' || answer == 'y' || answer == '1') {
        userIsAdmin = true;
    }

    let existingUser = await app.userDb.getUser(username);
    if (existingUser) {
        console.log(`User ${username} already exists`);
        process.exit(1);
    }

    try {
        await app.userDb.addUser(username, password);
        console.log(`Added new user ${username}`);
        process.exit(0);
    } catch (err) {
        l.error('Error adding new user:', err.message);
        console.log('There was an error adding the new user');
        process.exit(1);
    }

    process.exit(0);
}

module.exports = run();
