// Tests for the conditional claim logic of the DocuProcess Cloud worker.
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

describe('conditional claim', () => {
  it('recognizes ConditionalCheckFailedException', () => {
    const error = new Error('condition failed');
    error.name = 'ConditionalCheckFailedException';
    assert.equal(isConditionalCheckFailure(error), true);
  });

  it('recognizes TransactionCanceledException by condition', () => {
    const error = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [
        { Code: 'None' },
        { Code: 'ConditionalCheckFailed' },
      ],
    });
    assert.equal(isConditionalCheckFailure(error), true);
  });

  it('does not confuse other errors', () => {
    assert.equal(isConditionalCheckFailure(new Error('boom')), false);
  });

  it('skips the item if another instance won the claim', async () => {
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

  it('a second worker does not reprocess the same item', async () => {
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
