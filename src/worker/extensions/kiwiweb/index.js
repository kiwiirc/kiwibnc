const https = require('https');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const unzipper = require('unzipper');
const routesAdmin = require('./routes_admin');
const routesClient = require('./routes_client');

module.exports.init = async function init(hooks, app) {
    if (!app.conf.get('webserver.enabled') || !app.conf.get('webserver.public_dir')) {
        return;
    }
    let publicPath = app.conf.relativePath(app.conf.get('webserver.public_dir'));

    await downloadKiwiIrc(publicPath, app.conf.get('webchat.download_url', ''));

    routesAdmin(app);
    routesClient(app);

    // Add an admin auth token to admin clients
    hooks.on('available_isupports', async event => {
        if (event.client.state.authAdmin) {
            let token = app.crypt.encrypt('userid='+event.client.state.authUserId);
            event.tokens.push('kiwibnc/admin=' + token);
        }
    });
};

async function downloadKiwiIrc(publicPath, downloadUrl) {
    let downloadPath = path.join(os.tmpdir(), 'kiwiirc_download');

    try {
        let dir = await fs.readdir(publicPath);
        if (dir.length > 0) {
            l.info('The public web folder is not empty, not downloading the KiwiIRC client.', publicPath);
            return;
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            reportError(err);
            return;
        }
    }

    if (!downloadUrl) {
        l.error('Missing download URL for the webchat client', publicPath);
        return;
    }

    https.get(downloadUrl, async (response) => {
        if (response.statusCode !== 200) {
            reportError(new Error('Invalid response from the download server, ' + response.statusCode));
            return;
        }

        response
            .pipe(unzipper.Extract({path: downloadPath}))
            .on('error', reportError)
            .on('close', async () => {
                l.info('Downloaded. Copying to web folder...', publicPath);
                try {
                    await fs.copy(path.join(downloadPath, 'dist/'), publicPath);
                } catch (err) {
                    reportError(err);
                    return;
                }

                l.info('Kiwi IRC downloaded!');
            });
    })
    .on('error', reportError);

    function reportError(err) {
        l.error('Error downloading Kiwi IRC: ' + err.message);
    }
}
