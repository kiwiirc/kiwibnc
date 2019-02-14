let IrcFrameworkNumerics = require('irc-framework/src/commands/numerics');

// Swap the numeric key/val around so it's easier to lookup raw commands
let numerics = {};
for(let key in IrcFrameworkNumerics){
    numerics[IrcFrameworkNumerics[key]] = key;
}

// If the routes[].cmd matches the command sent from a client, its expected commands
// are then flagged to the client instance. When an upstream sends one of the expected
// commands, they are then only sent to the clients that have been flagged for them.
// If no clients have been flagged with the expected commands, it is then sent to
// all connected clients.
let routes = [
    { cmd: 'NAMES', params: [], expect: [
        { cmd: '401', ending: true }, // ERR_NOSUCHNICK
        { cmd: '353', ending: false }, // RPL_NAMREPLY
        { cmd: '366', ending: true }, // RPL_ENDOFNAMES
    ]},
    { cmd: 'MODE', params: ['', '+b'], expect: [
        { cmd: '367', ending: false }, // RPL_BANLIST
        { cmd: '368', ending: true }, // RPL_ENDOFBANLIST
        { cmd: '403', ending: true }, // ERR_NOSUCHCHANNEL
        { cmd: '442', ending: true }, // ERR_NOTONCHANNEL
        { cmd: '467', ending: true }, // ERR_KEYSET
        { cmd: '472', ending: true }, // ERR_UNKNOWNMODE
        { cmd: '501', ending: true }, // ERR_UMODEUNKNOWNFLAG
        { cmd: '502', ending: true }, // ERR_USERSDONTMATCH
        { cmd: '482', ending: false }, // ERR_CHANOPRIVSNEEDED
    ]},
    { cmd: 'MODE', params: ['', '+I'], expect: [
        { cmd: '346', ending: false }, // RPL_INVITELIST
        { cmd: '347', ending: true }, // RPL_ENDOFINVITELIST
        { cmd: '403', ending: true }, // ERR_NOSUCHCHANNEL
        { cmd: '442', ending: true }, // ERR_NOTONCHANNEL
        { cmd: '467', ending: true }, // ERR_KEYSET
        { cmd: '472', ending: true }, // ERR_UNKNOWNMODE
        { cmd: '501', ending: true }, // ERR_UMODEUNKNOWNFLAG
        { cmd: '502', ending: true }, // ERR_USERSDONTMATCH
        { cmd: '482', ending: false }, // ERR_CHANOPRIVSNEEDED
    ]},
    { cmd: 'MODE', params: ['', '+e'], expect: [
        { cmd: '348', ending: false }, // RPL_EXCEPTLIST
        { cmd: '349', ending: true }, // RPL_ENDOFEXCEPTLIST
        { cmd: '403', ending: true }, // ERR_NOSUCHCHANNEL
        { cmd: '442', ending: true }, // ERR_NOTONCHANNEL
        { cmd: '467', ending: true }, // ERR_KEYSET
        { cmd: '472', ending: true }, // ERR_UNKNOWNMODE
        { cmd: '501', ending: true }, // ERR_UMODEUNKNOWNFLAG
        { cmd: '502', ending: true }, // ERR_USERSDONTMATCH
        { cmd: '482', ending: false }, // ERR_CHANOPRIVSNEEDED
    ]},
    { cmd: 'WHO', params: [], expect: [
        { cmd: numerics.ERR_NOSUCHSERVER, ending: true },
        { cmd: numerics.RPL_WHOREPLY, ending: false },
        { cmd: numerics.RPL_WHOSPCRPL, ending: false }, // whox 
        { cmd: numerics.RPL_ENDOFWHO, ending: true },
    ]},
    { cmd: 'WHOIS', params: [], expect: [
        { cmd: numerics.ERR_NOSUCHSERVER, ending: true },
        { cmd: numerics.RPL_WHOISUSER, ending: false },
        { cmd: numerics.RPL_WHOISCHANNELS, ending: false },
        { cmd: numerics.RPL_AWAY, ending: false },
        { cmd: numerics.RPL_WHOISIDLE, ending: false },
        { cmd: numerics.RPL_ENDOFWHOIS, ending: false },
        { cmd: numerics.ERR_NONICKNAMEGIVEN, ending: true },
        { cmd: numerics.RPL_WHOISCHANNELS, ending: false },
        { cmd: numerics.RPL_WHOISSERVER, ending: false },
        { cmd: numerics.RPL_WHOISOPERATOR, ending: false },
        { cmd: numerics.ERR_NOSUCHNICK, ending: true },
    ]},
    { cmd: 'WHOWAS', params: [], expect: [
        { cmd: numerics.ERR_NONICKNAMEGIVEN, ending: true },
        { cmd: numerics.RPL_WHOWASUSER, ending: false },
        { cmd: numerics.RPL_ENDOFWHOWAS, ending: true },
        { cmd: numerics.ERR_WASNOSUCHNICK, ending: true },
        { cmd: numerics.RPL_WHOISSERVER, ending: false },
    ]},
    { cmd: 'LIST', params: [], expect: [
        { cmd: numerics.ERR_TOOMANYMATCHES, ending: true },
        { cmd: numerics.RPL_LIST, ending: false },
        { cmd: numerics.ERR_NOSUCHSERVER, ending: true },
        { cmd: numerics.RPL_LISTEND, ending: true },
    ]},
    { cmd: 'MOTD', params: [], expect: [
        { cmd: numerics.RPL_MOTDSTART, ending: false },
        { cmd: numerics.RPL_ENDOFMOTD, ending: true },
        { cmd: numerics.RPL_MOTD, ending: false },
        { cmd: numerics.ERR_NOMOTD, ending: true },
    ]},
];

module.exports.expectedReplies = function expectedReplies(msg) {
    let command = msg.command.toUpperCase();

    let route = routes.find(route => {
        if (route.cmd !== command) {
            return false;
        }

        let matchParams = route.params;

        let paramsMatch = true;
        for (let i = 0; i < matchParams.length; i++) {
            // Empty string = any param value
            if (matchParams[i] === '') {
                continue;
            }

            if (matchParams[i] !== msg.params[i]) {
                paramsMatch = false;
                break;
            }
        }
        if (!paramsMatch) {
            return false;
        }

        return true;
    });

    return route ?
        route.expect :
        null;
};
