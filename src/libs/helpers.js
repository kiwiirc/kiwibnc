const strftime = require('strftime').timezone('+0');
const _ = require('lodash');

module.exports.isoTime = isoTime;
function isoTime(date) {
    return date ?
        strftime('%Y-%m-%dT%H:%M:%S.%LZ', date) :
        strftime('%Y-%m-%dT%H:%M:%S.%LZ');
}

module.exports.now = now;
function now() {
    return Math.floor(Date.now() / 1000);
}

// Get a message param or return a default
module.exports.mParam = mParam;
function mParam(msg, idx, def) {
    return msg.params[idx] || def;
}

// Get a message param or a default, and return it in uppercase
module.exports.mParamU = mParamU;
function mParamU(msg, idx, def) {
    return (mParam(msg, idx, def) || '').toUpperCase();
}

// Validate a username
module.exports.validUsername = validUsername;
function validUsername(username) {
    return (/^[^0-9\-][0-9a-z[\]^_`{|}\-]+$/i).test(username);
}

// Parse a string such as tcp://hostname:1234/path into:
// {proto:'tcp', hostname:'hostname', port:1234, path:'path'}
module.exports.parseBindString = parseBindString;
function parseBindString(inp) {
    let m = inp.match(/^(?:(?<proto>[^:]+)?:\/\/)?(?<hostname>[^:]+)(?::(?<port>[0-9]*))?(?<path>.*)$/);
    if (!m) {
        return;
    }

    return m.groups;
}

// Clone an IRC message
module.exports.cloneIrcMessage = cloneIrcMessage;
function cloneIrcMessage(srcMsg) {
    let msg = new srcMsg.constructor(srcMsg.command);
    msg.tags = srcMsg.tags;
    msg.prefix = srcMsg.prefix;
    msg.nick = srcMsg.nick;
    msg.ident = srcMsg.ident;
    msg.hostname = srcMsg.hostname;
    msg.command = srcMsg.command;
    msg.params = srcMsg.params;
    return msg;
}

// Parse a user mask into its user/ident/host parts
module.exports.parseMask = parseMask;
function parseMask(mask) {
    var nick = '';
    var user = '';
    var host = '';

    var sep1 = mask.indexOf('!');
    var sep2 = mask.indexOf('@');

    if (sep1 === -1 && sep2 === -1) {
        // something
        if (mask.indexOf('.') > -1) {
            host = mask;
        } else {
            nick = mask;
        }
    } else if (sep1 === -1 && sep2 !== -1) {
        // something@something
        nick = mask.substring(0, sep2);
        host = mask.substring(sep2 + 1);
    } else if (sep1 !== -1 && sep2 === -1) {
        // something!something
        nick = mask.substring(0, sep1);
        user = mask.substring(sep1 + 1);
    } else {
        // something!something@something
        nick = mask.substring(0, sep1);
        user = mask.substring(sep1 + 1, sep2);
        host = mask.substring(sep2 + 1);
    }

    return {
        nick: nick,
        user: user,
        host: host,
    };
}

// Parse ircdPrefixes (ov)@+ into [{mode:"o",symbol:"@"},{mode:"v",symbol:"+"}]
module.exports.parsePrefixes = parsePrefixes;
function parsePrefixes(prefix) {
    let ircdPrefixes = [];
    let matches = /\(([^)]*)\)(.*)/.exec(prefix || '');
    if (matches && matches.length === 3) {
        for (let j = 0; j < matches[2].length; j++) {
            ircdPrefixes.push({
                symbol: matches[2].charAt(j),
                mode: matches[1].charAt(j)
            });
        }
    }
    return ircdPrefixes;
}


const modeTypes = {
    NOT_CHANMODE: -1,
    CHANMODE_TYPE_A: 0,
    CHANMODE_TYPE_B: 1,
    CHANMODE_TYPE_C: 2,
    CHANMODE_TYPE_D: 3,
}
module.exports.modeTypes = modeTypes

/**
 * Convert a mode string such as '+k pass', or '-i' to a readable
 * format.
 * [ { mode: '+k', param: 'pass', type: 1 } ]
 * [ { mode: '-i', param: null, type: 3 } ]
 *
 *  type: -1 = not channel mode, 0-3 = CHANMODES Type A-D
 *
 * adapted from https://github.com/kiwiirc/irc-framework/blob/59d11c3f89fe54e5f59ab82fe12e8301312833d9/src/commands/handler.js
 */
module.exports.parseMode = parseMode;
function parseMode(con, mode_string, mode_params) {
    const chanmodes = (con.iSupportToken('CHANMODES') || '').split(',');
    let prefixes = parsePrefixes(con.iSupportToken('PREFIX'));
    let always_param = (chanmodes[0] || '').concat((chanmodes[1] || ''));
    const modes = [];

    if (!mode_string) {
        return modes;
    }

    prefixes = _.reduce(prefixes, function(list, prefix) {
        list.push(prefix.mode);
        return list;
    }, []);
    always_param = always_param.split('').concat(prefixes);

    const hasParam = function(mode, isAdd) {
        const matchMode = function(m) {
            return m === mode;
        };

        if (_.find(always_param, matchMode)) {
            return true;
        }

        if (isAdd && _.find((chanmodes[2] || '').split(''), matchMode)) {
            return true;
        }

        return false;
    };

    const modeType = (mode) => {
        for (let i = 0; i < chanmodes.length; i++) {
            if (chanmodes[i].indexOf(mode) > -1) {
                return i;
            }
        }
        return modeTypes.NOT_CHANMODE;
    };

    let add;
    let j = 0;
    for (let i = 0; i < mode_string.length; i++) {
        switch (mode_string[i]) {
        case '+':
            add = true;
            break;
        case '-':
            add = false;
            break;
        default:
            if (hasParam(mode_string[i], add)) {
                modes.push({ mode: (add ? '+' : '-') + mode_string[i], param: mode_params[j], type: modeType(mode_string[i]) });
                j++;
            } else {
                modes.push({ mode: (add ? '+' : '-') + mode_string[i], param: null, type: modeType(mode_string[i]) });
            }
        }
    }

    return modes;
}

module.exports.getModesStatus = getModesStatus;
function getModesStatus(buffer) {
    if ('s' in buffer.modes) {
        return '@';
    }
    if ('p' in buffer.modes) {
        return '*';
    }
    return '=';
}
