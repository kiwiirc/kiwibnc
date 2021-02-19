const { mParam, mParamU, parseMask, modeTypes, parseMode, parsePrefixes, getModesStatus } = require('../libs/helpers');
const msgIdGenerator = require('../libs/msgIdGenerator');
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
    let wantedCaps = new Set([
        'server-time',
        'multi-prefix',
        'away-notify',
        'account-notify',
        'account-tag',
        'invite-notify',
        'extended-join',
        'userhost-in-names',
        'cap-notify',
        'sasl',
        'message-tags',
    ]);
    await hooks.emit('wanted_caps', {client: con, wantedCaps});

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
                wantedCaps.has(cap.split('=')[0].toLowerCase())
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
                wantedCaps.has(cap.split('=')[0].toLowerCase())
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

        let caps = con.state.caps || new Set();
        caps = new Set(Array.from(caps).filter((cap) => !removedCaps.map((rcap) => rcap.toLowerCase())
            .includes(cap.split('=')[0].toLowerCase())));

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

        con.state.caps = new Set(acks);
        await con.state.save();

        await hooks.emit('cap_ack_upstream', {client: this, caps: acks});

        //TODO: Handle case of sasl defined but no ack given for it.
        // probably an option to either continue on no/bad sasl auth or abort connection.
        if (acks.includes('sasl') && con.state.sasl.account && con.state.sasl.password) {
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
        let b = new Buffer.from(authStr, 'utf8');
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
        await con.state.tempSet('irc_error','Invalid network login');
        con.close();
    }
};

commands['001'] = async function(msg, con) {
    con.state.nick = msg.params[0];
    con.state.serverPrefix = msg.prefix || '';
    con.state.netRegistered = true;
    con.state.registrationLines.push([msg.command, msg.params.slice(1)]);
    await con.state.save();

    // Start throttling messages sent to the server so we don't get flooded off
    con.throttle(config.get('connections.write_throttle', 500));

    return false;
};
commands['002'] = async function(msg, con) {
    con.state.registrationLines.push([msg.command, msg.params.slice(1)]);
    await con.state.save();
    return false;
};
commands['003'] = async function(msg, con) {
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
            if (b.isChannel) {
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

// ERR_YOUREBANNEDCREEP
commands['465'] = async function(msg, con) {
    // Don't auto reconnect on AKILL
    con.state.tempSet('requested_close', true);
    return true;
};

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
    con.writeLine('PONG', msg.params[0]);
    return false;
};

commands.JOIN = async function(msg, con) {
    msgIdGenerator.add(msg);

    if (con.state.logging && con.state.netRegistered) {
        await con.messages.storeMessage(msg, con, null);
    }

    let chanName = msg.params[0];
    let chan = con.state.getBuffer(chanName) || con.state.addBuffer(chanName, con);

    if (msg.nick.toLowerCase() !== con.state.nick.toLowerCase()) {
        // Someone else joined the channel
        chan.addUser(msg.nick, {
            host: msg.hostname || undefined,
            username: msg.ident || undefined,
        });

        return;
    }

    // Get channel modes so they can be tracked
    con.writeLine('MODE', chanName);

    chan.joined = true;
    await con.state.save();
};

commands.PART = async function(msg, con) {
    msgIdGenerator.add(msg);

    if (con.state.logging && con.state.netRegistered) {
        await con.messages.storeMessage(msg, con, null);
    }

    let chanName = msg.params[0];
    let chan = con.state.getBuffer(chanName);

    if (!chan) {
        // If we don't have this buffer the there's nothing to do
        return;
    }

    if (msg.nick.toLowerCase() !== con.state.nick.toLowerCase()) {
        // Someone else left the channel
        chan.removeUser(msg.nick);
    } else {
        chan.partReceived = false;
        chan.leave();
    }

    await con.state.save();
};

commands.KICK = async function(msg, con) {
    let chanName = msg.params[0];
    let chan = con.state.getBuffer(chanName);
    let kickedNick = msg.params[1];

    if (!chan) {
        // If we don't have this buffer the there's nothing to do
        return;
    }
    if (msg.params[1].toLowerCase() !== con.state.nick.toLowerCase()) {
        // someone else was kicked
        chan.removeUser(kickedNick);
    } else {
        chan.leave();
    }

    await con.state.save();
};

commands.QUIT = async function(msg, con) {
    let nick = msg.nick;

    for (let bufferName in con.state.buffers) {
        con.state.buffers[bufferName].removeUser(nick);
    }

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
    // Only auto change our nick if we're still trying to connect
    if (con.state.netRegistered) {
        return true;
    }

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
    msgIdGenerator.add(msg);

    if (con.state.logging && con.state.netRegistered) {
        await con.messages.storeMessage(msg, con, null);
    }

    // Update nick in buffer users
    for (let bufferName in con.state.buffers) {
        let buffer = con.state.buffers[bufferName];
        buffer.renameUser(msg.nick, msg.params[0]);
    }

    if (msg.nick.toLowerCase() !== con.state.nick.toLowerCase()) {
        l.trace(`Someone changed their nick from ${msg.nick} to ${msg.params[0]}`);

        // Someone elses nick changed. Update any buffers we have to their new nick
        let buffer = con.state.getBuffer(msg.nick);
        if (!buffer) {
            return;
        }

        // Try to track nick changes so that they stay in the same buffer instance
        con.state.renameBuffer(buffer.name, msg.params[0]);
        con.state.save();

    } else {
        l.trace(`Our nick changed from ${msg.nick} to ${msg.params[0]}`);

        // Our nick changed, keep track of it
        con.state.nick = msg.params[0];
        con.state.save();
    }
};

commands.PRIVMSG = async function(msg, con) {
    msgIdGenerator.add(msg);

    if (con.state.logging && con.state.netRegistered) {
        await con.messages.storeMessage(msg, con, null);
    }

    // Make sure we have this buffer
    con.state.getOrAddBuffer(bufferNameIfPm(msg, con.state.nick, 0), con);
};

commands.NOTICE = async function(msg, con) {
    msgIdGenerator.add(msg);

    if (con.state.logging && con.state.netRegistered) {
        await con.messages.storeMessage(msg, con, null);
    }
    const bufferName = bufferNameIfPm(msg, con.state.nick, 0);
    // Some notices come from the server without a nick, don't create an empty buffername for these
    if (bufferName) {
        // Make sure we have this buffer
        con.state.getOrAddBuffer(bufferName, con);
    }
};

commands.ERROR = async function(msg, con) {
    if (msg.params[0]) {
        await con.state.tempSet('irc_error', msg.params[0]);
    }
};

// RPL_NAMEREPLY
commands['353'] = async function(msg, con) {
    let bufferName = msg.params[2];
    let buffer = con.state.getBuffer(bufferName) || con.state.addBuffer(bufferName, con);

    if (!con.state.tempGet('receiving_names')) {
        // This is the start of a new NAMES list. Clear out the old for this new one
        await con.state.tempSet('receiving_names', true);
        buffer.users = Object.create(null);
    }

    let ircdPrefixes = parsePrefixes(con.iSupportToken('PREFIX'));

    // Store buffer status ('@' || '*' || '=')
    buffer.status = msg.params[1];

    let userMasks = msg.params[msg.params.length - 1].split(' ');
    userMasks.forEach(mask => {
        if (!mask) {
            return;
        }
        var j = 0;
        var modes = [];
        var user = null;

        // If we have prefixes, strip them from the nick and keep them separate
        for (let j = 0; j < ircdPrefixes.length; j++) {
            if (mask[0] === ircdPrefixes[j].symbol) {
                modes.push(ircdPrefixes[j].symbol);
                mask = mask.substring(1);
            }
        }

        // We may have a full user mask if the userhost-in-names CAP is enabled
        user = parseMask(mask);

        buffer.addUser(user.nick, {
            host: user.hostname || undefined,
            username: user.ident || undefined,
            prefixes: modes || undefined,
        });
    });

    await con.state.save();
    return false;
};

// RPL_ENDOFNAMES
commands['366'] = async function(msg, con) {
    await con.state.tempSet('receiving_names', null);
    let buffer = con.state.getBuffer(msg.params[1]);
    if (buffer) {
        con.forEachClient(c => c.sendNames(buffer));
    }
    return false;
};

commands.MODE = async function(msg, con) {
    const parsedModes = parseMode(con, msg.params[0], msg.params[1], msg.params.slice(2));

    const buffer = con.state.getBuffer(parsedModes.target);

    if (parsedModes.isChannel && !buffer) {
        return;
    }

    let updateStatus = false;

    parsedModes.modes.forEach((m) => {
        if (m.type === modeTypes.A || m.type === modeTypes.Unknown) {
            // Skip list based type A channel modes like +b
            // Skip unknown type modes
            return;
        }

        if (m.type === modeTypes.Prefix) {
            // Update user prefixes like adding @ for +o
            let lcNick = (m.param || '').toLowerCase();
            let user = buffer.users[lcNick];
            if (!user) {
                l.error(`Got user channel mode for unknown user: ${m.param}`);
                return;
            }
            user.updatePrefixes(m, con);
            return;
        }

        if (parsedModes.isChannel) {
            // Update channel modes like +p
            buffer.updateChanModes(m);

            if (['p', 's'].includes(m.mode[1])) {
                // Only update buffer status if modes p or s changed
                updateStatus = true;
            }
        } else {
            con.state.updateUserModes(m);
        }
    });

    if (updateStatus) {
        buffer.status = getModesStatus(buffer);
    }
}

// RPL_CHANNELMODEIS
commands['324'] = async function(msg, con) {
    let buffer = con.state.getBuffer(msg.params[1]);

    if (!buffer) {
        return;
    }

    const parsedModes = parseMode(con, msg.params[1], msg.params[2], msg.params.slice(3));
    parsedModes.modes.forEach((m) => {
        if (m.type <= modeTypes.A) {
            // Skip unwanted type A channel modes (0)
            // These are list based modes like +b
            return;
        }
        buffer.updateChanModes(m);
    });
    buffer.status = getModesStatus(buffer);
}

function bufferNameIfPm(message, nick, messageNickIdx) {
    if (nick.toLowerCase() === (message.params[messageNickIdx] || '').toLowerCase()) {
        // It's a PM
        return message.nick;
    } else {
        return message.params[messageNickIdx];
    }
}
