exports.up = function(knex) {
    return knex.schema.raw(`
        ALTER TABLE connections ADD COLUMN auth_network_name TEXT
    `);
};

exports.down = function(knex) {
    // sqlite doesn't support removing columns
};