import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.js';

const BASE = {
  DOCS_BUCKET: 'docs',
  DDB_TABLE: 'documents',
  DDB_EVENTS_TABLE: 'document_events',
  AWS_REGION: 'us-east-1',
};

describe('config', () => {
  it('aplica defaults y calcula MAX_FILE_MB en bytes', () => {
    const config = loadConfig({ ...BASE, MAX_FILE_MB: '2' });

    assert.equal(config.pollSeconds, 5);
    assert.equal(config.batchSize, 10);
    assert.equal(config.uploadTimeoutMinutes, 15);
    assert.equal(config.processingTimeoutMinutes, 30);
    assert.equal(config.maxFileBytes, 2 * 1024 * 1024);
    assert.equal(config.snsTopicArn, '');
    assert.equal(config.ddbTransactions, true);
    assert.equal(config.ddbEndpointUrl, undefined);
  });

  it('falla si falta una variable obligatoria', () => {
    const env = { ...BASE };
    delete (env as Partial<typeof BASE>).DDB_EVENTS_TABLE;

    assert.throws(
      () => loadConfig(env),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('DDB_EVENTS_TABLE'),
    );
  });

  it('rechaza numeros invalidos', () => {
    assert.throws(
      () => loadConfig({ ...BASE, WORKER_POLL_SECONDS: '0' }),
      ConfigError,
    );
    assert.throws(
      () => loadConfig({ ...BASE, WORKER_BATCH_SIZE: '1.5' }),
      ConfigError,
    );
  });

  it('lee PROCESSING_TIMEOUT_MINUTES y lo valida', () => {
    const config = loadConfig({ ...BASE, PROCESSING_TIMEOUT_MINUTES: '45' });
    assert.equal(config.processingTimeoutMinutes, 45);

    assert.throws(
      () => loadConfig({ ...BASE, PROCESSING_TIMEOUT_MINUTES: '0' }),
      ConfigError,
    );
  });

  it('rechaza DDB_TRANSACTIONS invalido', () => {
    assert.throws(
      () => loadConfig({ ...BASE, DDB_TRANSACTIONS: 'maybe' }),
      ConfigError,
    );
  });

  it('acepta endpoint local y desactiva transacciones', () => {
    const config = loadConfig({
      ...BASE,
      DDB_ENDPOINT_URL: 'http://localhost:8001',
      DDB_TRANSACTIONS: 'false',
      SNS_TOPIC_ARN: 'arn:aws:sns:us-east-1:123456789012:topic',
    });

    assert.equal(config.ddbEndpointUrl, 'http://localhost:8001');
    assert.equal(config.ddbTransactions, false);
    assert.equal(config.snsTopicArn, 'arn:aws:sns:us-east-1:123456789012:topic');
  });
});
