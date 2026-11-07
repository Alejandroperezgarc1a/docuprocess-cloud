import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

const BASE_ENV: Record<string, string> = {
  DOCS_BUCKET: 'test-docs-bucket',
  DDB_TABLE: 'documents',
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
  it('falla si falta una obligatoria', () => {
    assert.throws(() => loadConfig(envWithout('DB_HOST')), /DB_HOST/);
  });

  it('falla si DOCS_BUCKET esta vacio', () => {
    const env = { ...BASE_ENV, DOCS_BUCKET: '   ' };
    assert.throws(() => loadConfig(env), /DOCS_BUCKET/);
  });

  it('falla si JWT_SECRET es corto', () => {
    const env = { ...BASE_ENV, JWT_SECRET: 'corto' };
    assert.throws(() => loadConfig(env), /JWT_SECRET/);
  });

  it('usa DB_PORT 3306 por defecto', () => {
    const config = loadConfig(envWithout('DB_PORT'));
    assert.equal(config.dbPort, 3306);
  });

  it('rechaza DB_PORT invalido', () => {
    const env = { ...BASE_ENV, DB_PORT: 'no-es-puerto' };
    assert.throws(() => loadConfig(env), /DB_PORT/);
  });

  it('lee opcionales y CORS', () => {
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

  it('deja DDB_ENDPOINT_URL indefinido si no se define', () => {
    const config = loadConfig(envWithout('DDB_ENDPOINT_URL'));
    assert.equal(config.ddbEndpointUrl, undefined);
  });
});
