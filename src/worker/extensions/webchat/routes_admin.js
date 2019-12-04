module.exports = function(app) {
    let router = app.webserver.router;
    let userDb = app.userDb;

    // Used to check if the worker has actually been restarted from the client
    let started = Date.now();

    async function adminAuth(ctx, next) {
        if (!ctx.headers['x-auth']) {
            ctx.response.status = 403;
            return;
        }

        try {
            let token = app.crypt.decrypt(ctx.headers['x-auth']) || '';
            if (!token.match(/^userid=/)) {
                throw new Error('invalid token');
            }
        } catch (err) {
            ctx.response.status = 403;
            return;
        }

        await next();
    };

    router.post('admin.info', '/api/admin/info', adminAuth, async (ctx, next) => {
        let body = ctx.request.body;
        if (body.allowregistrations) {
            app.conf.set('webchat.public_register', body.allowregistrations === 'true');
        }
        ctx.body = {};
    });

    router.get('admin.info', '/api/admin/info', adminAuth, async (ctx, next) => {
        let db = userDb.db.dbUsers;
        let r = db('user_networks')
            .where('user_id', db.ref('users.id'))
            .count('*', {as: 'cnt'})
            .groupBy('user_id')
            .as('num_networks');

        let users = await db('users')
            .select('id', 'username', 'created_at', 'admin', 'locked', r)
            .orderBy(['admin', 'username']);

        ctx.body = {
            started,
            users,
            allowRegistrations: app.conf.get('webchat.public_register', false),
        };
    });

    router.post('admin.restart', '/api/admin/restart', adminAuth, async (ctx, next) => {
        setTimeout(() => {
            app.prepareShutdown();
        }, 100);

        ctx.body = {};
    });

    router.post('admin.users', '/api/admin/users', adminAuth, async (ctx, next) => {
        let body = ctx.request.body;

        let acts = ['lock', 'unlock', 'changepass', 'newuser'];
        if (!acts.includes(body.act)) {
            ctx.body = {error: 'unknown_act' };
            return;
        }

        if (body.act === 'lock') {
            let user = await userDb.getUser(body.username);
            if (!user) {
                ctx.body = {error: 'no_user' };
                return;
            }

            user.locked = true;
            await user.save();

        } else if (body.act === 'unlock') {
            let user = await userDb.getUser(body.username);
            if (!user) {
                ctx.body = {error: 'no_user' };
                return;
            }

            user.locked = false;
            await user.save();

        } else if (body.act === 'changepass') {
            let newPass = body.password;
            if (!newPass) {
                ctx.body = {error: 'missing_params'};
                return;
            }

            let user = await userDb.getUser(body.username);
            if (!user) {
                ctx.body = {error: 'no_user' };
                return;
            }

            user.password = newPass;
            await user.save();

        } else if (body.act === 'newuser') {
            let username = (body.username || '').trim();
            let password = (body.password || '').trim();
            let admin = (body.admin || '').trim();

            if (!username || !password) {
                ctx.body = {error: 'missing_params'};
                return;
            }

            let existingUser = await userDb.getUser(username);
            if (existingUser) {
                ctx.body = {error: 'user_exists' };
                return;
            }
    
            try {
                await userDb.addUser(username, password, admin === 'true');
            } catch (err) {
                l.error('[webui] Error adding new user:', err.message);
                ctx.body = {error: 'unknown_error' };
                return;
            }
        }

        ctx.body = { error: false };
    });
};
