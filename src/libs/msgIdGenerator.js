module.exports.add = function add(msg) {
    if (!msg.tags.msgid) {
        msg.tags.msgid = generateId();
    }
}

module.exports.generateId = function generateId() {
    return Date.now().toString(36) + (Math.random() * 10e17).toString(36).substr(0, 4);
}
