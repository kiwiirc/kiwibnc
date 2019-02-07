/**
 * Tap into some hooks to modify messages and capabilities
 */

let hooks = module.exports.hooks = [];

// Some caps to always request
hooks.push(function(commandHooks) {
    commandHooks.on('available_caps', event => {
        event.caps.push('batch');
    });
});

// server-time support
hooks.push(function(commandHooks) {
    commandHooks.on('message_to_client', event => {
        let caps = event.client.state.caps;

        if (caps.includes('server-time')) {
            if (!event.message.tags['time']) {
                event.message.tags['time'] = strftime('%Y-%m-%dT%H:%M:%S.%LZ');
            }
        } else {
            delete event.message.tags['time'];
        }
    });
    commandHooks.on('available_caps', event => {
        let caps = event.caps.push('server-time');
    });
});

// away-notify support
hooks.push(function(commandHooks) {
    commandHooks.on('message_to_client', event => {
        if (!event.client.state.caps.includes('away-notify') && event.message.command === 'AWAY') {
            event.halt = true;
        }
    });
    commandHooks.on('available_caps', event => {
        event.caps.push('away-notify');
    });
});

// account-notify support
hooks.push(function(commandHooks) {
    commandHooks.on('message_to_client', event => {
        if (!event.client.state.caps.includes('account-notify') && event.message.command === 'ACCOUNT') {
            event.halt = true;
        }
    });
    commandHooks.on('available_caps', event => {
        event.caps.push('account-notify');
    });
});

// account-tag support
hooks.push(function(commandHooks) {
    commandHooks.on('message_to_client', event => {
        if (!event.client.state.caps.includes('account-tag') && event.message.tags['account']) {
            delete event.message.tags['account'];
        }
    });
    commandHooks.on('available_caps', event => {
        event.caps.push('account-tag');
    });
});

// extended-join support
hooks.push(function(commandHooks) {
    commandHooks.on('available_caps', event => {
        if (!event.client.upstream) {
            return;
        }

        // Only allow the client to use extended-join if upstream has it
        let upstream = event.client.upstream;
        if (upstream.state.caps.include('extended-join')) {
            event.caps.push('extended-join');
        }
    });
    commandHooks.on('message_to_client', event => {
        // :nick!user@host JOIN #channelname * :Real Name
        let caps = event.client.state.caps;
        let m = event.message;
        if (!caps.includes('extended-join') && m.command === 'JOIN' && m.params.length > 2) {
            // Drop the account name from the params (The * in the above example)
            m.params.splice(1, 1);
        }
    });
});

// multi-prefix support
hooks.push(function(commandHooks) {
    commandHooks.on('available_caps', event => {
        event.caps.push('multi-prefix');
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
        if (!clientCaps.includes('multi-prefix') && upstreamCaps.includes('multi-prefix')) {
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
});

// userhost-in-names support
hooks.push(function(commandHooks) {
    commandHooks.on('available_caps', event => {
        event.caps.push('userhost-in-names');
    });
    commandHooks.on('message_to_client', event => {
        // :server.com 353 guest = #tethys :~&@%+aji &@Attila @+alyx +KindOne Argure
        let caps = event.client.state.caps;
        let m = event.message;
        if (m.command === '353' && !caps.includes('userhost-in-names')) {
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
});


function splitPrefixAndNick(prefixes, input) {
    let itemPrefixes = '';
    let nick = '';

    for (let i = 0; i < input.length; i++) {
        if (prefixes.indexOf(input[i]) > -1) {
            itemPrefixes += input[i];
        } else {
            nick = input.substr(i + 1);
            break;
        }
    }

    return {
        nick: nick || '',
        prefixes: itemPrefixes || '',
    };
}
