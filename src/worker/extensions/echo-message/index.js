const IrcMessage = require('irc-framework').Message;

let baseId = 'kiwibnc-'+Date.now();
let msgId = 0;

module.exports.init = async function init(hooks) {
    // echo-message support
    hooks.on('available_caps', event => {
        event.caps.add('echo-message');
    });
    hooks.on('message_from_client', event => {
        if (!event.client.state.netRegistered) {
            return;
        }
        let upstream = event.client.upstream;

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
            
            m.prefix = m.nick+'!'+m.username+'@'+m.hostname;

            event.client.writeMsg(m);
        }
    });
};
