const bcrypt = require('bcrypt');

class Users {
    constructor(db) {
        this.db = db;
    }

    async authUserNetwork(username, password, network) {
        let row = null;
        try {
            row = await this.db.get(`
                SELECT nets.*, users.password as _pass FROM user_networks nets
                INNER JOIN users ON users.id = nets.user_id
                WHERE users.username = ? AND nets.name = ?
            `, [username, network]);
            
            if (row) {
                let correctHash = await bcrypt.compare(password, row._pass);
                if (!correctHash) {
                    row = null;
                }

                // We don't need the password hash going anywhere else, get rid of it
                delete row._pass;
            }
        } catch (err) {
            l('Error logging user in:', err.message);
        }

        return row;
    }

    async authUser(username, password) {
        let row = await this.db.get(`SELECT * from users WHERE username = ?`, [username]);
        if (row) {
            let correctHash = await bcrypt.compare(password, row.password);
            if (!correctHash) {
                row = null;
            } else {
                // We don't need the password hash going anywhere else, get rid of it
                delete row.password;
            }
        }
        return row;
    }

    async changeUserPassword(id, password) {
        await this.db.run('UPDATE users SET password = ? WHERE id = ?', [
            await bcrypt.hash(password, 8),
            id,
        ]);
    };

    async getUserNetworks(userId) {
        let rows = await this.db.all('SELECT * FROM user_networks WHERE user_id = ?', [userId]);
        return rows;
    }

    async getNetwork(id) {
        let row = await this.db.get(`SELECT * from user_networks WHERE id = ?`, [id]);
        return row;
    }

    async getNetworkByName(userId, netName) {
        let row = await this.db.get(`SELECT * from user_networks WHERE user_id = ? AND name = ?`, [
            userId,
            netName,
        ]);
        return row;
    }
}

module.exports = Users;