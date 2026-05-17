'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Config = require('../../src/libs/config');

describe('config environment overrides', () => {
    const envKeys = [
        'BNC_DATABASE_CRYPT_KEY',
        'BNC_DATABASE_USERS',
        'BNC_DATABASE_TABLE_PREFIX',
        'BNC_PLUGIN_EXAMPLE_ENDPOINT',
        'BNC_PLUGIN_EXAMPLE_ENABLED',
    ];
    let originalEnv;

    beforeEach(() => {
        originalEnv = {};
        envKeys.forEach((key) => {
            originalEnv[key] = process.env[key];
            delete process.env[key];
        });
    });

    afterEach(() => {
        envKeys.forEach((key) => {
            if (typeof originalEnv[key] === 'undefined') {
                delete process.env[key];
            } else {
                process.env[key] = originalEnv[key];
            }
        });
    });

    test('applies nested BNC environment overrides to direct scalar reads', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwibnc-config-'));
        const configPath = path.join(tmpDir, 'config.ini');
        fs.writeFileSync(configPath, [
            '[database]',
            'users="./users.db"',
            'crypt_key="local-crypt-key"',
            'table_prefix=""',
            '',
        ].join('\n'));

        process.env.BNC_DATABASE_CRYPT_KEY = '12345678901234567890123456789012';
        process.env.BNC_DATABASE_USERS = 'mysql://kiwibnc:secret@db.example:3306/kiwibnc';
        process.env.BNC_DATABASE_TABLE_PREFIX = 'bnc_';

        const config = new Config(configPath);
        config.load();

        expect(config.get('database.crypt_key')).toBe('12345678901234567890123456789012');
        expect(config.get('database').users).toBe('mysql://kiwibnc:secret@db.example:3306/kiwibnc');
        expect(config.get('database').table_prefix).toBe('bnc_');
    });

    test('adds nested BNC environment overrides missing from config file', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwibnc-config-'));
        const configPath = path.join(tmpDir, 'config.ini');
        fs.writeFileSync(configPath, [
            '[database]',
            'users="./users.db"',
            'crypt_key="local-crypt-key"',
            '',
        ].join('\n'));

        process.env.BNC_DATABASE_TABLE_PREFIX = 'bnc_';

        const config = new Config(configPath);
        config.load();

        expect(config.get('database').table_prefix).toBe('bnc_');
    });

    test('allows env-only nested section config', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwibnc-config-'));
        const configPath = path.join(tmpDir, 'config.ini');
        fs.writeFileSync(configPath, [
            '[webserver]',
            'port=80',
            '',
        ].join('\n'));

        process.env.BNC_PLUGIN_EXAMPLE_ENDPOINT = 'https://example.test/api';
        process.env.BNC_PLUGIN_EXAMPLE_ENABLED = 'true';

        const config = new Config(configPath);
        config.load();

        expect(config.get('webserver').port).toBe(80);
        expect(config.get('plugin_example').endpoint).toBe('https://example.test/api');
        expect(config.get('plugin_example').enabled).toBe('true');
    });
});
