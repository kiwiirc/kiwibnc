module.exports.add = add;
function add(msg) {
    if (!msg.tags.msgid) {
        msg.tags.msgid = generateId();
    }
};

module.exports.generateId = generateId;
function generateId() {
    let base36Date = Date.now().toString(36);
    return 'kb_' + base36Date + Math.floor((Math.random() * 100000)).toString(36);
};
