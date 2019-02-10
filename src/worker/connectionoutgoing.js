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
    constructor(_id, db, messages, queue, conDict) {
        let id = _id || uuidv4();
        this.state = new ConnectionState(id, db);
        this.state.type = 0;
        this.messages = messages;
        this.queue = queue;
        this.conDict = conDict;

        this.conDict.set(id, this);
    }

    get id() {
        return this.state.conId;
    }

    destroy() {
        this.conDict.delete(this.id);
        this.state.destroy();
    }

    close() {
        this.queue.sendToSockets('connection.close', {
            id: this.id,
        });
    }

    open() {
        this.queue.sendToSockets('connection.open', {
            host: this.state.host,
            port: this.state.port,
            tls: this.state.tls,
            id: this.id,
        });
    }

    write(data) {
        this.queue.sendToSockets('connection.data', {id: this.id, data: data});
    }

    writeLine(...params) {
        // If the last param contains a space, turn it into a trailing param
        let lastParam = params[params.length - 1];
        if (params.length > 1 && (lastParam[0] === ':' || lastParam.indexOf(' ') > -1)) {
            params[params.length - 1] = ':' + params[params.length - 1];
        }
        this.write(params.join(' ') + '\r\n');
    }

    async forEachClient(fn, excludeCon) {
        this.state.linkedIncomingConIds.forEach(async (conId) => {
            let clientCon = this.conDict.get(conId);
            if (clientCon && clientCon !== excludeCon) {
                await fn(clientCon);
            }
        });
    }

    async messageFromUpstream(message, raw) {
        await this.state.maybeLoad();

        let passDownstream = await UpstreamCommands.run(message, this);
        if (passDownstream !== false) {
            // Send this data down to any linked clients
            this.forEachClient((client) => {
                client.state.netRegistered && client.writeMsg(message);
            });
        }
    }

    onUpstreamConnected() {
        // Reset some state. They will be re-populated when upstream sends its registration burst again
        this.state.connected = true;
        this.state.netRegistered = false;
        this.state.isupports = [];
        this.state.registrationLines = [];
        this.state.save();

        this.writeLine('CAP LS');

        if (this.state.password) {
            this.writeLine(`PASS ${this.state.password}`);
        }
        this.writeLine(`NICK ${this.state.nick}`);
        this.writeLine(`USER ${this.state.username} * * ${this.state.realname}`);

        this.forEachClient((client) => {
            client.writeStatus('Network connected!');
        });
    }

    async onUpstreamClosed() {
        this.state.connected = false;

        for (let chanName in this.state.channels) {
            this.state.channels[chanName].joined = false;
        }

        await this.state.save();

        this.forEachClient((client) => {
            client.writeStatus('Network disconnected');
        });
    }
}

module.exports = ConnectionOutgoing;
