const commander = require('commander');
const { spawn } = require('child_process');
const nodeCleanup = require('node-cleanup');

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

        // The worker should restart itself if it crashes
        let workerProc;
        let spawnWorker = () => {
            let nodeBin = process.argv[0];
            let nodeArgs = [...process.argv.slice(1), '--worker'];
            workerProc = spawn(nodeBin, nodeArgs, {stdio: [process.stdin, process.stdout, process.stderr]});
            workerProc.on('exit', spawnWorker);
        };

        spawnWorker();

        // Make sure the worker process also gets killed when we die
        nodeCleanup((exitCode, signal) => {
            if (workerProc) {
                workerProc.kill();
            }
        });
    }
})();
