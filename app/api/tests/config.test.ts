/**
 * Config loading tests for DocuProcess Cloud: required env vars, defaults,
 * DDB_TRANSACTIONS parsing and CORS list handling.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

const BASE_ENV: Record<string, string> = {
  DOCS_BUCKET: 'test-docs-bucket',
  DDB_TABLE: 'documents',
  DDB_EVENTS_TABLE: 'document_events',
  DB_HOST: '127.0.0.1',
  DB_PORT: '3306',
  DB_NAME: 'docuprocess',
  DB_USER: 'docuadmin',
  DB_PASSWORD: 'test-password',
  JWT_SECRET: 'x'.repeat(32),
  AWS_REGION: 'us-east-1',
};

function envWithout(name: string): Record<string, string> {
  const env = { ...BASE_ENV };
  delete env[name];
  return env;
}

describe('config', () => {
  it('fails when a required variable is missing', () => {
    assert.throws(() => loadConfig(envWithout('DB_HOST')), /DB_HOST/);
  });

  it('fails when DDB_EVENTS_TABLE is missing', () => {
    assert.throws(() => loadConfig(envWithout('DDB_EVENTS_TABLE')), /DDB_EVENTS_TABLE/);
  });

  it('enables transactions by default and accepts false', () => {
    assert.equal(loadConfig(BASE_ENV).ddbTransactions, true);
    assert.equal(
      loadConfig({ ...BASE_ENV, DDB_TRANSACTIONS: 'FALSE' }).ddbTransactions,
      false,
    );
  });

  it('rejects invalid DDB_TRANSACTIONS', () => {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, DDB_TRANSACTIONS: 'si' }),
      /DDB_TRANSACTIONS/,
    );
  });

  it('fails when DOCS_BUCKET is empty', () => {
    const env = { ...BASE_ENV, DOCS_BUCKET: '   ' };
    assert.throws(() => loadConfig(env), /DOCS_BUCKET/);
  });

  it('fails when JWT_SECRET is too short', () => {
    const env = { ...BASE_ENV, JWT_SECRET: 'corto' };
    assert.throws(() => loadConfig(env), /JWT_SECRET/);
  });

  it('uses DB_PORT 3306 by default', () => {
    const config = loadConfig(envWithout('DB_PORT'));
    assert.equal(config.dbPort, 3306);
  });

  it('rejects invalid DB_PORT', () => {
    const env = { ...BASE_ENV, DB_PORT: 'no-es-puerto' };
    assert.throws(() => loadConfig(env), /DB_PORT/);
  });

  it('reads optional variables and CORS', () => {
    const env = {
      ...BASE_ENV,
      DDB_ENDPOINT_URL: 'http://localhost:8001',
      CORS_ALLOWED_ORIGINS:
        ' http://localhost:5500 , http://127.0.0.1:5500 , ',
    };
    const config = loadConfig(env);
    assert.equal(config.ddbEndpointUrl, 'http://localhost:8001');
    assert.deepEqual(config.corsAllowedOrigins, [
      'http://localhost:5500',
      'http://127.0.0.1:5500',
    ]);
  });

  it('leaves DDB_ENDPOINT_URL undefined when not set', () => {
    const config = loadConfig(envWithout('DDB_ENDPOINT_URL'));
    assert.equal(config.ddbEndpointUrl, undefined);
  });
});
