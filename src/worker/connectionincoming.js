const { ConnectionState } = require('./connectionstate');

class ConnectionIncoming {
    constructor(id, db, queue) {
        this.state = new ConnectionState(id, db);
        this.state.type = 1;
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

    async messageFromClient(message) {
        this.state.maybeLoad();

        // Keep track of our isupport tokens
        if (message.command === 'NICK') {
            this.state.nick = message.params[0];
            this.state.save();
            this.write(`:${this.state.nick} NICK ${this.state.nick}\n`);
        }

        if (message.command === 'PING') {
            this.write('PONG :' + message.params[0] + '\n');
        }

        if (message.command === 'STATE') {
            this.write(':bnc NOTICE * :You are ' + this.state.nick + '\n');
        }

        // TODO: Remove this kill code!
        if (message.command === 'KILL') {
            this.queue.stopListening().then(process.exit);
        }
    }

    onAccepted() {
        this.write(`:bnc NOTICE ${this.state.nick} :Welcome to BNC!\n`);
    }

    onClientClosed() {
        this.destroy();
    }
}

module.exports = ConnectionIncoming;
