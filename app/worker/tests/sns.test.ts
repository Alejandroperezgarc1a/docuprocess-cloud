import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPayload, buildSubject } from '../src/notify.js';
import { makeItem } from './helpers/fakes.js';

describe('notificaciones SNS', () => {
  it('limita el subject a 100 caracteres', () => {
    const subject = buildSubject('a'.repeat(200), 'DONE');
    assert.ok(Array.from(subject).length <= 100);
    assert.ok(subject.endsWith('...'));
  });

  it('elimina caracteres de control del subject', () => {
    const subject = buildSubject('archivo\u0000\u0007.pdf', 'FAILED');
    assert.equal(subject, 'DocuProcess: archivo.pdf FAILED');
  });

  it('construye el body exacto para DONE', () => {
    const payload = buildPayload(makeItem(), 'DONE');
    assert.deepEqual(payload, {
      documentId: 'doc-1',
      userId: 'user-1',
      filename: 'sample.txt',
      status: 'DONE',
    });
  });

  it('incluye error solo en FAILED', () => {
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
