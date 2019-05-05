const crypto = require('crypto');

class Crypt {
    constructor(key) {
        this.setKey(key);
    }

    setKey(key) {
        this.key = new Buffer.from(key);
    }

    encrypt(data) {
        // AES uses length of 16
        let iv = crypto.randomBytes(16);
        let cipher = crypto.createCipheriv('aes-256-cbc', this.key, iv);
        let encrypted = cipher.update(data);
    
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        return iv.toString('hex') + ':' + encrypted.toString('hex');
    }

    decrypt(data) {
        let decrypted = '';
        try {
            let textParts = data.split(':');
            let iv = new Buffer.from(textParts.shift(), 'hex');
            let encryptedText = new Buffer.from(textParts.join(':'), 'hex');
            let decipher = crypto.createDecipheriv('aes-256-cbc', this.key, iv);
            decrypted = decipher.update(encryptedText);
            decrypted = Buffer.concat([decrypted, decipher.final()]);
            decrypted = decrypted.toString();
        } catch (err) {
            console.error('Error decrypting:', err);
            decrypted = '';
        }

        return decrypted;
    }
}

module.exports = Crypt;
