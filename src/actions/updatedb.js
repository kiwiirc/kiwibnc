module.exports = async function(env, options) {
    let app = await require('../libs/bootstrap')('updatedb');
    await app.initDatabase();
    process.exit(0);
}
