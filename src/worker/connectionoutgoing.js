const uuidv4 = require('uuid/v4');
const { ConnectionState, Channel } = require('./connectionstate');

// Upstream commands can be hot reloaded as they contain no state
let UpstreamCommands = null;

function hotReloadUpstreamCommands() {
    delete require.cache[require.resolve('./upstreamcommands')];
    UpstreamCommands = require('./upstreamcommands');
}

hotReloadUpstreamCommands();

class ConnectionOutgoing {
    constructor(_id, db, messages, queue) {
        let id = _id || uuidv4();
        this.state = new ConnectionState(id, db);
        this.state.type = 0;
        this.messages = messages;
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

    close() {
        this.queue.sendToSockets('connection.close', {
            id: this.id,
        });
    }

    write(data) {
        this.queue.sendToSockets('connection.data', {id: this.id, data: data});
    }

    async forEachClient(fn, excludeCon) {
        this.state.linkedIncomingConIds.forEach(async (conId) => {
            let clientCon = this.map.get(conId);
            if (clientCon && clientCon !== excludeCon) {
                await fn(clientCon);
            }
        });
    }

    async messageFromUpstream(message, raw) {
        this.state.maybeLoad();

        let passDownstream = await UpstreamCommands.run(message, this);
        if (passDownstream !== false) {
            // Send this data down to any linked clients
            this.forEachClient((client) => {
                client.state.netRegistered && client.write(raw + '\n');
            });
        }
    }

    onUpstreamConnected() {
        // Reset some state. They will be re-populated when upstream sends its registration burst again
        this.state.connected = true;
        this.state.isupports = [];
        this.state.registrationLines = [];
        this.state.save();

        if (this.state.password) {
            this.write(`PASS ${this.state.password}\n`);
        }
        this.write(`NICK ${this.state.nick}\n`);
        this.write(`USER ${this.state.username} * * ${this.state.realname}\n`);

        this.forEachClient((client) => {
            client.writeStatus('Network connected!');
        });
    }

    onUpstreamClosed() {
        this.state.connected = false;
        this.state.netRegistered = false;
        for (let chanName in this.state.channels) {
            this.state.channels[chanName].joined = false;
        }

        this.forEachClient((client) => {
            client.writeStatus('Network disconnected');
        });

        // TODO: this connection object should be kept around. only destroy
        // when the user deletes the connection
        this.destroy();
    }
}

module.exports = ConnectionOutgoing;
