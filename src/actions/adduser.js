var readlineSync = require('readline-sync');

module.exports = async function(env, options) {
    let app = await require('../libs/bootstrap')('adduser');
    await app.initDatabase();

    // username
    let username = await syncQuestion('Username: ', {}, input => {
        return input.trim().length > 0;
    });

    // password
    let password = await syncQuestion('Password: ', {hideEchoBack: true}, input => {
        return input.trim().length > 0;
    });

    // whether new user is an admin
    let userIsAdmin = false;
    let adminRepliesYes = ['true', 't', 'yes', 'y', '1'];
    let adminRepliesNo = ['false', 'f', 'no', 'n', '0'];
    let answer = readlineSync.question('Admin account? ', {
        limit: adminRepliesYes.concat(adminRepliesNo)
    });
    userIsAdmin = adminRepliesYes.indexOf(answer.toLowerCase()) > -1;

    let existingUser = await app.userDb.getUser(username);
    if (existingUser) {
        console.log(`User ${username} already exists`);
        process.exit(1);
    }

    try {
        await app.userDb.addUser(username, password, userIsAdmin);
        console.log(`Added new user ${username}`);
    } catch (err) {
        l.error('Error adding new user:', err.message);
        console.log('There was an error adding the new user');
        process.exit(1);
    }

    process.exit(0);
};

async function syncQuestion(question, opts, validator) {
    let input = '';

    while (true) {
        input = readlineSync.question(question, opts);

        if (typeof validator === 'function') {
            if (validator(input)) {
                break;
            }
        }
    }

    return input;
}
