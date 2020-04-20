const MessageStoreSqlite = require('./sqlite');
const MessageStoreFlatfile = require('./flatfile');

class MessageStores {
    constructor(config) {
        this.conf = config;
        this.stores = [];
    }

    async init() {
        if (this.conf.get('logging.database')) {
            let m = new MessageStoreSqlite(this.conf);
            await m.init();
            this.stores.push(m);
        }
        if (this.conf.get('logging.files')) {
            let m = new MessageStoreFlatfile(this.conf);
            await m.init();
            this.stores.push(m);
        }
    }

    async getMessagesFromMsgId(...args) {
        let readable = this.stores.find(s => s.supportsRead);
        if (!readable) {
            return [];
        }

        return await readable.getMessagesFromMsgId(...args);
    }

    async getMessagesFromTime(...args) {
        let readable = this.stores.find(s => s.supportsRead);
        if (!readable) {
            return [];
        }

        return await readable.getMessagesFromTime(...args);
    }

    async getMessagesBeforeMsgId(...args) {
        let readable = this.stores.find(s => s.supportsRead);
        if (!readable) {
            return [];
        }

        return await readable.getMessagesBeforeMsgId(...args);
    }

    async getMessagesBeforeTime(...args) {
        let readable = this.stores.find(s => s.supportsRead);
        if (!readable) {
            return [];
        }

        return await readable.getMessagesBeforeTime(...args);
    }

    async getMessagesBetween(...args) {
        let readable = this.stores.find(s => s.supportsRead);
        if (!readable) {
            return [];
        }

        return await readable.getMessagesBetween(...args);
    }

    async storeMessage(...args) {
        this.stores.filter(s => s.supportsWrite).forEach(async store => {
            await store.storeMessage(...args);
        });
    }
}

module.exports = MessageStores;
