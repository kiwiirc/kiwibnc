exports.up = function(knex) {
    return knex.schema.raw(`
        ALTER TABLE connections ADD COLUMN tlsverify boolean default 1
    `).raw(`
        ALTER TABLE user_networks ADD COLUMN tlsverify boolean default 1
    `);
};

exports.down = function(knex) {
    // sqlite doesn't support removing columns
};