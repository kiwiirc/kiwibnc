const Database = require('../libs/database');

module.exports = async function(env, options) {
    let app = await require('../libs/bootstrap')('updatedb');

    app.db = new Database(app.conf.get('database.path', './connections.db'));
    await app.db.init();
    process.exit(0);
}
