'use strict';

const DatabaseSavable = require('../../src/libs/dataModels/databasesavable');

describe('database savable models', () => {
    class TestSavable extends DatabaseSavable {}
    TestSavable.table = 'users';

    function createInsertDb(client, insertResult, returningResult = [{ id: 777 }]) {
        const returning = jest.fn().mockResolvedValue(returningResult);
        const insertQuery = Promise.resolve(insertResult);
        insertQuery.returning = returning;
        const insert = jest.fn(() => insertQuery);
        const dbUsers = jest.fn(() => ({ insert }));
        dbUsers.client = { config: { client } };

        return {
            db: { dbUsers },
            insert,
            returning,
        };
    }

    test('normalizes inserted ids returned by sqlite and other knex clients', () => {
        expect(DatabaseSavable.normalizeInsertedId([{ id: 5230 }])).toBe(5230);
        expect(DatabaseSavable.normalizeInsertedId([5230])).toBe(5230);
        expect(DatabaseSavable.normalizeInsertedId(5230)).toBe(5230);
    });

    test('does not call returning for mysql inserts', async () => {
        const { db, insert, returning } = createInsertDb('mysql', [5230]);
        const model = new TestSavable(db);

        model.setData('username', 'testuser');
        await model.save();

        expect(insert).toHaveBeenCalledWith({ username: 'testuser' });
        expect(returning).not.toHaveBeenCalled();
        expect(model.getData('id')).toBe(5230);
    });

    test('does not call returning for mysql2 inserts', async () => {
        const { db, returning } = createInsertDb('mysql2', [5230]);
        const model = new TestSavable(db);

        model.setData('username', 'testuser');
        await model.save();

        expect(returning).not.toHaveBeenCalled();
        expect(model.getData('id')).toBe(5230);
    });

    test('keeps returning for clients that support insert returning ids', async () => {
        const { db, returning } = createInsertDb('pg', [999], [{ id: 5230 }]);
        const model = new TestSavable(db);

        model.setData('username', 'testuser');
        await model.save();

        expect(returning).toHaveBeenCalledWith('id');
        expect(model.getData('id')).toBe(5230);
    });
});
