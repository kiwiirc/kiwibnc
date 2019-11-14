exports.up = async function(knex) {
    await knex.schema.table('connections', async (table) => {
        table.text('auth_network_name');
    });
};

exports.down = function(knex) {
    // Never go backwards in the db
};