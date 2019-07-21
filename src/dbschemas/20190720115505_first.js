exports.up = function(knex) {
    return knex.schema.raw(`
        CREATE TABLE IF NOT EXISTS connections (
            conid TEXT PRIMARY KEY,
            last_statesave INTEGER,
            bind_host TEXT,
            host TEXT,
            port INTEGER,
            tls BOOLEAN,
            type INTEGER,
            connected BOOLEAN,
            sasl TEXT,
            server_prefix TEXT,
            registration_lines TEXT,
            isupports TEXT,
            caps TEXT,
            buffers TEXT,
            nick TEXT,
            account TEXT,
            received_motd BOOLEAN,
            net_registered BOOLEAN,
            auth_user_id INTEGER,
            auth_network_id INTEGER,
            auth_admin BOOLEAN,
            linked_con_ids TEXT,
            logging BOOL,
            temp TEXT
        )
    `)
    .raw(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT COLLATE NOCASE,
            password TEXT,
            created_at INTEGER,
            admin BOOLEAN,
            bind_host TEXT
        )
    `)
    .raw(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_uindex ON users (username)`)
    .raw(`
        CREATE TABLE IF NOT EXISTS user_networks (
            id INTEGER PRIMARY KEY,
            name TEXT COLLATE NOCASE,
            user_id INTEGER,
            host TEXT,
            port INTEGER,
            tls BOOLEAN,
            nick TEXT,
            username TEXT,
            realname TEXT,
            password TEXT,
            sasl_account TEXT,
            sasl_pass TEXT,
            bind_host TEXT
        )
    `)
    .raw(`CREATE UNIQUE INDEX IF NOT EXISTS user_networks_name_user_id_uindex ON user_networks (name, user_id)`)
    .raw(`
        CREATE TABLE IF NOT EXISTS user_tokens (
            token TEXT PRIMARY KEY,
            user_id INTEGER,
            created_at INTEGER
        )
    `)
    .raw(`CREATE UNIQUE INDEX IF NOT EXISTS user_tokens_token_uindex ON user_tokens (token)`)
};
  
exports.down = function(knex) {
    return knex.schema
        .dropTable("connections")
        .dropTable("user_networks")
        .dropTable("users")
        .dropTable("user_tokens");
};
