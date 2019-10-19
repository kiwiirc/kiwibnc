#!/usr/bin/env node

const commander = require('commander');
const actionRun = require('./actions/run');
const actionAddUser = require('./actions/adduser');
const actionUpdateDb = require('./actions/updatedb');

(async function() {
    // Make the args available globally
    process.args = commander;

    commander
        .version('0.0.1')
        .option('-c, --config <path>', 'Config file path', './config.ini')
        .option('-i, --interactive', 'Interactive mode. Enables "r" key to reload', true);

    commander
        .command('adduser')
        .description('Add a user')
        .action(actionAddUser);

    commander
        .command('updatedb')
        .description('Update the database schema to the latest')
        .action(actionUpdateDb);

    commander
        .command('run')
        .description('Start the bouncer')
        .action(actionRun);

    commander
        .command('sockets')
        .description('Launch a socket layer')
        .action(async function(env, options) {
            await require('./sockets/sockets');
        });

    commander
        .command('worker')
        .description('Launch a worker')
        .action(async function(env, options) {
            await require('./worker/worker');
        });

    // return help on unknown subcommands
    commander
        .on('command:*', function (command) {
            console.error('Invalid command: %s\nSee --help for a list of available commands.', command[0]);
            process.exit(1);
        });

    // run everything by default
    if (process.argv.length === 2 && process.argv[1].match(/\.js/)) {
        // $ node src/server.js
        process.argv.push('run');
    } else if (process.argv.length === 1) {
        // $ kiwibnc
        process.argv.push('run');
    }

    commander.parse(process.argv);
})();
