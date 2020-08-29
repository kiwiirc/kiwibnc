exports.up = async function(knex) {
    await knex.schema.table('user_tokens', table => {
        table.integer('expires_at');
        table.integer('accessed_at');
        table.text('last_ip');
        table.text('comment');
    });
};

exports.down = function(knex) {
    // Never go backwards in the db
};