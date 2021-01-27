const bcrypt = require('bcrypt');
const Helpers = require('../libs/helpers');
const { BncError } = require('../libs/errors');
const tokens = require('../libs/tokens');

class Users {
    constructor(db) {
        this.db = db;
    }

    async authUserNetwork(username, password, network) {
        let ret = { network: null, user: null };

        if (!Helpers.validUsername(username)) {
            return ret;
        }

        try {
            let isUserToken = false;
            let query = this.db.dbUsers('user_networks')
                .innerJoin('users', 'users.id', 'user_networks.user_id')
                .where('users.username', 'LIKE', username)
                .where('user_networks.name', 'LIKE', network)
                .select('user_networks.*', 'users.password as _pass', 'users.admin as user_admin');

            if (tokens.isUserToken(password)) {
                isUserToken = true;
                query.innerJoin('user_tokens', 'user_tokens.user_id', 'user_networks.user_id');
                query.where('user_tokens.token', password);
                query.where((q) => {
                    q.where('user_tokens.expires_at', 0)
                    q.orWhere('user_tokens.expires_at', '>', Helpers.now())
                });
            }

            let row = await query.first();
            if (!row) {
                return ret;
            }

            if (!isUserToken) {
                let correctHash = await bcrypt.compare(password, row._pass);
                if (!correctHash) {
                    return ret;
                }
            }

            ret.user = { admin: row.user_admin };
            delete row._pass;
            delete row.user_admin;

            ret.network = this.db.factories.Network.fromDbResult(row);
        } catch (err) {
            l.error('Error logging user in:', err.stack);
        }

        return ret;
    }

    async authUser(username, password, userHost) {
        if (!Helpers.validUsername(username)) {
            return null;
        }

        let isUserToken = false;
        let query = this.db.dbUsers('users')
            .select('users.*')
            .where('username', 'LIKE', username)
            .where('locked', '!=', true);

        if (tokens.isUserToken(password)) {
            isUserToken = true;
            query.innerJoin('user_tokens', 'user_tokens.user_id', 'users.id');
            query.where('user_tokens.token', password);
            query.where((q) => {
                q.where('user_tokens.expires_at', 0)
                q.orWhere('user_tokens.expires_at', '>', Helpers.now())
            });
        }

        let user = await query.first()
            .then(this.db.factories.User.fromDbResult);

        if (!user) {
            return null;
        }

        if (!isUserToken && !await user.checkPassword(password)) {
            return null;
        }

        if (isUserToken && userHost) {
            this.updateUserTokenAccess(user.id, password, userHost);
        }

        return user;
    }

    async authUserToken(token, userHost) {
        let user = this.db.dbUsers('users')
            .innerJoin('user_tokens', 'users.id', 'user_tokens.user_id')
            .where('user_tokens.token', token)
            .where((q) => {
                q.where('user_tokens.expires_at', 0)
                q.orWhere('user_tokens.expires_at', '>', Helpers.now())
            })
            .first()
            .then(this.db.factories.User.fromDbResult);

        if (user) {
            if (userHost) {
                this.updateUserTokenAccess(user.id, token, userHost);
            }
            return user;
        }

        return null;
    }

    async generateUserToken(userId, duration, comment, userHost) {
        const token = tokens.generateUserToken();
        const now = Helpers.now();
        const expires = duration ? now + duration : 0;
        await this.db.dbUsers('user_tokens').insert({
            user_id: userId,
            token: token,
            created_at: now,
            expires_at: expires,
            accessed_at: now,
            last_ip: userHost,
            comment: comment || '',
        });
        return token;
    }

    async updateUserToken(userId, token, duration, comment) {
        const expires = duration ? Helpers.now() + duration : 0;
        const updateObj = Object.create(null);

        if (duration !== null) {
            updateObj.expires_at = expires;
        }
        if (comment) {
            updateObj.comment = comment;
        }
        if (!Object.keys(updateObj).length) {
            return 0;
        }

        return await this.db.dbUsers('user_tokens')
        .update(updateObj)
        .where('user_id', userId)
        .where('token', token);
    }

    async updateUserTokenAccess(userId, token, userHost) {
        await this.db.dbUsers('user_tokens').update({
            accessed_at: Helpers.now(),
            last_ip: userHost,
        }).where('user_id', userId).where('token', token);
    }

    async getUserTokens(userId) {
        return this.db.dbUsers('user_tokens').where('user_id', userId);
    }

    async removeUserToken(userId, token) {
        await this.db.dbUsers('user_tokens')
            .where('user_id', userId)
            .where('token', token)
            .delete();
    }

    async getUser(username) {
        if (!Helpers.validUsername(username)) {
            return null;
        }

        return this.db.factories.User.query().where('username', 'LIKE', username).first();
    }

    async addUser(username, password, isAdmin) {
        if (!Helpers.validUsername(username)) {
            throw new Error('Invalid username');
        }

        let user = this.db.factories.User();
        user.username = username;
        user.password = password;
        user.created_at = Helpers.now();
        if (isAdmin === true) {
            user.admin = true;
        }
        await user.save();

        return user;
    };

    async deleteUser(user_id) {
        await this.db.factories.User.query().where('id', user_id).delete();
        await this.db.factories.Network.query().where('user_id', user_id).delete();
        await this.db.db('user_tokens').where('user_id', user_id).delete();
    }

    async changeUserPassword(id, password) {
        let user = await this.db.factories.User.query().where('id', id);
        if (!user) {
            return;
        }

        user.password = password;
        return user.save();
    };

    async getUserNetwork(userId, networkId) {
        return this.db.factories.Network.query()
            .where('user_id', userId)
            .where('id', networkId)
            .first();
    }

    async getUserNetworks(userId) {
        return this.db.factories.Network.query()
            .where('user_id', userId);
    }

    async getNetwork(id) {
        return this.db.factories.Network.query()
            .where('id', id)
            .first();
    }

    async getNetworkByName(userId, netName) {
        return this.db.factories.Network.query()
            .where('user_id', userId)
            .where('name', 'LIKE', netName)
            .first();
    }

    async addNetwork(userId, netInf) {
        let maxNetworks = config.get('users.max_networks', -1);
        // userId -1 is used for temp connections
        if (userId > 0 && maxNetworks > -1) {
            let nets = await this.db.factories.Network.query()
                .where('user_id', userId);

            if (nets.length >= maxNetworks) {
                throw new BncError('UserError', 'max_networks', 'Max number of networks reached for user');
            }
        }

        if (!(netInf.name || '').trim()) {
            throw new BncError('UserError', 'missing_name', 'A network must have a name');
        }

        let network = await this.db.factories.Network();
        network.user_id = userId;
        network.name = netInf.name;
        network.bind_host = netInf.bind_host || '';
        network.host = netInf.host || '';
        network.port = netInf.port || 6667;
        network.tls = !!netInf.tls;
        network.tlsverify = !!netInf.tlsverify;
        network.nick = netInf.nick || '';
        network.username = netInf.username || '';
        network.realname = netInf.realname || '';
        network.password = netInf.password || '';
        network.sasl_account = netInf.sasl_account || '';
        network.sasl_pass = netInf.sasl_pass || '';
        network.channels = netInf.channels || '';

        await network.save();
        return network;
    }
}

module.exports = Users;
