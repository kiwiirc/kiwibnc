exports.up = async function(knex) {
    await knex.schema.table('connections', async (table) => {
        table.string('username', 100);
        table.string('realname', 200);
        table.string('password', 100);
    });
};

exports.down = function(knex) {
    // Never go backwards in the db
};