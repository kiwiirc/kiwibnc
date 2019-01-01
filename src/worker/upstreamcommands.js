let commands = Object.create(null);

module.exports.run = async function run(msg, con) {
    let command = msg.command.toUpperCase();
    if (commands[command]) {
        return await commands[command](msg, con);
    }

    // By default, send any unprocessed lines to clients
    return true;
};

commands['001'] = async function(msg, con) {
    l(message);
    con.state.nick = msg.params[0];
    con.state.netRegistered = true;
    con.state.save();
    return false;
};

// Keep track of our isupport tokens
commands['005'] = async function(msg, con) {
    // Take these new tokens and add them to our existing recorded tokens
    let tokens = msg.params.slice(1);
    tokens.pop();
    con.state.isupports = [...con.state.isupports, ...tokens];
};

commands.PING = async function(msg, con) {
    con.write('PONG :' + msg.params[0] + '\n');
};

commands.JOIN = async function(msg, con) {
    if (msg.prefix.nick !== con.state.nick) {
        return;
    }

    let chanName = msg.params[0];
    let chan = null;
    if (!con.state.channels[chanName]) {
        chan = con.state.channels[chanName] = new Channel(chanName);
    }

    chan.joined = true;
    con.state.save();
};
