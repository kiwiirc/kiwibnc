exports.up = function(knex) {
    return knex.schema.raw(`DROP TABLE connections`);
};

exports.down = function(knex) {
};
