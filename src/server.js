#!/usr/bin/env node
const os = require('os');
const path = require('path');
const commander = require('commander');
const actionRun = require('./actions/run');
const actionAddUser = require('./actions/adduser');
const actionListUsers = require('./actions/listusers');
const actionUpdateDb = require('./actions/updatedb');

(async function() {
    // Make the args available globally
    process.args = commander;

    let defaultConfigPath = path.join(os.homedir(), '.kiwibnc', 'config.ini')

    commander
        .version('0.0.1')
        .option('-c, --config <path>', 'Config file path', defaultConfigPath)
        .option('-i, --interactive', 'Interactive mode. Enables "r" key to reload', false);

    commander
        .command('adduser')
        .description('Add a user')
        .action(actionAddUser);

    commander
        .command('listusers')
        .description('List all users')
        .action(actionListUsers);

    commander
        .command('updatedb')
        .description('Update the database schema to the latest')
        .action(actionUpdateDb);

    commander
        .command('run', { isDefault: true })
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

    commander.parse(process.argv);
})();
