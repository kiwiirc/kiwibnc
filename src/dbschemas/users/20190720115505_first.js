exports.up = async function(knex) {
    await knex.schema.createTable('connections', async (table) => {
        table.text('conid').primary();
        table.integer('last_statesave');
        table.text('bind_host');
        table.text('host');
        table.integer('port');
        table.boolean('tls');
        table.integer('type');
        table.boolean('connected');
        table.text('sasl');
        table.text('server_prefix');
        table.text('registration_lines');
        table.text('isupports');
        table.text('caps');
        table.text('buffers');
        table.text('nick');
        table.text('account');
        table.boolean('received_motd');
        table.boolean('net_registered');
        table.integer('auth_user_id');
        table.integer('auth_network_id');
        table.boolean('auth_admin');
        table.text('linked_con_ids');
        table.boolean('logging');
        table.text('temp');
    });

    await knex.schema.createTable('users', function (table) {
        table.increments('id');
        table.text('username').unique();
        table.text('password');
        table.integer('created_at');
        table.boolean('admin');
        table.text('bind_host');
    });


    await knex.schema.createTable('user_networks', function (table) {
        table.increments('id');
        table.text('name');
        table.integer('user_id');
        table.text('host');
        table.integer('port');
        table.boolean('tls');
        table.text('nick');
        table.text('username');
        table.text('realname');
        table.text('password');
        table.text('sasl_account');
        table.text('sasl_pass');
        table.text('bind_host');

        table.unique(['name', 'user_id']);
    });

    await knex.schema.createTable('user_tokens', function (table) {
        table.text('token').primary();
        table.integer('user_id');
        table.integer('created_at');
    });
};

exports.down = function(knex) {
    // Never go backwards in the db
};
