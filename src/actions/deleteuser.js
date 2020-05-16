module.exports = async function(username) {
    let app = await require('../libs/bootstrap')('deleteuser');
    await app.initDatabase();

    let user = await app.userDb.getUser(username);
    if (!user) {
        console.error('User does not exist');
    } else {
        await app.userDb.deleteUser(user.id);
        console.log('User deleted');
    }

    process.exit(0);
};
