const { mParam, mParamU } = require('../libs/helpers');
const hooks = require('./hooks');

let commands = Object.create(null);

module.exports.run = async function run(msg, con) {   
    let hook = await hooks.emit('message_from_upstream', {client: con, message: msg});
    if (hook.prevent) {
        return;
    }

    let command = msg.command.toUpperCase();
    if (commands[command]) {
        let ret = await commands[command](msg, con);
        return con.state.receivedMotd && ret;
    }

    // By default, send any unprocessed lines to clients if registered on the server
    return con.state.receivedMotd;
};

commands['CAP'] = async function(msg, con) {
    let wantedCaps = [
        'server-time',
        'multi-prefix',
        'away-notify',
        'account-notify',
        'account-tag',
        'extended-join',
        'userhost-in-names',
        'cap-notify',
        'sasl',
    ];

    // :irc.example.net CAP * LS :invite-notify ...
    if (mParamU(msg, 1, '') === 'LS') {
        let storedCaps = await con.state.tempGet('caps_receiving') || [];

        if (mParamU(msg, 2, '') === '*') {
            // More CAPs to follow so store it and come back later
            let offeredCaps = mParam(msg, 3, '').split(' ');
            offeredCaps = storedCaps.concat(offeredCaps);

            await con.state.tempSet('caps_receiving', offeredCaps);
            return false;
        }

        let offeredCaps = mParam(msg, 2, '').split(' ');
        offeredCaps = storedCaps.concat(offeredCaps);

        // Clear out any stored CAPS now that we have them all
        if (storedCaps.length > 0) {
            await con.state.tempSet('caps_receiving', null);
        }

        // Make a list of CAPs we want to REQ
        let requestingCaps = offeredCaps
            .filter((cap) => (
                wantedCaps.includes(cap.split('=')[0].toLowerCase())
            ))
            .map((cap) => cap.split('=')[0]);

        await hooks.emit('cap_to_upstream', {
            client: con,
            message: msg,
            requesting: requestingCaps,
            offered: offeredCaps,
        });

        if (requestingCaps.length === 0) {
            con.writeLine('CAP', 'END');
        } else {
            con.writeLine('CAP', 'REQ', requestingCaps.join(' '));
        }
    }

    // :irc.example.net CAP * NEW :invite-notify ...
    if (mParamU(msg, 1, '') === 'NEW') {
        let offeredCaps = mParam(msg, 2, '').split(' ');
        // we don't need to remove any caps we already have from here because
        //  if a cap's being offered to us via NEW we know we don't have it
        let requestingCaps = offeredCaps
            .filter((cap) => (
                wantedCaps.includes(cap.split('=')[0].toLowerCase())
            ))
            .map((cap) => cap.split('=')[0]);

        let hook = await hooks.emit('cap_new_upstream', {
            client: con,
            message: msg,
            requesting: requestingCaps,
            offered: offeredCaps,
        });

        if (hook.event.requesting.length > 0) {
            con.writeLine('CAP', 'REQ', hook.event.requesting.join(' '));
        }
    }

    // :irc.example.net CAP * DEL :invite-notify ...
    if (mParamU(msg, 1, '') === 'DEL') {
        let removedCaps = mParam(msg, 2, '').split(' ');

        let caps = con.state.caps || [];
        caps = caps.filter((cap) => !removedCaps.map((rcap) => rcap.toLowerCase())
            .includes(cap.split('=')[0].toLowerCase()));

        con.state.caps = caps;
        await con.state.save();

        let hook = await hooks.emit('cap_del_upstream', {
            client: con,
            message: msg,
            deleted: removedCaps,
            forwardToClient: [...removedCaps],
        });

        if (hook.event.forwardToClient.length > 0) {
            let forwardCaps = hook.event.forwardToClient.join(' ');
            con.forEachClient((clientCon) => {
                if (clientCon.state.netRegistered && clientCon.supportsCapNotify()) {
                    clientCon.writeMsgFrom(clientCon.upstream.state.serverPrefix, 'CAP', clientCon.upstream.state.nick, 'DEL', forwardCaps);
                }
            });
        }
    }

    // CAP * ACK :multi-prefix sasl
    if (mParamU(msg, 1, '') === 'ACK') {
        // 'capack_receiving' just caches CAP ACK responses that go across multiple lines
        let storedAcks = await con.state.tempGet('capack_receiving') || [];

        if (mParamU(msg, 2, '') === '*') {
            // More ACKs to follow so store it and come back later
            let acks = mParam(msg, 3, '').split(' ');
            acks = storedAcks.concat(acks);

            await con.state.tempSet('capack_receiving', acks);
            return false;
        }

        let acks = mParam(msg, 2, '').split(' ');
        acks = storedAcks.concat(acks);

        if (storedAcks.length > 0) {
            // Clear any stored acks now that we have them all
            await con.state.tempSet('capack_receiving', null);
        }

        // dedupe incoming caps
        let caps = con.state.caps || [];
        caps = caps.concat(acks.filter((cap) => caps.includes(cap)));
        con.state.caps = caps;
        await con.state.save();

        await hooks.emit('cap_ack_upstream', {client: this, caps: acks});

        //TODO: Handle case of sasl defined but no ack given for it.
        // probably an option to either continue on no/bad sasl auth or abort connection.
        if (acks.includes('sasl') && con.state.sasl.account) {
            con.writeLine('AUTHENTICATE PLAIN');
        } else if (!con.state.receivedMotd) {
            con.writeLine('CAP', 'END');
        }
    }

    return false;
};

commands['AUTHENTICATE'] = async function(msg, con) {
    if (mParamU(msg, 0, '') === '+') {
        let sasl = con.state.sasl;
        let authStr = `${sasl.account}\0${sasl.account}\0${sasl.password}`;
        let b = new Buffer(authStr, 'utf8');
        let b64 = b.toString('base64');

        while (b64.length >= 400) {
            con.writeLine('AUTHENTICATE ' + b64.slice(0, 399));
            b64 = b64.slice(399);
        }
        if (b64.length > 0) {
            con.writeLine('AUTHENTICATE ' + b64);
        } else {
            con.writeLine('AUTHENTICATE +');
        }
    }
    if (!con.state.netRegistered) {
        return false;
    }
};

// :jaguar.test 903 jilles :SASL authentication successful
commands['903'] = async function(msg, con) {
    if (!con.state.netRegistered) {
        con.writeLine('CAP END');
    }
};

// :server 904 <nick> :SASL authentication failed
commands['904'] = async function(msg, con) {
    if (!con.state.netRegistered) {
        con.close();
    }
};

commands['001'] = async function(msg, con) {
    con.state.nick = msg.params[0];
    con.state.serverPrefix = msg.prefix || '';
    con.state.netRegistered = true;
    con.state.registrationLines.push([msg.command, msg.params.slice(1)]);
    await con.state.save();

    return false;
};
commands['002'] = async function(msg, con) {
    con.state.registrationLines.push([msg.command, msg.params.slice(1)]);
    await con.state.save();
    return false;
};
commands['004'] = async function(msg, con) {
    con.state.registrationLines.push([msg.command, msg.params.slice(1)]);
    await con.state.save();
    return false;
};
commands['004'] = async function(msg, con) {
    con.state.registrationLines.push([msg.command, msg.params.slice(1)]);
    await con.state.save();
    return false;
};

// Keep track of our isupport tokens
commands['005'] = async function(msg, con) {
    // Take these new tokens and add them to our existing recorded tokens
    let tokens = msg.params.slice(1);
    tokens.pop();
    con.state.isupports = [...con.state.isupports, ...tokens];

    con.state.registrationLines.push([msg.command, msg.params.slice(1)]);
    await con.state.save();
    return false;
};

// RPL_MOTD
commands['372'] = async function(msg, con) {
    if (!con.state.receivedMotd) {
        con.state.registrationLines.push([msg.command, msg.params.slice(1)]);
        await con.state.save();
    }
};

// RPL_MOTDSTART
commands['375'] = commands['372'];

// RPL_ENDOFMOTD
commands['376'] = async function(msg, con) {
    // If this is the first time recieving the MOTD, consider us ready to start using the network
    if (!con.state.receivedMotd) {
        con.state.receivedMotd = true;
        con.state.registrationLines.push([msg.command, msg.params.slice(1)]);

        await con.state.save();

        con.forEachClient((clientCon) => {
            clientCon.registerClient();
        });
    
        for (let buffName in con.state.buffers) {
            let b = con.state.buffers[buffName];
            if (b.isChannel && b.joined) {
                b.joined = false;
                con.writeLine('JOIN', b.name);
            }
        }

        return false;
    }

    return true;
};

// ERR_NOMOTD
commands['422'] = commands['376'];

// keep track of login/logout to forward lines to new clients
commands['900'] = async function(msg, con) {
    let account = msg.params[2];

    con.state.account = account;
    await con.state.save();
    return true;
}

commands['901'] = async function(msg, con) {
    con.state.account = '';
    await con.state.save();
    return true;
}

commands.PING = async function(msg, con) {
    con.write('PONG :' + msg.params[0] + '\n');
    return false;
};

commands.JOIN = async function(msg, con) {
    if (msg.nick.toLowerCase() !== con.state.nick.toLowerCase()) {
        return;
    }

    let chanName = msg.params[0];
    let chan = con.state.getBuffer(chanName);
    if (!chan) {
        chan = con.state.addBuffer(chanName, con);
    }

    chan.joined = true;
    await con.state.save();
};

commands.PART = async function(msg, con) {
    if (msg.nick.toLowerCase() !== con.state.nick.toLowerCase()) {
        return;
    }

    let chanName = msg.params[0];
    let chan = con.state.getBuffer(chanName);
    if (!chan) {
        return;
    }

    chan.joined = false;
    await con.state.save();
};

commands.KICK = async function(msg, con) {
    if (msg.params[1].toLowerCase() !== con.state.nick.toLowerCase()) {
        return;
    }

    let chanName = msg.params[0];
    let chan = con.state.getBuffer(chanName);
    if (!chan) {
        return;
    }

    chan.joined = false;
    await con.state.save();
};

// RPL_TOPIC
commands['332'] = async function(msg, con) {
    let channel = con.state.getBuffer(msg.params[1]);
    if (!channel) {
        channel = con.state.addBuffer(msg.params[1], con);
    }

    channel.topic = msg.params[2];
    await con.state.save();
};

// nick in use
commands['433'] = async function(msg, con) {
    if (con.state.nick.length < 8) {
        con.state.nick = con.state.nick + '_';
    } else {
        // Switch the last character to an incrimenting digit
        let lastChar = con.state.nick[con.state.nick.length - 1];
        let digit = parseInt(lastChar, 10);
        if (isNaN(digit)) {
            digit = 0;
        }
        let nick = con.state.nick;
        let len = nick.length;
        con.state.nick = nick.substr(0, len - 1) + (digit + 1)
    }

    con.writeLine('NICK', con.state.nick);
};

commands.NICK = async function(msg, con) {
    if (msg.nick.toLowerCase() !== con.state.nick.toLowerCase()) {
        let buffer = con.state.getBuffer(msg.nick);
        if (!buffer) {
            return;
        }

        // Try to track nick changes so that they stay in the same buffer instance
        con.state.renameBuffer(buffer.name, msg.params[0]);
        con.state.save();
        return;
    }

    con.state.nick = msg.params[0];
    con.state.save();
};

commands.PRIVMSG = async function(msg, con) {
    if (con.state.logging) {
        await con.messages.storeMessage(con.state.authUserId, con.state.authNetworkId, msg, con.state);
    }

    // Make sure we have this buffer
    con.state.getOrAddBuffer(bufferNameIfPm(msg, con.state.nick, 0), con);
};

commands.NOTICE = async function(msg, con) {
    if (con.state.logging) {
        await con.messages.storeMessage(con.state.authUserId, con.state.authNetworkId, msg, con.state);
    }

    // Make sure we have this buffer
    con.state.getOrAddBuffer(bufferNameIfPm(msg, con.state.nick, 0), con);
};

function bufferNameIfPm(message, nick, messageNickIdx) {
    if (nick.toLowerCase() === message.params[messageNickIdx]) {
        // It's a PM
        return message.nick;
    } else {
        return message.params[messageNickIdx];
    }
}
