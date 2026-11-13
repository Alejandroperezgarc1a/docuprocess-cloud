// Tests for status transitions and append-only events of the DocuProcess Cloud worker.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTerminalUpdate, makeEvent } from '../src/aws.js';
import { makeItem } from './helpers/fakes.js';

const NOW = '2026-11-11T12:00:00.000Z';

describe('transitions and events', () => {
  it('DONE removes error and keeps result', () => {
    const expression = buildTerminalUpdate('DONE');
    assert.match(expression, /#r = :result/);
    assert.match(expression, /REMOVE #e/);
    assert.doesNotMatch(expression, /REMOVE #r/);
  });

  it('FAILED removes result and keeps error', () => {
    const expression = buildTerminalUpdate('FAILED');
    assert.match(expression, /#e = :error/);
    assert.match(expression, /REMOVE #r/);
    assert.doesNotMatch(expression, /REMOVE #e/);
  });

  it('generates worker event with unique eventAt and schemaVersion 1', () => {
    const event = makeEvent(makeItem(), 'PENDING', 'PROCESSING', NOW, {
      reason: 'worker claimed',
    });

    assert.equal(event.documentId, 'doc-1');
    assert.equal(event.userId, 'user-1');
    assert.equal(event.fromStatus, 'PENDING');
    assert.equal(event.toStatus, 'PROCESSING');
    assert.equal(event.actor, 'worker');
    assert.equal(event.schemaVersion, 1);
    assert.equal(event.eventDay, '2026-11-11');
    assert.match(event.eventAt, /^2026-11-11T12:00:00\.000Z#[0-9a-f]{6}$/);
    assert.match(event.eventId, /^[0-9a-f-]{36}$/);
  });
});
