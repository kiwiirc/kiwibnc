const readline = require('readline');
const { spawn } = require('child_process');
const nodeCleanup = require('node-cleanup');

module.exports = async function(env, options) {
    // Start the socket layer first so that it's ready for the worker to connect to
    await require('../sockets/sockets');

    // The worker should restart itself if it crashes
    let workerProc;
    let spawnWorker = () => {
        let nodeBin = process.argv[0];
        let nodeArgs = [...process.argv.slice(1), 'worker'];
        nodeArgs.splice(nodeArgs.indexOf('run'), 1);
        workerProc = spawn(nodeBin, nodeArgs, {stdio: [process.stdin, process.stdout, process.stderr]});
        workerProc.on('exit', spawnWorker);
    };

    if (process.args.interactive) {
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
    }

    spawnWorker();

    // Make sure the worker process also gets killed when we die
    nodeCleanup((exitCode, signal) => {
        if (workerProc) {
            workerProc.kill();
        }
    });
};
