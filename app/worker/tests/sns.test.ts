// Tests for SNS notification building of the DocuProcess Cloud worker.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPayload, buildSubject } from '../src/notify.js';
import { makeItem } from './helpers/fakes.js';

describe('SNS notifications', () => {
  it('limits the subject to 100 characters', () => {
    const subject = buildSubject('a'.repeat(200), 'DONE');
    assert.ok(Array.from(subject).length <= 100);
    assert.ok(subject.endsWith('...'));
  });

  it('strips control characters from the subject', () => {
    const subject = buildSubject('archivo\u0000\u0007.pdf', 'FAILED');
    assert.equal(subject, 'DocuProcess: archivo.pdf FAILED');
  });

  it('builds the exact body for DONE', () => {
    const payload = buildPayload(makeItem(), 'DONE');
    assert.deepEqual(payload, {
      documentId: 'doc-1',
      userId: 'user-1',
      filename: 'sample.txt',
      status: 'DONE',
    });
  });

  it('includes error only on FAILED', () => {
    const failed = buildPayload(makeItem(), 'FAILED', 'invalid pdf');
    assert.deepEqual(failed, {
      documentId: 'doc-1',
      userId: 'user-1',
      filename: 'sample.txt',
      status: 'FAILED',
      error: 'invalid pdf',
    });

    const done = buildPayload(makeItem(), 'DONE', 'no debe aparecer');
    assert.equal('error' in done, false);
  });
});
