const ReplyRouter = require('./routes');

module.exports.init = function init(hooks) {
    hooks.on('message_to_clients', event => {
        let command = event.message.command.toUpperCase();
        let clientsExpectingMsg = [];
    
        // Populate clientsExpectingMsg with clients expecting this command
        event.clients.forEach(client => {
            let expecting = client.state.tempGet('expecting_replies') || [];
    
            for (let i = 0; i < expecting.length; i++) {
                if (expecting[i].replies.find(reply => reply.cmd === command)) {
                    clientsExpectingMsg.push(client);
                }
            } 
        });
    
        if (clientsExpectingMsg.length === 0) {
            // No specific clients are expecting this message so just let the message
            // go to them all
            return;
        }
    
        event.clients = clientsExpectingMsg;
        l.debug('Client was expecting this command,', command);
    
        // If this message is expected to be the last of its group, mark the client
        // as no longer expecting these type of messages again
        event.clients.forEach(client => {
            let expecting = client.state.tempGet('expecting_replies') || [];
            expecting.forEach((route, idx) => {
                let replies = route.replies;
                let isEnding = replies.find(reply => reply.cmd === command && reply.ending);
                if (isEnding) {
                    expecting.splice(idx, 1);
                }
            });
    
            client.state.tempSet('expecting_replies', expecting.length > 0 ? expecting : null);
        });
    });
    
    hooks.on('message_from_client', event => {
        let client = event.client;
        let msg = event.message;
    
        let expectReplies = ReplyRouter.expectedReplies(msg);
        if (!expectReplies) {
            return;
        }
    
        let expecting = client.state.tempGet('expecting_replies') || [];
        expecting.push({command: msg.command.toUpperCase(), replies: expectReplies, added: Date.now()});
        l.debug('Client now expecting one of', expectReplies.map(r=>r.cmd).join(' '));
        client.state.tempSet('expecting_replies', expecting);
    });
}
