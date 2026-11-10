import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { makeApp } from './helpers/fakes.js';

describe('health', () => {
  it('no toca MySQL en el health normal', async () => {
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

  it('deep con MySQL caido devuelve 503', async () => {
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

  it('deep con DynamoDB caido devuelve 503', async () => {
    const { app, aws } = makeApp();
    aws.failHealth = true;

    const response = await request(app).get('/api/health?deep=1');

    assert.equal(response.status, 503);
    assert.deepEqual(response.body.checks, {
      mysql: 'ok',
      dynamodb: 'error',
    });
  });

  it('ready ok cuando MySQL responde (no mira DynamoDB)', async () => {
    const { app, aws } = makeApp();
    aws.failHealth = true;

    const response = await request(app).get('/api/ready');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: 'ready', checks: { mysql: 'ok' } });
  });

  it('ready con MySQL caido devuelve 503', async () => {
    const { app, db } = makeApp();
    db.failPing = true;

    const response = await request(app).get('/api/ready');

    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'not_ready');
    assert.deepEqual(response.body.checks, { mysql: 'error' });
  });

  it('ready solo acepta GET', async () => {
    const { app } = makeApp();

    const response = await request(app).post('/api/ready');

    assert.equal(response.status, 405);
  });
});
