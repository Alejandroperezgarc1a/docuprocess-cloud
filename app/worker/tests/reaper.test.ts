import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findStaleProcessing } from '../src/aws.js';
import { runWorker } from '../src/worker.js';
import {
  FakeAwsService,
  makeConfig,
  makeItem,
  silentLogger,
} from './helpers/fakes.js';

const STALE_BEFORE = '2026-11-13T11:30:00.000Z';

describe('findStaleProcessing', () => {
  it('incluye solo los PROCESANDO cuya ultima actualizacion es anterior al limite', () => {
    const stale = makeItem({
      documentId: 'doc-stale',
      status: 'PROCESSING',
      createdAt: '2026-11-13T10:00:00.000Z',
      updatedAt: '2026-11-13T10:05:00.000Z',
    });
    const fresh = makeItem({
      documentId: 'doc-fresh',
      status: 'PROCESSING',
      createdAt: '2026-11-13T11:55:00.000Z',
      updatedAt: '2026-11-13T11:59:00.000Z',
    });

    const result = findStaleProcessing([stale, fresh], STALE_BEFORE);

    assert.deepEqual(
      result.map((item) => item.documentId),
      ['doc-stale'],
    );
  });

  it('usa createdAt cuando updatedAt falta', () => {
    const noUpdated = makeItem({
      documentId: 'doc-sin-update',
      status: 'PROCESSING',
      createdAt: '2026-11-13T09:00:00.000Z',
    });
    delete (noUpdated as { updatedAt?: string }).updatedAt;

    const result = findStaleProcessing([noUpdated], STALE_BEFORE);

    assert.equal(result.length, 1);
  });

  it('no marca stale un documento recien reclamado aunque el createdAt sea viejo', () => {
    const recentlyClaimed = makeItem({
      documentId: 'doc-claimed',
      status: 'PROCESSING',
      createdAt: '2026-11-13T08:00:00.000Z',
      updatedAt: '2026-11-13T11:59:30.000Z',
    });

    const result = findStaleProcessing([recentlyClaimed], STALE_BEFORE);

    assert.equal(result.length, 0);
  });
});

describe('reaper en el bucle del worker', () => {
  it('invoca reapStaleProcessing con un staleBefore coherente al arrancar', async () => {
    const aws = new FakeAwsService();
    aws.pending = [];
    let checks = 0;
    const isStopping = (): boolean => {
      checks += 1;
      return checks > 1;
    };

    await runWorker(makeConfig({ pollSeconds: 1 }), aws, silentLogger(), {
      isStopping,
    });

    assert.equal(aws.reapCalls.length, 1);
    const call = aws.reapCalls[0];
    assert.ok(call !== undefined);
    const staleMs = Date.parse(call.staleBefore);
    const nowMs = Date.parse(call.now);
    assert.ok(Number.isFinite(staleMs) && Number.isFinite(nowMs));
    // staleBefore ~ 30 min antes de now (por defecto), dentro de una tolerancia de 1 min.
    assert.ok(nowMs - staleMs >= 29 * 60_000 && nowMs - staleMs <= 31 * 60_000);
  });
});
