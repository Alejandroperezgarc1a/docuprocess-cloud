import { Readable } from 'node:stream';
import type { AwsService, ObjectHead, ObjectStream } from '../../src/aws.js';
import type { WorkerConfig } from '../../src/config.js';
import type { Logger } from '../../src/logger.js';
import type {
  DocumentItem,
  DocumentResult,
  NotificationPayload,
} from '../../src/types.js';

export function makeConfig(
  overrides: Partial<WorkerConfig> = {},
): WorkerConfig {
  return {
    docsBucket: 'docs-bucket',
    ddbTable: 'documents',
    ddbEventsTable: 'document_events',
    awsRegion: 'us-east-1',
    snsTopicArn: '',
    ddbTransactions: true,
    pollSeconds: 5,
    batchSize: 10,
    uploadTimeoutMinutes: 15,
    maxFileBytes: 10 * 1024 * 1024,
    logLevel: 'error',
    workerId: 'test-worker',
    ...overrides,
  };
}

export function makeItem(overrides: Partial<DocumentItem> = {}): DocumentItem {
  const now = new Date('2026-11-11T12:00:00.000Z').toISOString();
  return {
    documentId: 'doc-1',
    userId: 'user-1',
    filename: 'sample.txt',
    contentType: 'text/plain',
    s3Key: 'uploads/user-1/doc-1/sample.txt',
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function silentLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

export class FakeAwsService implements AwsService {
  pending: DocumentItem[] = [];
  queryLimit?: number;

  head: ObjectHead = { exists: true, sizeBytes: 11 };
  headError?: Error;

  claimResults: boolean[] = [];
  claimCalls: Array<{ item: DocumentItem; now: string }> = [];

  completeResult = true;
  completeCalls: Array<{
    item: DocumentItem;
    result: DocumentResult;
    now: string;
  }> = [];

  failResult = true;
  failCalls: Array<{ item: DocumentItem; error: string; now: string }> = [];

  failPendingResult = true;
  failPendingCalls: Array<{
    item: DocumentItem;
    error: string;
    now: string;
  }> = [];

  getObjectStreamCalls = 0;
  getObjectStreamError?: Error;
  contentLength?: number;
  streamFactory: () => Readable = () =>
    Readable.from([Buffer.from('hola mundo', 'utf8')]);

  published: NotificationPayload[] = [];
  publishError?: Error;

  async queryPending(limit: number): Promise<DocumentItem[]> {
    this.queryLimit = limit;
    return this.pending;
  }

  async headObject(): Promise<ObjectHead> {
    if (this.headError !== undefined) {
      throw this.headError;
    }
    return this.head;
  }

  async getObjectStream(): Promise<ObjectStream> {
    this.getObjectStreamCalls += 1;
    if (this.getObjectStreamError !== undefined) {
      throw this.getObjectStreamError;
    }
    return {
      stream: this.streamFactory(),
      ...(this.contentLength !== undefined
        ? { contentLength: this.contentLength }
        : {}),
    };
  }

  async claim(item: DocumentItem, now: string): Promise<boolean> {
    this.claimCalls.push({ item, now });
    return this.claimResults.length > 0
      ? (this.claimResults.shift() ?? false)
      : true;
  }

  async complete(
    item: DocumentItem,
    result: DocumentResult,
    now: string,
  ): Promise<boolean> {
    this.completeCalls.push({ item, result, now });
    return this.completeResult;
  }

  async fail(
    item: DocumentItem,
    error: string,
    now: string,
  ): Promise<boolean> {
    this.failCalls.push({ item, error, now });
    return this.failResult;
  }

  async failPending(
    item: DocumentItem,
    error: string,
    now: string,
  ): Promise<boolean> {
    this.failPendingCalls.push({ item, error, now });
    return this.failPendingResult;
  }

  async publish(payload: NotificationPayload): Promise<void> {
    if (this.publishError !== undefined) {
      throw this.publishError;
    }
    this.published.push(payload);
  }
}
