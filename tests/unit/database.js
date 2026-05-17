'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('../../src/libs/database');

function createConfig(database, baseDir = '', configuredDatabase = undefined) {
    const config = {
        get(key, def) {
            if (key === 'database') {
                return database;
            }
            return def;
        },
        relativePath(filePath) {
            if (filePath[0] === '/') {
                return filePath;
            }
            return path.join(baseDir, filePath);
        },
    };
    if (typeof configuredDatabase !== 'undefined') {
        config.c = { database: configuredDatabase };
    }
    return config;
}

describe('database stale sqlite users retirement', () => {
    let tmpDirs = [];
    let warnSpy;

    beforeEach(() => {
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();

        tmpDirs.forEach((tmpDir) => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });
        tmpDirs = [];
    });

    function makeTmpDir() {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwibnc-db-'));
        tmpDirs.push(tmpDir);
        return tmpDir;
    }

    async function closeDb(db) {
        await db.dbUsers.destroy();
        await db.dbConnections.destroy();
    }

    function retiredFiles(tmpDir, filename = 'users.db') {
        return fs.readdirSync(tmpDir)
            .filter((entry) => entry.startsWith(`${filename}.retired-`) && entry.endsWith('.bak'));
    }

    async function runSuccessfulMigrations(db) {
        db.migrateConnections = jest.fn().mockResolvedValue([]);
        db.migrateUsers = jest.fn().mockResolvedValue([]);
        await db.init();
    }

    test('archives stale users.db after effective mysql config succeeds', async () => {
        const tmpDir = makeTmpDir();
        const usersDb = path.join(tmpDir, 'users.db');
        fs.writeFileSync(usersDb, 'stale user data');

        const db = new Database(createConfig(
            { users: 'mysql://kiwibnc:secret@db.example:3306/kiwibnc' },
            tmpDir,
            { users: './users.db' }
        ));
        await runSuccessfulMigrations(db);
        await closeDb(db);

        const archived = retiredFiles(tmpDir);
        expect(fs.existsSync(usersDb)).toBe(false);
        expect(archived).toHaveLength(1);
        expect(fs.readFileSync(path.join(tmpDir, archived[0]), 'utf8')).toBe('stale user data');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Retired stale SQLite users database'));
    });

    test('does not archive stale users.db before mysql migrations succeed', async () => {
        const tmpDir = makeTmpDir();
        const usersDb = path.join(tmpDir, 'users.db');
        fs.writeFileSync(usersDb, 'must survive failed mysql startup');

        const db = new Database(createConfig(
            { users: 'mysql://kiwibnc:secret@db.example:3306/kiwibnc' },
            tmpDir,
            { users: './users.db' }
        ));
        db.migrateConnections = jest.fn().mockResolvedValue([]);
        db.migrateUsers = jest.fn().mockRejectedValue(new Error('mysql unavailable'));

        await expect(db.init()).rejects.toThrow('mysql unavailable');
        await closeDb(db);

        expect(fs.existsSync(usersDb)).toBe(true);
        expect(fs.readFileSync(usersDb, 'utf8')).toBe('must survive failed mysql startup');
        expect(retiredFiles(tmpDir)).toHaveLength(0);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    test('archives configured non-default sqlite users path after effective mysql config succeeds', async () => {
        const tmpDir = makeTmpDir();
        const defaultUsersDb = path.join(tmpDir, 'users.db');
        const configuredUsersDb = path.join(tmpDir, 'staging-users.db');
        fs.writeFileSync(defaultUsersDb, 'unrelated default sqlite file');
        fs.writeFileSync(configuredUsersDb, 'configured sqlite user data');

        const db = new Database(createConfig(
            { users: 'mysql://kiwibnc:secret@db.example:3306/kiwibnc' },
            tmpDir,
            { users: './staging-users.db' }
        ));
        await runSuccessfulMigrations(db);
        await closeDb(db);

        const archived = retiredFiles(tmpDir, 'staging-users.db');
        expect(fs.existsSync(defaultUsersDb)).toBe(true);
        expect(fs.readFileSync(defaultUsersDb, 'utf8')).toBe('unrelated default sqlite file');
        expect(fs.existsSync(configuredUsersDb)).toBe(false);
        expect(archived).toHaveLength(1);
        expect(fs.readFileSync(path.join(tmpDir, archived[0]), 'utf8')).toBe('configured sqlite user data');
    });

    test('does not archive users.db for direct mysql config without prior sqlite path', async () => {
        const tmpDir = makeTmpDir();
        const usersDb = path.join(tmpDir, 'users.db');
        fs.writeFileSync(usersDb, 'stale user data');

        const db = new Database(createConfig({
            users: 'mysql://kiwibnc:secret@db.example:3306/kiwibnc',
        }, tmpDir));
        await runSuccessfulMigrations(db);
        await closeDb(db);

        expect(fs.existsSync(usersDb)).toBe(true);
        expect(retiredFiles(tmpDir)).toHaveLength(0);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    test('leaves users.db untouched when users database is sqlite', async () => {
        const tmpDir = makeTmpDir();
        const usersDb = path.join(tmpDir, 'users.db');
        fs.writeFileSync(usersDb, 'active sqlite user data');

        const db = new Database(createConfig({
            users: './users.db',
        }, tmpDir));
        await runSuccessfulMigrations(db);
        await closeDb(db);

        expect(fs.existsSync(usersDb)).toBe(true);
        expect(fs.readFileSync(usersDb, 'utf8')).toBe('active sqlite user data');
        expect(retiredFiles(tmpDir)).toHaveLength(0);
        expect(warnSpy).not.toHaveBeenCalled();
    });
});
