// Tests for transaction conflict detection and retry of the DocuProcess Cloud worker.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTransactionConflict, withConflictRetry } from '../src/aws.js';

function cancelled(...codes: string[]): Error {
  return Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

const noSleep = async (): Promise<void> => {};

describe('transaction conflicts between workers', () => {
  it('recognizes TransactionConflict', () => {
    assert.equal(isTransactionConflict(cancelled('TransactionConflict', 'None')), true);
  });

  it('does not confuse a lost claim (ConditionalCheckFailed) with a conflict', () => {
    assert.equal(isTransactionConflict(cancelled('ConditionalCheckFailed', 'None')), false);
    assert.equal(
      isTransactionConflict(cancelled('TransactionConflict', 'ConditionalCheckFailed')),
      false,
    );
  });

  it('does not confuse other errors', () => {
    assert.equal(isTransactionConflict(new Error('boom')), false);
  });

  it('retries after a conflict and returns the result', async () => {
    let calls = 0;
    const result = await withConflictRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw cancelled('TransactionConflict', 'None');
        }
        return 'ok';
      },
      5,
      1,
      noSleep,
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
  });

  it('does not retry a lost claim', async () => {
    let calls = 0;
    await assert.rejects(
      withConflictRetry(
        async () => {
          calls += 1;
          throw cancelled('ConditionalCheckFailed', 'None');
        },
        5,
        1,
        noSleep,
      ),
      { name: 'TransactionCanceledException' },
    );
    assert.equal(calls, 1);
  });

  it('gives up after the last attempt', async () => {
    let calls = 0;
    await assert.rejects(
      withConflictRetry(
        async () => {
          calls += 1;
          throw cancelled('TransactionConflict', 'None');
        },
        4,
        1,
        noSleep,
      ),
      { name: 'TransactionCanceledException' },
    );
    assert.equal(calls, 4);
  });
});
