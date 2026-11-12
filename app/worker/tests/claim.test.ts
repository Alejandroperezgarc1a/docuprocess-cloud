import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isConditionalCheckFailure } from '../src/aws.js';
import { processItem } from '../src/process.js';
import {
  FakeAwsService,
  makeConfig,
  makeItem,
  silentLogger,
} from './helpers/fakes.js';

describe('claim condicional', () => {
  it('reconoce ConditionalCheckFailedException', () => {
    const error = new Error('condition failed');
    error.name = 'ConditionalCheckFailedException';
    assert.equal(isConditionalCheckFailure(error), true);
  });

  it('reconoce TransactionCanceledException por condicion', () => {
    const error = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [
        { Code: 'None' },
        { Code: 'ConditionalCheckFailed' },
      ],
    });
    assert.equal(isConditionalCheckFailure(error), true);
  });

  it('no confunde otros errores', () => {
    assert.equal(isConditionalCheckFailure(new Error('boom')), false);
  });

  it('salta el item si otra instancia gano el claim', async () => {
    const aws = new FakeAwsService();
    aws.claimResults = [false];

    const claimed = await processItem(makeItem(), {
      aws,
      config: makeConfig(),
      logger: silentLogger(),
    });

    assert.equal(claimed, false);
    assert.equal(aws.claimCalls.length, 1);
    assert.equal(aws.getObjectStreamCalls, 0);
    assert.equal(aws.completeCalls.length, 0);
    assert.equal(aws.published.length, 0);
  });

  it('un segundo worker no vuelve a procesar el mismo item', async () => {
    const aws = new FakeAwsService();
    aws.claimResults = [true, false];
    const item = makeItem();
    const deps = {
      aws,
      config: makeConfig(),
      logger: silentLogger(),
    };

    const first = await processItem(item, deps);
    const second = await processItem(item, deps);

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(aws.claimCalls.length, 2);
    assert.equal(aws.completeCalls.length, 1);
    assert.equal(aws.published.length, 1);
    assert.equal(aws.published[0]?.status, 'DONE');
  });
});
