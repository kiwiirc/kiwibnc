const Irc = require('irc-framework');
const { mParam, mParamU } = require('../../../libs/helpers');

const MAX_MESSAGES = 50;

module.exports.init = async function init(hooks) {
    hooks.on('message_from_client', event => {
        if (event.message.command.toUpperCase() === 'CHATHISTORY') {
            return handleCommand(event);
        }
    });

    hooks.on('message_to_client', event => {
        if (event.message.command === '001') {
            setTimeout(() => {
                // TODO: This timeout is ugly. Find a way to only send this once when it detects
                //       a 005 message
                event.client.writeFromBnc('005', event.client.state.nick, 'CHATHISTORY=' + MAX_MESSAGES);
            }, 1);
        }
    });
};

async function handleCommand(event) {
    // CHATHISTORY ${this.name} timestamp=${timeStr} message_count=${numMessages}
    event.preventDefault();
    event.passthru = false;

    let msg = event.message;
    let con = event.client;
    let messageDb = con.messages;

    let target = mParam(msg, 0, '');
    let [, timestamp] = mParam(msg, 1, '').split('=');
    let [, msgCount] = mParam(msg, 2, '').split('=');

    msgCount = parseInt(msgCount);
    if (isNaN(msgCount)) {
        msgCount = MAX_MESSAGES;
    } else if (msgCount > MAX_MESSAGES) {
        msgCount = MAX_MESSAGES;
    } else if (msgCount < -MAX_MESSAGES) {
        msgCount = -MAX_MESSAGES;
    }

    let ts = new Date(timestamp).getTime();
    if (isNaN(ts)) {
        ts = Date.now();
    }

    let messages = [];

    if (msgCount > 0) {
        messages = await messageDb.getMessagesFromTime(
            con.state.authUserId,
            con.state.authNetworkId,
            target,
            ts,
            msgCount,
        );
    } else {
        messages = await messageDb.getMessagesBeforeTime(
            con.state.authUserId,
            con.state.authNetworkId,
            target,
            ts,
            Math.abs(msgCount),
        );
    }

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
};
