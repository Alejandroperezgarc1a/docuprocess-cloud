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

describe('conflicto de transacciones entre workers', () => {
  it('reconoce TransactionConflict', () => {
    assert.equal(isTransactionConflict(cancelled('TransactionConflict', 'None')), true);
  });

  it('no confunde un claim perdido (ConditionalCheckFailed) con un conflicto', () => {
    assert.equal(isTransactionConflict(cancelled('ConditionalCheckFailed', 'None')), false);
    assert.equal(
      isTransactionConflict(cancelled('TransactionConflict', 'ConditionalCheckFailed')),
      false,
    );
  });

  it('no confunde otros errores', () => {
    assert.equal(isTransactionConflict(new Error('boom')), false);
  });

  it('reintenta tras un conflicto y devuelve el resultado', async () => {
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

  it('no reintenta un claim perdido', async () => {
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

  it('se rinde tras el ultimo intento', async () => {
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
