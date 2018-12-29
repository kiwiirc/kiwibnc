const { ConnectionState, Channel } = require('./connectionstate');

class ConnectionOutgoing {
    constructor(id, db, queue) {
        this.state = new ConnectionState(id, db);
        this.state.type = 0;
        this.queue = queue;
        this.map = null;
    }

    get id() {
        return this.state.conId;
    }

    trackInMap(map) {
        this.map = map;
        map.set(this.id, this);
    }

    destroy() {
        if (this.map) {
            this.map.delete(this.id);
        }

        this.state.destroy();
    }

    write(data) {
        this.queue.sendToSockets('connection.data', {id: this.id, data: data});
    }

    messageFromUpstream(message) {
        this.state.maybeLoad();

        if (message.command === '001') {
            l(message);
            this.state.nick = message.params[0];
            this.state.save();
        }

        // Keep track of our isupport tokens
        if (message.command === '005') {
            // Take these new tokens and add them to our existing recorded tokens
            let tokens = message.params.slice(1);
            tokens.pop();
            this.state.isupports = [...this.state.isupports, ...tokens];
        }

        if (message.command === 'PING') {
            this.write('PONG :' + message.params[0] + '\n');
        }

        if (message.command === 'JOIN' && message.prefix.nick === this.state.nick) {
            let chanName = message.params[0];
            let chan = null;
            if (!this.state.channels[chanName]) {
                chan = this.state.channels[chanName] = new Channel(chanName);
            }

            chan.joined = true;
            this.state.save();
        }
    }

    onUpstreamConnected() {
        this.state.isupports = [];

        this.write('USER myuser myuser myuser myuser\n');
        this.write('NICK myuser\n');
    }

    onUpstreamClosed() {
        this.state.connected = false;
        for (let chanName in this.state.channels) {
            this.state.channels[chanName].joined = false;
        }

        // TODO: this connection object should be kept around. only destroy
        // when the user deletes the connection
        this.destroy();
    }
}

module.exports = ConnectionOutgoing;
