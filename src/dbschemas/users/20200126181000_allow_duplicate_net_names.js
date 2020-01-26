exports.up = async function(knex) {
    await knex.schema.table('user_networks', table => {
        table.dropUnique('name_user_id');
    });
};

exports.down = function(knex) {
    // Never go backwards in the db
};