exports.up = async function(knex) {
    await knex.schema.table('users', function (table) {
        table.boolean('locked').defaultTo(0);
    });
};

exports.down = function(knex) {
    // Never go backwards in the db
};
