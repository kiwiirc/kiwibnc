const IrcMessage = require('irc-framework').Message;

let baseId = 'kiwibnc-'+Date.now();
let msgId = 0;

module.exports.init = async function init(hooks) {
    // echo-message support
    hooks.on('available_caps', (event) => {
        event.caps.add('echo-message');
    });
    hooks.on('wanted_caps', (event) => {
        event.wantedCaps.add('echo-message');
        Array.from(event.client.state.linkedIncomingConIds).forEach((linkedId) => {
            let cCon = event.client.conDict.map.get(linkedId);
            if(cCon.state.caps.has('echo-message')) {
                event.wantedCaps.add('echo-message');
            }
        })
    });
    hooks.on('message_from_client', (event) => {
        if (!event.client.state.netRegistered) {
            return;
        }
        let upstream = event.client.upstream;
        if(!upstream) {
            return;
        }
        // If the server doesn't support echo-message we do it ourselves with our own message.
        if (!upstream.state.caps.has('echo-message')) {
            let msg = event.message;
            if(msg.command !== 'PRIVMSG' && msg.command !== 'NOTICE' && msg.command !== 'ACTION') {
                return;
            }
            // Give ID to original message so it is stored correctly
            msg.tags.msgid = baseId + '-' + msgId++;

            let m = new IrcMessage(msg.command, ...msg.params);
            m.tags = {...msg.tags};
            m.nick = upstream.state.nick;
            m.username = upstream.state.username;
            m.hostname = upstream.state.host;
            m.prefix = m.nick + '!' + m.username + '@' + m.hostname;

            upstream.forEachClient((client) => {
                // Don't echo back to client that sent if it's not expecting it.
                if(client === event.client && !event.client.state.caps.has('echo-message')) {
                    return;
                }
                client.writeMsg(m);
            });
        }
    });
    hooks.on('message_to_client', (event) => {
        // Disables normal bnc behavior of echoing a message to connected clients
        if(!event.client.upstream) {
            return;
        }
        if((event.message.command === 'PRIVMSG' || event.message.command === 'NOTICE')
        && (event.client.state.nick === event.message.prefix)) {
            event.preventDefault();
        }
    });
};
