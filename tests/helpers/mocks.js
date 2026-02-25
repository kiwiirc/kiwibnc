'use strict';

/**
 * Test mock factories for KiwiBNC unit tests
 */

/**
 * Create a mock IrcMessage object
 * @param {string} command - IRC command (e.g., 'JOIN', 'PRIVMSG')
 * @param {string[]} params - Message parameters
 * @param {Object} options - Additional options (tags, prefix, nick, ident, hostname)
 */
function createMockMessage(command, params = [], options = {}) {
    return {
        command: command || '',
        params: [...params],
        tags: { ...options.tags },
        prefix: options.prefix || 'nick!user@host',
        nick: options.nick || 'nick',
        ident: options.ident || 'user',
        hostname: options.hostname || 'host',
        to1459: function() {
            const parts = [];

            // Encode tags
            const tagParts = [];
            for (const key in this.tags) {
                if (this.tags[key] === true || this.tags[key] === '') {
                    tagParts.push(key);
                } else if (this.tags[key]) {
                    tagParts.push(`${key}=${this.tags[key]}`);
                }
            }
            if (tagParts.length > 0) {
                parts.push('@' + tagParts.join(';'));
            }

            if (this.prefix) {
                parts.push(':' + this.prefix);
            }
            parts.push(this.command);
            if (this.params.length > 0) {
                this.params.forEach((param, idx) => {
                    if (idx === this.params.length - 1 && (param.indexOf(' ') > -1 || param[0] === ':')) {
                        parts.push(':' + param);
                    } else {
                        parts.push(param);
                    }
                });
            }
            return parts.join(' ');
        }
    };
}

/**
 * Create a mock ConnectionState object
 * @param {string[]} caps - Array of capability names the client has enabled
 * @param {Object} options - Additional state options
 */
function createMockState(caps = [], options = {}) {
    const state = {
        caps: new Set(caps),
        nick: options.nick || 'testnick',
        netRegistered: options.netRegistered !== undefined ? options.netRegistered : true,
        tempData: { ...options.tempData },
        _dirty: false,
        _saveTimer: null,
        conId: options.conId || 'test-con-id',
        isupports: options.isupports || ['PREFIX=(qaohv)~&@%+'],
        serverPrefix: options.serverPrefix || 'irc.test.server',
        tempGet: jest.fn(function(key) {
            return this.tempData[key];
        }),
        tempSet: jest.fn(function(key, val) {
            if (typeof key === 'string') {
                if (val === null) {
                    delete this.tempData[key];
                } else {
                    this.tempData[key] = val;
                }
            } else if (typeof key === 'object') {
                for (let prop in key) {
                    if (key[prop] === null) {
                        delete this.tempData[prop];
                    } else {
                        this.tempData[prop] = key[prop];
                    }
                }
            }
            this._dirty = true;
        }),
        markDirty: jest.fn(function() {
            this._dirty = true;
        }),
        save: jest.fn().mockResolvedValue(undefined)
    };

    // Bind methods to state object
    state.tempGet = state.tempGet.bind(state);
    state.tempSet = state.tempSet.bind(state);
    state.markDirty = state.markDirty.bind(state);

    return state;
}

/**
 * Create a mock client (incoming) connection
 * @param {string} id - Connection ID
 * @param {string[]} caps - Array of capability names the client has enabled
 * @param {Object} options - Additional options
 */
function createMockClient(id, caps = [], options = {}) {
    const client = {
        id: id || 'client-1',
        state: createMockState(caps, { conId: id, ...options }),
        upstream: options.upstream || null,
        write: jest.fn(),
        writeMsg: jest.fn(),
        writeMsgFast: jest.fn(),
        writeMsgFrom: jest.fn()
    };

    return client;
}

/**
 * Create a mock upstream (outgoing) connection
 * @param {Object} options - Additional options
 */
function createMockUpstream(options = {}) {
    const upstream = {
        id: options.id || 'upstream-1',
        state: createMockState(
            options.caps || ['extended-join', 'multi-prefix', 'userhost-in-names'],
            {
                conId: options.id || 'upstream-1',
                isupports: options.isupports || ['PREFIX=(qaohv)~&@%+'],
                serverPrefix: options.serverPrefix || 'irc.test.server',
                ...options.stateOptions
            }
        ),
        whoClientQueue: [],
        conDict: new Map(),
        write: jest.fn(),
        writeLine: jest.fn()
    };

    return upstream;
}

/**
 * Create a mock event emitter for hooks
 */
function createMockEventEmitter() {
    const listeners = {};

    return {
        on: jest.fn((event, handler) => {
            if (!listeners[event]) {
                listeners[event] = [];
            }
            listeners[event].push(handler);
        }),
        emit: jest.fn(async (event, data) => {
            const eventObj = {
                event: data,
                prevented: false,
                preventDefault: function() {
                    this.prevented = true;
                }
            };

            if (listeners[event]) {
                for (const handler of listeners[event]) {
                    await handler(eventObj.event);
                    if (eventObj.event.preventDefault) {
                        // Check if preventDefault was called on the event itself
                    }
                }
            }

            return {
                prevent: eventObj.prevented,
                event: eventObj.event
            };
        }),
        _listeners: listeners
    };
}

/**
 * Create a mock reply route entry for replyrouter tests
 * @param {Object} options - Route options
 */
function createMockReplyRoute(options = {}) {
    return {
        replies: options.replies || [
            { cmd: 'WHO', ending: false },
            { cmd: '315', ending: true }
        ],
        source: options.source || 'client-1',
        added: options.added || Date.now()
    };
}

module.exports = {
    createMockMessage,
    createMockState,
    createMockClient,
    createMockUpstream,
    createMockEventEmitter,
    createMockReplyRoute
};
