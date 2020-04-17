exports.up = async function(knex) {
    await knex.schema.table('user_networks', table => {
        table.text('channels');
    });
};

exports.down = function(knex) {
    // Never go backwards in the db
};