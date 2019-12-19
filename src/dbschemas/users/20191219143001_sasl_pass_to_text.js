exports.up = async function(knex) {
    await knex.schema.table('user_networks', table => {
        
        // sqlite3 does not support ALTER TABLE
        if(knex.client.config.client !== 'sqlite3') {
            table.text('sasl_pass').alter();
        }
    });
};

exports.down = function(knex) {
    // Never go backwards in the db
};