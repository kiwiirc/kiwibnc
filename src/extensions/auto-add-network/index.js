let extConf = null;

module.exports.init = async function init(hooks, app) {
    extConf = app.conf.get('extension.auto-add-network', null);
    if (!extConf) {
        console.log('extension auto-add-network missing config object');
        return;
    }

    hooks.on('client_registered', async (event) => {
        const con = event.client;
        const user = await app.db.factories.User.query().where('id', con.state.authUserId).first();
        const networks = await con.userDb.getUserNetworks(con.state.authUserId);

        let addNeeded = true;
        networks.forEach((net) => {
            if (net.host === extConf.host) {
                addNeeded = false;
            }
        });

        if (addNeeded) {
            addNetwork(con, user);
        }
    });
}

async function addNetwork(con, user) {
    const network = con.db.factories.Network();
    network.user_id = user.id;
    network.name = extConf.name;
    network.host = extConf.host;
    network.port = extConf.port;
    network.tls = extConf.tls;
    network.nick = user.username;
    network.username = user.username;
    network.realname = user.username;
    network.channels = extConf.channels || '';
    await network.save();
}
