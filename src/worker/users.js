class Users {
    constructor(db) {
        this.db = db;
    }

    async authUserNetwork(username, password, network) {
        // TODO: Hash this password!
        let row = null;
        try {
            row = await this.db.get(`
                SELECT nets.* from user_networks nets
                INNER JOIN users ON users.id = nets.user_id
                WHERE users.username = ? AND users.password = ? AND nets.name = ?
        `, [username, password, network]);
        } catch (err) {
            l('Error logging user in:', err.message);
        }

        return row;
    }

    async authUser(username, password) {
        // TODO: Hash this password!
        let row = await this.db.get(`
            SELECT * from users
            WHERE username = ? AND password = ?
        `, [username, password]);
        return row;
    }

    async getNetwork(id) {
        let row = await this.db.get(`SELECT * from user_networks WHERE id = ?`, [id]);
        return row;
    }
}

module.exports = Users;