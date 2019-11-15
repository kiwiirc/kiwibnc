exports.up = async function(knex) {
    await knex.schema.createTable('connections', async (table) => {
        table.string('conid', 40).primary();
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
        table.string('username', 50).unique();
        table.string('password', 100);
        table.integer('created_at');
        table.boolean('admin');
        table.string('bind_host', 100);
    });


    await knex.schema.createTable('user_networks', function (table) {
        table.increments('id');
        table.string('name', 100);
        table.integer('user_id');
        table.string('host', 100);
        table.integer('port');
        table.boolean('tls');
        table.string('nick', 50);
        table.string('username', 50);
        table.string('realname', 100);
        table.string('password', 100);
        table.string('sasl_account', 50);
        table.string('sasl_pass', 100);
        table.string('bind_host', 100);

        table.unique(['name', 'user_id']);
    });

    await knex.schema.createTable('user_tokens', function (table) {
        table.string('token', 100).primary();
        table.integer('user_id');
        table.integer('created_at');
    });
};

exports.down = function(knex) {
    // Never go backwards in the db
};
