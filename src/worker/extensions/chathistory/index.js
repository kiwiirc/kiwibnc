const Irc = require('irc-framework');
const { mParam, mParamU } = require('../../../libs/helpers');

const MAX_MESSAGES = 50;

let stats = null;

module.exports.init = async function init(hooks, app) {
    stats = app.stats.makePrefix('chathistory');

    hooks.on('message_from_client', event => {
        if (event.message.command.toUpperCase() === 'CHATHISTORY') {
            return handleCommand(event);
        }
    });

    hooks.on('available_isupports', async event => {
        event.tokens.push('CHATHISTORY=' + MAX_MESSAGES);
    });
};

async function handleCommand(event) {
    event.preventDefault();
    event.passthru = false;

    let msg = event.message;
    let con = event.client;
    let messageDb = con.messages;

    let subCmd = mParamU(msg, 0, '');
    let target = mParam(msg, 1, '');

    let messages = [];

    if (subCmd === 'BEFORE' || subCmd === 'AFTER') {
        messages = await commandBeforeOrAfter(msg, con, messageDb);
    } else if (subCmd === 'LATEST') {
        messages = await commandLatest(msg, con, messageDb);
    } else if (subCmd === 'BETWEEN') {
        messages = await commandBetween(msg, con, messageDb);
    } else if (subCmd === 'AROUND') {
        messages = await commandAround(msg, con, messageDb);
    }

    if (messages) {
        let batchId = Math.round(Math.random()*1e17).toString(36);

        let m = new Irc.Message('BATCH', '+' + batchId, 'chathistory', target);
        m.prefix = 'bnc';
        con.writeMsg(m);

        messages.forEach(message => {
            message.tags.batch = batchId;
            con.writeMsg(message);
        });

        m = new Irc.Message('BATCH', '-' + batchId);
        m.prefix = 'bnc';
        con.writeMsg(m);
    }
};

async function commandAround(msg, con, messageDb) {
    // TODO: implement this
    con.writeMsg(
        'FAIL',
        'CHATHISTORY',
        'UNKNOWN_COMMAND',
        'AROUND',
        'Unknown command',
    );
}

async function commandBetween(msg, con, messageDb) {
    let messages = [];
    let target = mParam(msg, 1, '');
    let fromMsgRef = parseReference(mParam(msg, 2, ''));
    let toMsgRef = parseReference(mParam(msg, 3, ''));
    let paramLimit = parseLimit(mParam(msg, 4, ''), MAX_MESSAGES);

    if (
        (fromMsgRef.type === 'timestamp' || fromMsgRef.type === 'msgid') &&
        (toMsgRef.type === 'timestamp' || toMsgRef.type === 'msgid')
    ) {
        // messageDb requires timestanps in numeric format
        if (fromMsgRef.type === 'timestamp') {
            fromMsgRef.value = dateToTs(fromMsgRef.value);
        }
        if (toMsgRef.type === 'timestamp') {
            toMsgRef.value = dateToTs(toMsgRef.value);
        }
        messages = await messageDb.getMessagesBetween(
            con.state.authUserId,
            con.state.authNetworkId,
            target,
            fromMsgRef,
            toMsgRef,
            paramLimit,
        );
    } else {
        con.writeMsg(
            'FAIL',
            'CHATHISTORY',
            'NEED_MORE_PARAMS',
            'BETWEEN',
            'Timestamp or message ID should be given',
        );
        return;
    }

    return messages;
}

async function commandLatest(msg, con, messageDb) {
    let messages = [];
    let target = mParam(msg, 1, '');
    let msgRef = parseReference(mParam(msg, 2, ''));
    let paramLimit = parseLimit(mParam(msg, 3, ''), MAX_MESSAGES);

    // We want to get messages between msgRef and NOW(), max paramLimit messages
    if (msgRef.type === 'timestamp') {
        messages = await messageDb.getMessagesBeforeTime(
            con.state.authUserId,
            con.state.authNetworkId,
            target,
            Date.now(),
            paramLimit,
        );
    } else if (msgRef.type === 'msgid') {
        // TODO: This LATEST subcommand is weird. implement this when its refactored
    } else {
        con.writeMsg(
            'FAIL',
            'CHATHISTORY',
            'NEED_MORE_PARAMS',
            'LATEST',
            'Timestamp or message ID should be given',
        );
        return;
    }

    return messages;
}

async function commandBeforeOrAfter(msg, con, messageDb) {
    let messages = [];
    let subCmd = mParamU(msg, 0, '');
    let target = mParam(msg, 1, '');
    let msgRef = parseReference(mParam(msg, 2, ''));
    let paramLimit = parseLimit(mParam(msg, 3, ''), MAX_MESSAGES);

    if (msgRef.type === 'timestamp') {
        let ts = dateToTs(msgRef.value);

        if (subCmd === 'AFTER') {
            messages = await messageDb.getMessagesFromTime(
                con.state.authUserId,
                con.state.authNetworkId,
                target,
                ts,
                paramLimit,
            );
        } else if (subCmd === 'BEFORE') {
            messages = await messageDb.getMessagesBeforeTime(
                con.state.authUserId,
                con.state.authNetworkId,
                target,
                ts,
                paramLimit,
            );
        }

    } else if (msgRef.type === 'msgid') {
        let msgid = dateToTs(msgRef.value);

        if (subCmd === 'AFTER') {
            messages = await messageDb.getMessagesFromMsgId(
                con.state.authUserId,
                con.state.authNetworkId,
                target,
                msgid,
                paramLimit,
            );
        } else if (subCmd === 'BEFORE') {
            messages = await messageDb.getMessagesBeforeMsgId(
                con.state.authUserId,
                con.state.authNetworkId,
                target,
                msgid,
                paramLimit,
            );
        }

    } else {
        con.writeMsg(
            'FAIL',
            'CHATHISTORY',
            'NEED_MORE_PARAMS',
            subCmd,
            'Timestamp or message ID should be given',
        );
        return;
    }

    return messages;
}

// Convert a date string to a UTC time int, defaulting to now if it fails
function dateToTs(str) {
    let ts = new Date(str).getTime();
    if (isNaN(ts)) {
        ts = Date.now();
    }
    return ts;
}

// Convert 'timestamp=1234' or 'msgid=1234' into an object {type:msgid, value:1234}
function parseReference(str) {
    let ret = { type: '', value: '' };
    let pos = str.indexOf('=');
    if (pos <= 0) {
        return ret;
    }

    ret.type = str.substr(0, pos).toLowerCase();
    ret.value = str.substr(pos + 1);
    return ret;
}

// Convert a string into an int within a maximum range
function parseLimit(str, max) {
    let limit = parseInt(str, 10);
    if (isNaN(limit) || limit > max || limit < 0) {
        limit = max;
    }
    return limit;
}