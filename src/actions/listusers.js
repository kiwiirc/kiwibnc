module.exports = async function(env, options) {
    let app = await require('../libs/bootstrap')('listusers');
    await app.initDatabase();

    let users = await app.db.db('users')
        .select('id', 'username', 'created_at', 'admin', 'locked');
    
    users.forEach(user => {
        let flags = [];
        if (user.admin) flags.push('admin');
        if (user.locked) flags.push('locked');
        let created = new Date(user.created_at * 1000);
        console.log(`${user.username} ${created.toISOString()} ${flags.join(',')}`);
    });

    process.exit(0);
};
