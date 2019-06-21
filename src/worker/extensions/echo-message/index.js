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
            if(msg.command !== 'PRIVMSG' && msg.command !== 'NOTICE') {
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
        let {client, message} = event;
        if(message.command === 'PRIVMSG' || message.command === 'NOTICE') {
            if (!client.state.caps.has('echo-message')
            && client.state.nick+'!'+client.state.username === message.nick+'!'+message.ident) {
                event.preventDefault();
            } else if(client.state.caps.has('echo-message') && message.from_client) {
                event.preventDefault(); // Client and server support echo-message and msg came from a client, so ignore it.
            }
        }
    });
};
