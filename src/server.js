const readline = require('readline');
const commander = require('commander');
const { spawn } = require('child_process');
const nodeCleanup = require('node-cleanup');

(async function() {
    // Make the args available globally
    process.args = commander;

    commander
        .version('0.0.1')
        .option('-c, --config <path>', 'Config file path', './config.ini');

    commander
        .command('adduser')
        .description('Add a user')
        .action(function(env, options) {
            console.log('adding a new user');
        });

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

    commander
        .command('run')
        .description('Launch everything')
        .action(async function(env, options) {
            // Start the socket layer first so that it's ready for the worker to connect to
            await require('./sockets/sockets');
    
            // The worker should restart itself if it crashes
            let workerProc;
            let spawnWorker = () => {
                let nodeBin = process.argv[0];
                let nodeArgs = [...process.argv.slice(1), 'worker'];
                nodeArgs.splice(nodeArgs.indexOf('run'), 1);
                console.log('starting:', nodeBin, nodeArgs);
                workerProc = spawn(nodeBin, nodeArgs, {stdio: [process.stdin, process.stdout, process.stderr]});
                workerProc.on('exit', spawnWorker);
            };
    
            readline.emitKeypressEvents(process.stdin);
            process.stdin.setRawMode(true);
            process.stdin.on('keypress', (str, key) => {
                if (key.ctrl && key.name === 'c') {
                    process.exit();
                    return;
                }
    
                if (key.name === 'r' && workerProc) {
                    l('Reloading worker process...');
                    workerProc.kill();
                }
            });
    
            spawnWorker();
    
            // Make sure the worker process also gets killed when we die
            nodeCleanup((exitCode, signal) => {
                if (workerProc) {
                    workerProc.kill();
                }
            });
        });

    // return help on unknown subcommands
    commander
        .on('command:*', function () {
            console.error('Invalid command: %s\nSee --help for a list of available commands.', commander.args.join(' '));
            process.exit(1);
        });

    // run everything by default
    if (process.argv.length === 2) {
        process.argv.push('run');
    }

    commander.parse(process.argv);
})();
