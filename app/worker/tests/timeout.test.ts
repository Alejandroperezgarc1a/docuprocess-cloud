import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { processItem } from '../src/process.js';
import {
  FakeAwsService,
  makeConfig,
  makeItem,
  silentLogger,
} from './helpers/fakes.js';

const NOW = new Date('2026-11-11T12:00:00.000Z');

describe('timeout de subida', () => {
  it('marca FAILED upload timeout cuando el PENDING supera 15 minutos', async () => {
    const aws = new FakeAwsService();
    aws.head = { exists: false, reason: 'not_found' };
    const item = makeItem({ createdAt: '2026-11-11T11:40:00.000Z' });

    const processed = await processItem(item, {
      aws,
      config: makeConfig(),
      logger: silentLogger(),
      now: () => NOW,
    });

    assert.equal(processed, true);
    assert.equal(aws.failPendingCalls.length, 1);
    assert.equal(aws.failPendingCalls[0]?.error, 'upload timeout');
    assert.equal(aws.failPendingCalls[0]?.now, NOW.toISOString());
    assert.equal(aws.published.length, 1);
    assert.equal(aws.published[0]?.status, 'FAILED');
    assert.equal(aws.published[0]?.error, 'upload timeout');
    assert.equal(aws.getObjectStreamCalls, 0);
  });

  it('salta el item si aun esta dentro de la ventana de subida', async () => {
    const aws = new FakeAwsService();
    aws.head = { exists: false, reason: 'forbidden' };
    const item = makeItem({ createdAt: '2026-11-11T11:55:00.000Z' });

    const processed = await processItem(item, {
      aws,
      config: makeConfig(),
      logger: silentLogger(),
      now: () => NOW,
    });

    assert.equal(processed, false);
    assert.equal(aws.failPendingCalls.length, 0);
    assert.equal(aws.published.length, 0);
  });

  it('no publica si otro worker ya cerro el timeout', async () => {
    const aws = new FakeAwsService();
    aws.head = { exists: false, reason: 'not_found' };
    aws.failPendingResult = false;
    const item = makeItem({ createdAt: '2026-11-11T10:00:00.000Z' });

    const processed = await processItem(item, {
      aws,
      config: makeConfig(),
      logger: silentLogger(),
      now: () => NOW,
    });

    assert.equal(processed, false);
    assert.equal(aws.failPendingCalls.length, 1);
    assert.equal(aws.published.length, 0);
  });

  it('marca FAILED si HeadObject reporta un archivo demasiado grande', async () => {
    const aws = new FakeAwsService();
    aws.head = { exists: true, sizeBytes: 20 };
    const item = makeItem();

    const processed = await processItem(item, {
      aws,
      config: makeConfig({ maxFileBytes: 10 }),
      logger: silentLogger(),
      now: () => NOW,
    });

    assert.equal(processed, true);
    assert.equal(aws.claimCalls.length, 1);
    assert.equal(aws.failCalls.length, 1);
    assert.equal(aws.failCalls[0]?.error, 'file too large');
    assert.equal(aws.published[0]?.status, 'FAILED');
  });
});
