#!/usr/bin/env node
const os = require('os');
const path = require('path');
const commander = require('commander');
const version = require('../package.json').version;
const actionRun = require('./actions/run');
const actionAddUser = require('./actions/adduser');
const actionListUsers = require('./actions/listusers');
const actionUpdateDb = require('./actions/updatedb');
const actionDeleteUser = require('./actions/deleteuser');

(async function() {
    // Make the args available globally
    process.args = commander;

    let defaultWorkingDir = path.join(os.homedir(), '.kiwibnc');
    let defaultConfigPath = path.join(defaultWorkingDir, 'config.ini')

    commander
        .version(version)
        .option('-c, --config <path>', 'Config file path', defaultConfigPath)
        .option('-w, --workingdir <path>', 'Working directory path', defaultWorkingDir)
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
        .command('deleteuser <username>')
        .description('Delete a user')
        .action(actionDeleteUser);

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
        .action(async function() {
            await require('./sockets/sockets');
        });

    commander
        .command('worker')
        .description('Launch a worker')
        .action(async function() {
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
