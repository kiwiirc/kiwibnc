class BncError extends Error {
    constructor(name, code, message) {
        super(message);
        this.name = name;
        this.code = code || name;
        Error.captureStackTrace(this, this.constructor);
    }
}

module.exports.BncError = BncError;
