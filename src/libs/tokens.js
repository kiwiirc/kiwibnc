const { v4: uuidv4 } = require('uuid');

// Different tokens have different prefixes so that we can more easily determine what type of token
// it is. eg. __t1<token> = a user auth token while __t2<token> is a token specific to a network
module.exports.generateUserToken = function generateUserToken() {
    return '__t1' + uuidv4().replace(/\-/g, '');
};

module.exports.isUserToken = function isUserToken(token) {
    return token.indexOf('__t1') === 0;
};
