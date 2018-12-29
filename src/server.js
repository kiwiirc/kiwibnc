const commander = require('commander');
const { spawn } = require('child_process');

(async function() {
    commander
        .version('0.0.1')
        .option('-c, --config <path>', 'Config file path', './config.ini')
        .option('--worker', 'Launch a worker')
        .option('--sockets', 'Launch a socket layer')
        .parse(process.argv);

    // Make the args available globally
    process.args = commander;

    if (commander.sockets) {
        await require('./sockets/sockets');
    } else if (commander.worker) {
        await require('./worker/worker');
    } else {
        // Start the socket layer first so that it's ready for the worker to connect to
        await require('./sockets/sockets');

        // The worker shoudl restart itself if it crashes
        let spawnWorker = () => {
            let nodeBin = process.argv[0];
            let nodeArgs = [...process.argv.slice(1), '--worker'];
            let proc = spawn(nodeBin, nodeArgs, {stdio: [process.stdin, process.stdout, process.stderr]});
            proc.on('exit', spawnWorker);
        };

        spawnWorker();
    }
})();
