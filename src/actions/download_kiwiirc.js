const https = require('https');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const unzipper = require('unzipper');

module.exports = async function(env, options) {
    let app = await require('../libs/bootstrap')('download_kiwiirc');

    let downloadUrl = 'https://builds.kiwiirc.com/zips/kiwiirc_master.zip';
    let downloadPath = path.join(os.tmpdir(), 'kiwiirc_download');
    let publicPath = app.conf.relativePath(app.conf.get('webserver.public_dir', './public_http/'));

    try {
        let dir = await fs.readdir(publicPath);
        if (dir.length > 0) {
            console.log('The public web folder is not empty, aborting.', publicPath);
            return;
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            reportError(err);
            return;
        }
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
                console.log('Downloaded. Copying to web folder...', publicPath);
                try {
                    await fs.copy(path.join(downloadPath, 'dist/'), publicPath);
                } catch (err) {
                    reportError(err);
                    return;
                }

                console.log('Kiwi IRC downloaded!');
            });
    })
    .on('error', reportError);

    function reportError(err) {
        console.log('Error downloading Kiwi IRC: ' + err.message);
    }
}
