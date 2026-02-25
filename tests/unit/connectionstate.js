'use strict';

/**
 * Tests for ConnectionState debouncing behavior in src/worker/connectionstate.js
 *
 * These tests verify that:
 * 1. markDirty() batches multiple calls into a single save
 * 2. The debounce delay is 1000ms
 * 3. tempSet() updates data immediately but uses markDirty() for persistence
 */

describe('markDirty debouncing', () => {
    let ConnectionState;
    let mockDb;

    beforeEach(() => {
        jest.useFakeTimers();

        // Suppress logging
        global.l = { debug: jest.fn(), info: jest.fn() };

        // Mock database
        mockDb = {
            dbConnections: jest.fn().mockReturnThis(),
            raw: jest.fn().mockResolvedValue(undefined)
        };

        // Clear module cache
        delete require.cache[require.resolve('../../src/worker/connectionstate')];
        const module = require('../../src/worker/connectionstate');
        ConnectionState = module.ConnectionState;
    });

    afterEach(() => {
        jest.useRealTimers();
        delete global.l;
    });

    it('should batch multiple markDirty calls into single save', async () => {
        const state = new ConnectionState('test-id', mockDb);
        state.loaded = true;

        // Spy on save method
        const saveSpy = jest.spyOn(state, 'save').mockResolvedValue(undefined);

        // Call markDirty 10 times rapidly
        for (let i = 0; i < 10; i++) {
            state.markDirty();
        }

        // Timer should be set
        expect(state._saveTimer).not.toBeNull();
        expect(state._dirty).toBe(true);

        // Save should not have been called yet
        expect(saveSpy).not.toHaveBeenCalled();

        // Advance timer by 1000ms
        jest.advanceTimersByTime(1000);

        // Now save should have been called exactly once
        expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    it('should delay save by 1000ms from first markDirty call', async () => {
        const state = new ConnectionState('test-id', mockDb);
        state.loaded = true;

        const saveSpy = jest.spyOn(state, 'save').mockResolvedValue(undefined);

        state.markDirty();

        // Advance by 500ms - should not save yet
        jest.advanceTimersByTime(500);
        expect(saveSpy).not.toHaveBeenCalled();

        // Call markDirty again
        state.markDirty();

        // Advance by another 400ms (total 900ms from first call) - still no save
        jest.advanceTimersByTime(400);
        expect(saveSpy).not.toHaveBeenCalled();

        // Advance by 100ms more (total 1000ms from first call) - now save
        jest.advanceTimersByTime(100);
        expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    it('should clear _dirty and _saveTimer after save completes', async () => {
        const state = new ConnectionState('test-id', mockDb);
        state.loaded = true;

        jest.spyOn(state, 'save').mockResolvedValue(undefined);

        state.markDirty();
        expect(state._dirty).toBe(true);
        expect(state._saveTimer).not.toBeNull();

        // Advance timer to trigger save
        jest.advanceTimersByTime(1000);

        // After save, flags should be cleared
        expect(state._dirty).toBe(false);
        expect(state._saveTimer).toBeNull();
    });

    it('should allow new timer after previous save completes', async () => {
        const state = new ConnectionState('test-id', mockDb);
        state.loaded = true;

        const saveSpy = jest.spyOn(state, 'save').mockResolvedValue(undefined);

        // First batch
        state.markDirty();
        jest.advanceTimersByTime(1000);
        expect(saveSpy).toHaveBeenCalledTimes(1);

        // Second batch
        state.markDirty();
        expect(state._saveTimer).not.toBeNull();
        jest.advanceTimersByTime(1000);
        expect(saveSpy).toHaveBeenCalledTimes(2);
    });

    it('should not create multiple timers when markDirty called multiple times', async () => {
        const state = new ConnectionState('test-id', mockDb);
        state.loaded = true;

        jest.spyOn(state, 'save').mockResolvedValue(undefined);

        state.markDirty();
        const firstTimer = state._saveTimer;

        state.markDirty();
        state.markDirty();

        // Should still be the same timer
        expect(state._saveTimer).toBe(firstTimer);
    });
});

describe('tempSet behavior', () => {
    let ConnectionState;
    let mockDb;

    beforeEach(() => {
        jest.useFakeTimers();

        global.l = { debug: jest.fn(), info: jest.fn() };

        mockDb = {
            dbConnections: jest.fn().mockReturnThis(),
            raw: jest.fn().mockResolvedValue(undefined)
        };

        delete require.cache[require.resolve('../../src/worker/connectionstate')];
        const module = require('../../src/worker/connectionstate');
        ConnectionState = module.ConnectionState;
    });

    afterEach(() => {
        jest.useRealTimers();
        delete global.l;
    });

    it('should update tempData immediately without waiting for save', () => {
        const state = new ConnectionState('test-id', mockDb);

        state.tempSet('mykey', 'myvalue');

        // Data should be available immediately
        expect(state.tempGet('mykey')).toBe('myvalue');
        expect(state.tempData['mykey']).toBe('myvalue');
    });

    it('should delete key when value is null', () => {
        const state = new ConnectionState('test-id', mockDb);

        state.tempSet('mykey', 'myvalue');
        expect(state.tempGet('mykey')).toBe('myvalue');

        state.tempSet('mykey', null);
        expect(state.tempGet('mykey')).toBeUndefined();
        expect('mykey' in state.tempData).toBe(false);
    });

    it('should handle object parameter for multiple keys', () => {
        const state = new ConnectionState('test-id', mockDb);

        state.tempSet({
            key1: 'value1',
            key2: 'value2',
            key3: 'value3'
        });

        expect(state.tempGet('key1')).toBe('value1');
        expect(state.tempGet('key2')).toBe('value2');
        expect(state.tempGet('key3')).toBe('value3');
    });

    it('should handle object parameter with null values for deletion', () => {
        const state = new ConnectionState('test-id', mockDb);

        state.tempSet('keep', 'kept');
        state.tempSet('delete1', 'value1');
        state.tempSet('delete2', 'value2');

        state.tempSet({
            delete1: null,
            delete2: null
        });

        expect(state.tempGet('keep')).toBe('kept');
        expect(state.tempGet('delete1')).toBeUndefined();
        expect(state.tempGet('delete2')).toBeUndefined();
    });

    it('should trigger markDirty on every call', () => {
        const state = new ConnectionState('test-id', mockDb);

        const markDirtySpy = jest.spyOn(state, 'markDirty');

        state.tempSet('key1', 'value1');
        expect(markDirtySpy).toHaveBeenCalledTimes(1);

        state.tempSet('key2', 'value2');
        expect(markDirtySpy).toHaveBeenCalledTimes(2);

        state.tempSet({ key3: 'value3' });
        expect(markDirtySpy).toHaveBeenCalledTimes(3);
    });
});

describe('getOrAddBuffer', () => {
    let ConnectionState;
    let mockDb;

    beforeEach(() => {
        jest.useFakeTimers();

        global.l = { debug: jest.fn(), info: jest.fn() };

        mockDb = {
            dbConnections: jest.fn().mockReturnThis(),
            raw: jest.fn().mockResolvedValue(undefined)
        };

        delete require.cache[require.resolve('../../src/worker/connectionstate')];
        const module = require('../../src/worker/connectionstate');
        ConnectionState = module.ConnectionState;
    });

    afterEach(() => {
        jest.useRealTimers();
        delete global.l;
    });

    it('should trigger markDirty when adding a new buffer', () => {
        const state = new ConnectionState('test-id', mockDb);

        const markDirtySpy = jest.spyOn(state, 'markDirty');

        state.getOrAddBuffer('#newchannel');

        expect(markDirtySpy).toHaveBeenCalled();
    });

    it('should preserve original nick case when reconstructed via fromObj', () => {
        const module = require('../../src/worker/connectionstate');
        const IrcBuffer = module.IrcBuffer;

        const obj = {
            name: '#test',
            joined: true,
            isChannel: true,
            users: {
                'jilles': { nick: 'Jilles', host: 'example.com', username: 'jilles', prefixes: ['@'] },
                'someone': { nick: 'SomeOne', host: 'example.com', username: 'someone', prefixes: [] },
            },
            modes: {},
        };
        const buffer = IrcBuffer.fromObj(obj);
        expect(buffer.users['jilles'].nick).toBe('Jilles');
        expect(buffer.users['someone'].nick).toBe('SomeOne');
    });

    it('should not trigger markDirty when buffer already exists', () => {
        const state = new ConnectionState('test-id', mockDb);

        // Add buffer first
        state.getOrAddBuffer('#existingchannel');

        const markDirtySpy = jest.spyOn(state, 'markDirty');
        markDirtySpy.mockClear();

        // Get existing buffer
        state.getOrAddBuffer('#existingchannel');

        expect(markDirtySpy).not.toHaveBeenCalled();
    });
});
