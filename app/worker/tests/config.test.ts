// Tests for environment configuration loading of the DocuProcess Cloud worker.
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
  it('applies defaults and computes MAX_FILE_MB in bytes', () => {
    const config = loadConfig({ ...BASE, MAX_FILE_MB: '2' });

    assert.equal(config.pollSeconds, 5);
    assert.equal(config.batchSize, 10);
    assert.equal(config.uploadTimeoutMinutes, 15);
    assert.equal(config.maxFileBytes, 2 * 1024 * 1024);
    assert.equal(config.snsTopicArn, '');
    assert.equal(config.ddbTransactions, true);
    assert.equal(config.ddbEndpointUrl, undefined);
  });

  it('fails if a required variable is missing', () => {
    const env = { ...BASE };
    delete (env as Partial<typeof BASE>).DDB_EVENTS_TABLE;

    assert.throws(
      () => loadConfig(env),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes('DDB_EVENTS_TABLE'),
    );
  });

  it('rejects invalid numbers', () => {
    assert.throws(
      () => loadConfig({ ...BASE, WORKER_POLL_SECONDS: '0' }),
      ConfigError,
    );
    assert.throws(
      () => loadConfig({ ...BASE, WORKER_BATCH_SIZE: '1.5' }),
      ConfigError,
    );
  });

  it('rejects invalid DDB_TRANSACTIONS', () => {
    assert.throws(
      () => loadConfig({ ...BASE, DDB_TRANSACTIONS: 'maybe' }),
      ConfigError,
    );
  });

  it('accepts local endpoint and disables transactions', () => {
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
