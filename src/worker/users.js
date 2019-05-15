const uuidv4 = require('uuid/v4');
const bcrypt = require('bcrypt');
const Helpers = require('../libs/helpers');

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
            let row = await this.db.get(`
                SELECT
                    nets.*,
                    users.password as _pass,
                    users.admin as user_admin
                FROM user_networks nets
                INNER JOIN users ON users.id = nets.user_id
                WHERE users.username LIKE ? AND nets.name = ?
            `, [username, network]);
            
            if (row) {
                let correctHash = await bcrypt.compare(password, row._pass);
                if (correctHash) {
                    ret.user = { admin: row.user_admin };
                    delete row._pass;
                    delete row.user_admin;

                    ret.network = this.db.factories.Network.fromDbResult(row);
                }
            }
        } catch (err) {
            l.error('Error logging user in:', err.stack);
        }

        return ret;
    }

    async authUser(username, password) {
        if (!Helpers.validUsername(username)) {
            return null;
        }

        let user = await this.db.get(`SELECT * from users WHERE username LIKE ?`, [username])
            .then(this.db.factories.User.fromDbResult);

        if (user && await user.checkPassword(password)) {
            return user;
        }

        return null;
    }

    async authUserToken(token) {
        let sql = `
            SELECT
                users.*
            FROM users
            INNER JOIN user_tokens ON users.id = user_tokens.user_id
            WHERE user_tokens.token = ?
        `;
        let user = await this.db.get(sql, [token])
            .then(this.db.factories.User.fromDbResult);

        if (user) {
            return user;
        }

        return null;
    }

    async generateUserToken(id) {
        let token = uuidv4().replace(/\-/g, '');
        await this.db.db('user_tokens').insert({
            user_id: id,
            token: token,
            created_at: Date.now(),
        });
        return token;
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
        user.created_at = Date.now();
        if (isAdmin === true) {
            user.admin = true;
        }
        await user.save();

        return user;
    };

    async changeUserPassword(id, password) {
        let user = await this.db.factories.User.query().where('id', id);
        if (!user) {
            return;
        }

        user.password = password;
        return user.save();
    };

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
            .where('name', netName)
            .first();
    }
}

module.exports = Users;