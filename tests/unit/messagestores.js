jest.mock('../../src/worker/messagestores/sqlite', () => jest.fn().mockImplementation(() => ({
    supportsRead: true,
    supportsWrite: true,
    init: jest.fn(async () => {}),
    getMessagesBetween: jest.fn(async () => ['sqlite']),
    storeMessage: jest.fn(async () => {}),
})));

jest.mock('../../src/worker/messagestores/flatfile', () => jest.fn().mockImplementation(() => ({
    supportsRead: false,
    supportsWrite: true,
    init: jest.fn(async () => {}),
    storeMessage: jest.fn(async () => {}),
})));

jest.mock('/virtual/custom-message-store.js', () => jest.fn().mockImplementation(() => ({
    supportsRead: true,
    supportsWrite: true,
    init: jest.fn(async () => {}),
    getMessagesBetween: jest.fn(async () => ['custom']),
    storeMessage: jest.fn(async () => {}),
})), { virtual: true });

const MessageStores = require('../../src/worker/messagestores/');

describe('MessageStores', () => {
    function buildConfig() {
        return {
            get: jest.fn((key) => {
                if (key === 'logging.database') {
                    return './messages.db';
                }
                if (key === 'logging.files') {
                    return '';
                }
                if (key === 'logging.custom') {
                    return '/virtual/custom-message-store.js';
                }
                return '';
            }),
            relativePath: jest.fn((path) => path),
        };
    }

    test('uses custom readable message store before sqlite for history reads', async () => {
        const stores = new MessageStores(buildConfig());

        await stores.init();

        await expect(stores.getMessagesBetween(1, 2, '#test', {}, {}, 10)).resolves.toEqual(['custom']);
    });
});
