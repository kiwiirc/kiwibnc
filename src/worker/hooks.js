const EventEmitter = require('../libs/eventemitter');
const { isoTime } = require('../libs/helpers');

/**
 * Tap into some hooks to modify messages and capabilities
 */

let commandHooks = new EventEmitter();
module.exports = commandHooks;

commandHooks.addBuiltInHooks = function addBuiltInHooks() {
    // Some caps to always request
    commandHooks.on('available_caps', event => {
        event.caps.add('batch');
        event.caps.add('cap-notify');
    });

    // server-time support
    commandHooks.on('message_to_client', event => {
        let caps = event.client.state.caps;

        if (caps.has('server-time')) {
            if (!event.message.tags['time']) {
                event.message.tags['time'] = isoTime();
            }
        } else {
            delete event.message.tags['time'];
        }
    });
    commandHooks.on('available_caps', event => {
        let caps = event.caps.add('server-time');
    });

    // away-notify support
    commandHooks.on('message_to_client', event => {
        if (!event.client.state.caps.has('away-notify') && event.message.command === 'AWAY') {
            event.preventDefault();
        }
    });
    commandHooks.on('available_caps', event => {
        event.caps.add('away-notify');
    });

    // account-notify support
    commandHooks.on('message_to_client', event => {
        if (!event.client.state.caps.has('account-notify') && event.message.command === 'ACCOUNT') {
            event.preventDefault();
        }
    });
    commandHooks.on('available_caps', event => {
        event.caps.add('account-notify');
    });

    // account-tag support
    commandHooks.on('message_to_client', event => {
        if (!event.client.state.caps.has('account-tag') && event.message.tags['account']) {
            delete event.message.tags['account'];
        }
    });
    commandHooks.on('available_caps', event => {
        event.caps.add('account-tag');
    });

    // invite-notify support
    commandHooks.on('message_to_client', event => {
        if (!event.client.state.caps.has('invite-notify') && event.message.command === 'INVITE') {
            event.preventDefault();
        }
    });
    commandHooks.on('available_caps', event => {
        event.caps.add('invite-notify');
    });

    // extended-join support
    commandHooks.on('available_caps', event => {
        if (!event.client.upstream) {
            return;
        }

        // Only allow the client to use extended-join if upstream has it
        let upstream = event.client.upstream;
        if (upstream.state.caps.has('extended-join')) {
            event.caps.add('extended-join');
        }
    });
    commandHooks.on('message_to_client', event => {
        // :nick!user@host JOIN #channelname * :Real Name
        let caps = event.client.state.caps;
        let m = event.message;
        if (!caps.has('extended-join') && m.command === 'JOIN' && m.params.length > 2) {
            // Drop the account name from the params (The * in the above example)
            m.params.splice(1, 1);
        }
    });

    // message-tags (and msgid, c2ctags, etc) support
    commandHooks.on('available_caps', event => {
        event.caps.add('message-tags');
    });
    commandHooks.on('message_to_client', event => {
        let m = event.message;
        if (!event.client.state.caps.has('message-tags')) {
            if (m.command === 'TAGMSG') {
                event.preventDefault();
                return;
            }

            let initialTags = Object.keys(m.tags);
            for (let i = 0; i < initialTags.length; i++) {
                let key = initialTags[i];
                if (key.startsWith('+') && m.tags[key]) {
                    delete m.tags[key];
                } else if (key.toLowerCase() == 'msgid' && m.tags[key]) {
                    delete m.tags[key];
                }

                // Some caps when enabled signify that the client can handle message-tags.
                // If none of these have been requested then assume that the client cannot
                // handle message-tags at all.
                if (!event.client.state.caps.has('server-time')) {
                    m.tags = {};
                }

                //TODO: move all the specific tag-blocking done by other handlers
                //  into this one or something similar, since message-tags allows
                //  any c2c or regular tag
            }
        }
    });

    // multi-prefix support
    commandHooks.on('available_caps', event => {
        event.caps.add('multi-prefix');
    });
    commandHooks.on('message_to_client', event => {
        let m = event.message;
        // Only listen for 353(NAMES) and 352(WHO) replies
        if (m.command !== '353' && m.command !== '352') {
            return;
        }

        if (!event.client.upstream) {
            return;
        }

        let clientCaps = event.client.state.caps;
        let upstreamCaps = event.client.upstream.state.caps;
        if (!clientCaps.has('multi-prefix') && upstreamCaps.has('multi-prefix')) {
            // Make sure only one prefix is included in the message before sending them to the client

            let prefixes = event.client.upstream.state.isupports.find(token => {
                return token.indexOf('PREFIX=') === 0;
            });

            // Convert "PREFIX=(qaohv)~&@%+" to "~&@%+"
            prefixes = (prefixes || '').split('=')[1] || '';
            prefixes = prefixes.substr(prefixes.indexOf(')') + 1);

            // :server.com 353 guest = #tethys :~&@%+aji &@Attila @+alyx +KindOne Argure
            if (m.command === '353') {
                // Only keep the first prefix for each user from the userlist
                let list = m.params[3].split(' ').map(item => {
                    let parts = splitPrefixAndNick(prefixes, item);
                    return parts.prefixes[0] + parts.nick;
                });

                m.params[3] = list.join(' ');
            }

            // :kenny.chatspike.net 352 guest #test grawity broken.symlink *.chatspike.net grawity H@%+ :0 Mantas M.
            if (m.command === '352') {
                let remapped = '';
                let status = m.params[6] || '';
                if (status[0] === 'H' || status[0] === 'A') {
                    remapped += status[0];
                    status = status.substr(1);
                }

                if (status[0] === '*') {
                    remapped += status[0];
                    status = status.substr(1);
                }

                if (status[0]) {
                    remapped += status[0];
                    status = status.substr(1);
                }

                m.params[6] = remapped;
            }
        }
    });

    // userhost-in-names support
    commandHooks.on('available_caps', event => {
        event.caps.add('userhost-in-names');
    });
    commandHooks.on('message_to_client', event => {
        // :server.com 353 guest = #tethys :~&@%+aji &@Attila @+alyx +KindOne Argure
        let caps = event.client.state.caps;
        let m = event.message;
        if (m.command === '353' && !caps.has('userhost-in-names')) {
            let prefixes = event.client.upstream.state.isupports.find(token => {
                return token.indexOf('PREFIX=') === 0;
            });

            // Convert "PREFIX=(qaohv)~&@%+" to "~&@%+"
            prefixes = (prefixes || '').split('=')[1] || '';
            prefixes = prefixes.substr(prefixes.indexOf(')') + 1);

            // Make sure the user masks only contain nicks
            let list = m.params[3].split(' ').map(item => {
                let parts = splitPrefixAndNick(prefixes, item);
                let mask = parts.nick;

                let pos = mask.indexOf('!');
                if (pos === -1) {
                    // No username separator, so it's safely just the nick
                    return mask;
                }

                return mask.substring(0, pos)
            });

            m.params[3] = list.join(' ');
        }
    });

    function splitPrefixAndNick(prefixes, input) {
        let itemPrefixes = '';
        let nick = '';

        for (let i = 0; i < input.length; i++) {
            if (prefixes.indexOf(input[i]) > -1) {
                itemPrefixes += input[i];
            } else {
                nick = input.substr(i);
                break;
            }
        }

        return {
            nick: nick || '',
            prefixes: itemPrefixes || '',
        };
    }
};
