module.exports = function(app) {
    let router = app.webserver.router;
    let userDb = app.userDb;

    // Used to check if the worker has actually been restarted from the client
    let started = Date.now();

    router.post('admin.info', '/api/admin/info', async (ctx, next) => {
        let body = ctx.request.body;
        if (body.allowregistrations) {
            app.conf.set('webchat.public_register', body.allowregistrations === 'true');
        }
        ctx.body = {};
    });

    router.get('admin.info', '/api/admin/info', async (ctx, next) => {
        let db = userDb.db.dbUsers;
        let r = db('user_networks')
            .where('user_id', db.ref('users.id'))
            .count('*', {as: 'cnt'})
            .groupBy('user_id')
            .as('num_networks');

        let users = await db('users')
            .select('id', 'username', 'created_at', 'admin', 'locked', r);

        ctx.body = {
            started,
            users,
            allowRegistrations: app.conf.get('webchat.public_register', false),
        };
    });

    router.post('admin.restart', '/api/admin/restart', async (ctx, next) => {
        setTimeout(() => {
            app.prepareShutdown();
        }, 100);

        ctx.body = {};
    });

    router.post('admin.users', '/api/admin/users', async (ctx, next) => {
        let body = ctx.request.body;

        let acts = ['lock', 'unlock', 'changepass'];
        if (!acts.includes(body.act)) {
            ctx.body = {error: 'unknown_act' };
            return;
        }

        let user = await userDb.getUser(body.username);
        if (!user) {
            ctx.body = {error: 'no_user' };
            return;
        }

        if (body.act === 'lock') {
            user.locked = true;
            await user.save();
        } else if (body.act === 'unlock') {
            user.locked = false;
            await user.save();
        } else if (body.act === 'changepass') {
            let newPass = body.password;
            if (!newPass) {
                ctx.body = {error: 'missing_params'};
                return;
            }

            user.password = newPass;
            await user.save();
        }

        ctx.body = { error: false };
    });
};
