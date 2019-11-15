exports.up = async function(knex) {
    await knex.schema.table('connections', async (table) => {
        table.string('auth_network_name', 100);
    });
};

exports.down = function(knex) {
    // Never go backwards in the db
};