/**
 * Health and readiness endpoint tests for DocuProcess Cloud: shallow vs deep
 * checks and MySQL/DynamoDB failure modes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { makeApp } from './helpers/fakes.js';

describe('health', () => {
  it('does not touch MySQL in the normal health check', async () => {
    const { app, db } = makeApp();
    db.failPing = true;

    const response = await request(app).get('/api/health');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: 'ok' });
  });

  it('deep ok', async () => {
    const { app } = makeApp();

    const response = await request(app).get('/api/health?deep=1');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      status: 'ok',
      checks: { mysql: 'ok', dynamodb: 'ok' },
    });
  });

  it('deep returns 503 when MySQL is down', async () => {
    const { app, db } = makeApp();
    db.failPing = true;

    const response = await request(app).get('/api/health?deep=1');

    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'unhealthy');
    assert.deepEqual(response.body.checks, {
      mysql: 'error',
      dynamodb: 'ok',
    });
  });

  it('deep returns 503 when DynamoDB is down', async () => {
    const { app, aws } = makeApp();
    aws.failHealth = true;

    const response = await request(app).get('/api/health?deep=1');

    assert.equal(response.status, 503);
    assert.deepEqual(response.body.checks, {
      mysql: 'ok',
      dynamodb: 'error',
    });
  });

  it('ready is ok when MySQL responds (does not check DynamoDB)', async () => {
    const { app, aws } = makeApp();
    aws.failHealth = true;

    const response = await request(app).get('/api/ready');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: 'ready', checks: { mysql: 'ok' } });
  });

  it('ready returns 503 when MySQL is down', async () => {
    const { app, db } = makeApp();
    db.failPing = true;

    const response = await request(app).get('/api/ready');

    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'not_ready');
    assert.deepEqual(response.body.checks, { mysql: 'error' });
  });

  it('ready only accepts GET', async () => {
    const { app } = makeApp();

    const response = await request(app).post('/api/ready');

    assert.equal(response.status, 405);
  });
});
