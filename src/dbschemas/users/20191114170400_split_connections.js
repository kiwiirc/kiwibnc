exports.up = async function(knex) {
    await knex.schema.dropTable('connections');
};

exports.down = function(knex) {
    // Never go backwards in the db
};
