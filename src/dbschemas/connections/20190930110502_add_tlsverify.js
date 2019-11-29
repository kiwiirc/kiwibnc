exports.up = async function(knex) {
    await knex.schema.table('connections', async (table) => {
        table.boolean('tlsverify').defaultTo(1);
    });
    await knex.schema.table('user_networks', function (table) {
        table.boolean('tlsverify').defaultTo(1);
    });
};

exports.down = function(knex) {
    // Never go backwards in the db
};