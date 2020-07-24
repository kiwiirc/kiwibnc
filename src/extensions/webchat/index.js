const https = require('https');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const webpush = require('web-push');
const unzipper = require('unzipper');
const routesAdmin = require('./routes_admin');
const routesClient = require('./routes_client');
const { mParam, mParamU } = require('../../libs/helpers');
const messageTags = require('irc-framework/src/messagetags');

module.exports.init = async function init(hooks, app) {
    if (!app.conf.get('webserver.enabled') || !app.conf.get('webserver.public_dir')) {
        return;
    }
    let publicPath = app.conf.relativePath(app.conf.get('webserver.public_dir'));

    await downloadKiwiIrc(publicPath, app.conf.get('webchat.download_url', ''));

    await initDB(app.db);

    const vapidPublicKey = app.conf.get('webchat.vapid_public_key');
    const vapidPrivateKey = app.conf.get('webchat.vapid_private_key');

    if (!vapidPublicKey || !vapidPrivateKey) {
        const vapidKeys = webpush.generateVAPIDKeys();
        console.log('VAPID keys, add them to your config.ini to enable push nofication support');
        console.log('vapid_public_key:', vapidKeys.publicKey);
        console.log('vapid_private_key:', vapidKeys.privateKey);
    }

    routesAdmin(app);
    routesClient(app);

    // Add an admin auth token to admin clients
    hooks.on('available_isupports', async (event) => {
        if (event.client.state.authAdmin) {
            let token = app.crypt.encrypt('userid='+event.client.state.authUserId);
            event.tokens.push('kiwibnc/admin=' + token);
        }
    });

    hooks.on('message_from_client', async (event) => {
        const client = event.client;
        const msg = event.message;

        if (
            msg.command.toUpperCase() === 'PRIVMSG' &&
            mParamU(msg, 0, '') === '*BNC'
        ) {
            return handleBncPrivMsgCommand(app.db, client, msg);
        }
    });

    hooks.on('message_notification', async (event) => {
        const userId = event.upstream.state.authUserId;
        const networkId = event.upstream.state.authNetworkId;

        let hasClient = false;
        let activeDataIds = [];

        app.cons.findAllUsersClients(userId).forEach((con) => {
            if (con.state.authNetworkId !== networkId) {
                return;
            }

            const dataId = con.state.tempGet('notification_data_id');
            if (dataId) {
                activeDataIds.push(dataId);
            }

            hasClient = true;
        });

        const allBrowsers = app.conf.get('webchat.notification_all_browsers', false);
        if (!allBrowsers && hasClient) {
            // This notifcation has a connected client so ignore it
            return;
        }

        const pushReceivers = await app.db.dbUsers('browsers')
            .select('endpoint', 'ep_data', 'data_id')
            .where('user_id', userId);

        const options = {
            vapidDetails: {
                subject: app.conf.get('webchat.vapid_subject', 'mailto:user@example.com'),
                publicKey: vapidPublicKey,
                privateKey: vapidPrivateKey,
            },
            TTL: app.conf.get('webchat.push_ttl', 3600),
        };

        pushReceivers.forEach(async (receiver) => {
            if (activeDataIds.includes(receiver.data_id)) {
                // This browser is currently connected so ignore it
                return;
            }
            const pushSubscription = { endpoint: receiver.endpoint, ...JSON.parse(receiver.ep_data) };

            const titleDefault = 'You where mentioned in %NetworkName% %BufferName%';
            const title = app.conf.get('webchat.notification_title', titleDefault)
                .replace('%NetworkName%', event.upstream.state.authNetworkName)
                .replace('%BufferName%', event.buffer.name);

            const payload = JSON.stringify({
                notification: {
                    title: title,
                    body: event.message.params.slice(-1)[0],
                    icon: app.conf.get('webchat.notification_icon', '/static/favicon.png'),
                    ttl: app.conf.get('webchat.notification_ttl', 10000),
                },
            });

            try {
                await webpush.sendNotification(
                    pushSubscription,
                    payload,
                    options
                );
            } catch (e) {
                if (e.statusCode === 410) {
                    // Push subscription has expired
                    await app.db.dbUsers('browsers')
                        .where('user_id', userId)
                        .where('data_id', receiver.data_id)
                        .delete();
                }
            }
        });
    });
};

async function initDB(db) {
    await db.run(`
        CREATE TABLE IF NOT EXISTS browsers (
            user_id INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            data_id TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            ep_data TEXT,
            CONSTRAINT browsers_PK PRIMARY KEY (user_id, endpoint),
            CONSTRAINT browsers_UN UNIQUE (user_id, data_id)
        );
    `);
}

async function handleBncPrivMsgCommand(db, client, msg) {
    const [subCommand, commandData] = mParam(msg, 1).split(' ');
    if (subCommand.toUpperCase() !== 'BROWSER') {
        return;
    }
    const cmdData = messageTags.decode(commandData || '');

    if (cmdData.id && cmdData.endpoint) {
        const result = await db.dbUsers('browsers')
            .select('data_id', 'ep_data')
            .where('user_id', client.state.authUserId)
            .where('endpoint', cmdData.endpoint)
            .first();

        if (result) {
            // Entry exists update data_id and time
            await db.dbUsers('browsers').update({
                data_id: cmdData.id,
                updated_at: Date.now() / 1000,
            })
            .where('user_id', client.state.authUserId)
            .where('endpoint', cmdData.endpoint)
        } else {
            // New entry
            await db.dbUsers('browsers').insert({
                user_id: client.state.authUserId,
                created_at: Date.now() / 1000,
                updated_at: Date.now() / 1000,
                data_id: cmdData.id,
                endpoint: cmdData.endpoint,
            });
        }
    } else if (cmdData.id && cmdData.data) {
        const result = await db.dbUsers('browsers')
            .select('ep_data')
            .where('user_id', client.state.authUserId)
            .where('data_id', cmdData.id)
            .first();

        if (result && !result.ep_data) {
            // Entry exists without ep_data add the data
            await db.dbUsers('browsers').update({
                ep_data: cmdData.data,
                updated_at: Date.now() / 1000,
            })
            .where('user_id', client.state.authUserId)
            .where('data_id', cmdData.id);
        }
    } else if (cmdData.id) {
        // This is a client connection add data_id for connected networks tracking
        client.state.tempSet('notification_data_id', cmdData.id);
    }

    client.writeMsg('BROWSER', 'RPL_OK');
}

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

    l.info('Downloading webchat client from ' + downloadUrl);
    https.get(downloadUrl, async (response) => {
        if (response.statusCode !== 200) {
            reportError(new Error('Invalid response from the download server, ' + response.statusCode));
            return;
        }

        l.info('Webchat Downloaded. Copying to web folder...', publicPath);
        response
            .pipe(unzipper.Extract({path: downloadPath}))
            .on('error', reportError)
            .on('close', async () => {
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
