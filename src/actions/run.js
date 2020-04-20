const readline = require('readline');
const path = require('path');
const { fork } = require('child_process');
const fs = require('fs-extra');
const nodeCleanup = require('node-cleanup');

module.exports = async function(env, options) {
    await prepareConfig();

    // Start the socket layer first so that it's ready for the worker to connect to
    let socketsApp = await require('../sockets/sockets');

    // The worker should restart itself if it crashes
    let workerProc;
    let spawnWorker = () => {
        let nodeArgs = [...process.argv.slice(2), 'worker'];
        nodeArgs.splice(nodeArgs.indexOf('run'), 1);

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

async function prepareConfig() {
    let configOption = process.args.options.find(o => o.long === '--config');
    let isDefaultConfig = (configOption && process.args.config === configOption.defaultValue);
    let configExists = await fs.pathExists(process.args.config);

    if (configExists) {
        return;
    }

    if (!isDefaultConfig && !configExists) {
        console.error('Config file does not exist,', process.args.config);
        process.exit(1);
    }

    if (isDefaultConfig) {
        let configPath = path.dirname(process.args.config);
        console.log('Creating new config profile at ' + configPath);
        try {
            await fs.copy(path.join(__dirname, '../configProfileTemplate'), configPath);
        } catch (err) {
            console.error('Failed to create new config profile.', err.message);
            process.exit(1);
        }
    }
}
