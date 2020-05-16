const readline = require('readline');
const path = require('path');
const { fork } = require('child_process');
const nodeCleanup = require('node-cleanup');

module.exports = async function(env, options) {
    // Start the socket layer first so that it's ready for the worker to connect to
    let socketsApp = await require('../sockets/sockets');

    // The worker should restart itself if it crashes
    let workerProc;
    let spawnWorker = () => {
        let nodeArgs = [...process.argv.slice(2), 'worker'];
        if (nodeArgs.indexOf('run') > -1) {
            // Remove any 'run' commands as we only want a worker process
            nodeArgs.splice(nodeArgs.indexOf('run'), 1);
        }

        workerProc = fork(path.resolve(__dirname, '../server.js'), nodeArgs, {
            stdio: [process.stdin, process.stdout, process.stderr, 'ipc'],
            //stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            env: process.env,
            execArgv: [...process.execArgv],
        });
        socketsApp.queue.emit('_workerProcess', {workerProc});
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
                workerProc.kill('SIGQUIT');
            }
        });
    }

    process.on('SIGHUP', () => {
        l('SIGHUP received. Reloading worker process...');
        workerProc.kill('SIGQUIT');
    });

    spawnWorker();

    // Make sure the worker process also gets killed when we die
    nodeCleanup((exitCode, signal) => {
        if (workerProc) {
            workerProc.kill();
        }
    });
};
