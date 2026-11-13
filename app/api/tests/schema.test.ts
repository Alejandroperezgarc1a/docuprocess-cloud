import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { parseSchemaStatements } from '../src/db.js';

const SCHEMA_URL = new URL('../schema.sql', import.meta.url);

describe('schema', () => {
  it('tiene la tabla y columnas del contrato', async () => {
    const text = await readFile(SCHEMA_URL, 'utf8');

    assert.match(text, /CREATE TABLE IF NOT EXISTS users/);
    assert.match(text, /id INT NOT NULL AUTO_INCREMENT/);
    assert.match(text, /email VARCHAR\(255\) NOT NULL/);
    assert.match(text, /password_hash VARCHAR\(255\) NOT NULL/);
    assert.match(text, /created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP/);
    assert.match(text, /UNIQUE KEY uq_users_email \(email\)/);
    assert.match(text, /role VARCHAR\(16\) NOT NULL DEFAULT 'user'/);
    assert.match(text, /CREATE TABLE IF NOT EXISTS revoked_tokens/);
    assert.match(text, /jti VARCHAR\(64\) NOT NULL/);
  });

  it('se divide en dos sentencias (users y revoked_tokens)', async () => {
    const raw = await readFile(SCHEMA_URL, 'utf8');
    const statements = parseSchemaStatements(raw);

    assert.equal(statements.length, 2);
    assert.ok(statements[0]?.startsWith('CREATE TABLE IF NOT EXISTS users'));
    assert.ok(statements[0]?.includes('role VARCHAR(16) NOT NULL DEFAULT'));
    assert.ok(statements[1]?.startsWith('CREATE TABLE IF NOT EXISTS revoked_tokens'));
    assert.ok(statements[1]?.includes('jti VARCHAR(64) NOT NULL'));
  });
});
