// Integration tests for the DocuProcess Cloud worker against DynamoDB Local + real S3.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { DocumentItem } from '../../src/types.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
const APP_DIR = fileURLToPath(new URL('../..', import.meta.url));
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const DOCS_BUCKET = process.env.DOCS_BUCKET ?? '';
const DDB_TABLE = process.env.DDB_TABLE ?? 'documents';
const DDB_EVENTS_TABLE = process.env.DDB_EVENTS_TABLE ?? 'document_events';
const DDB_ENDPOINT_URL = process.env.DDB_ENDPOINT_URL ?? '';
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN ?? '';

interface LogRecord {
  event?: string;
  documentId?: string;
  status?: string;
  payload?: { documentId?: string };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), delay(5_000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

/** Joins the stdout/stderr chunks and parses only the JSON lines from the logger. */
function parseLogs(outputs: string[]): LogRecord[] {
  const logs: LogRecord[] = [];
  for (const line of outputs.join('').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed !== null && typeof parsed === 'object') {
        logs.push(parsed as LogRecord);
      }
    } catch {
      // A chunk may split a line; the join already rebuilds it, but if it is
      // still not valid JSON it is ignored instead of breaking the test.
    }
  }
  return logs;
}

function createClients(): {
  ddb: DynamoDBDocumentClient;
  s3: S3Client;
  ddbClient: DynamoDBClient;
} {
  const ddbClient = new DynamoDBClient({
    region: REGION,
    ...(DDB_ENDPOINT_URL !== '' ? { endpoint: DDB_ENDPOINT_URL } : {}),
  });
  const ddb = DynamoDBDocumentClient.from(ddbClient, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return { ddb, s3: new S3Client({ region: REGION }), ddbClient };
}

function buildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AWS_REGION: REGION,
    DOCS_BUCKET,
    DDB_TABLE,
    DDB_EVENTS_TABLE,
    DDB_TRANSACTIONS: process.env.DDB_TRANSACTIONS ?? 'true',
    SNS_TOPIC_ARN,
    WORKER_POLL_SECONDS: '1',
    WORKER_BATCH_SIZE: '10',
    UPLOAD_TIMEOUT_MINUTES: '15',
    MAX_FILE_MB: '10',
    LOG_LEVEL: 'info',
    DDB_ENDPOINT_URL,
  };
}

/** Starts a worker and collects its logs into `outputs`. */
function startWorker(env: NodeJS.ProcessEnv, outputs: string[]): ChildProcess {
  const child = spawn(process.execPath, ['dist/worker.js'], {
    cwd: APP_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    outputs.push(chunk.toString('utf8'));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    outputs.push(chunk.toString('utf8'));
  });
  return child;
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await delay(intervalMs);
  }
  return check();
}

async function getItem(
  ddb: DynamoDBDocumentClient,
  documentId: string,
): Promise<Record<string, unknown> | undefined> {
  const current = await ddb.send(
    new GetCommand({
      TableName: DDB_TABLE,
      Key: { documentId },
      ConsistentRead: true,
    }),
  );
  return current.Item;
}

async function getEvents(
  ddb: DynamoDBDocumentClient,
  documentId: string,
): Promise<Record<string, unknown>[]> {
  const events = await ddb.send(
    new QueryCommand({
      TableName: DDB_EVENTS_TABLE,
      KeyConditionExpression: 'documentId = :id',
      ExpressionAttributeValues: { ':id': documentId },
      ConsistentRead: true,
    }),
  );
  return events.Items ?? [];
}

async function cleanupItems(
  ddb: DynamoDBDocumentClient,
  s3: S3Client,
  items: DocumentItem[],
): Promise<void> {
  for (const item of items) {
    await ddb
      .send(
        new DeleteCommand({
          TableName: DDB_TABLE,
          Key: { documentId: item.documentId },
        }),
      )
      .catch(() => undefined);
    const events = await getEvents(ddb, item.documentId).catch(
      () => [] as Record<string, unknown>[],
    );
    for (const event of events) {
      await ddb
        .send(
          new DeleteCommand({
            TableName: DDB_EVENTS_TABLE,
            Key: {
              documentId: item.documentId,
              eventAt: event.eventAt,
            },
          }),
        )
        .catch(() => undefined);
    }
    await s3
      .send(
        new DeleteObjectCommand({
          Bucket: DOCS_BUCKET,
          Key: item.s3Key,
        }),
      )
      .catch(() => undefined);
  }
}

function makeDocument(
  runId: string,
  index: number,
  overrides: Partial<DocumentItem> = {},
): DocumentItem {
  const documentId = randomUUID();
  const now = new Date().toISOString();
  return {
    documentId,
    userId: `integration-${runId}`,
    filename: `doc-${index}.txt`,
    contentType: 'text/plain',
    s3Key: `uploads/integration-${runId}/${documentId}/doc-${index}.txt`,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Checks that the worker published to SNS (or logged the skip when no topic). */
function assertSns(
  logs: LogRecord[],
  entries: Array<{ documentId: string; status: string }>,
): void {
  if (SNS_TOPIC_ARN !== '') {
    for (const entry of entries) {
      const published = logs.some(
        (log) =>
          log.event === 'sns_published' &&
          log.documentId === entry.documentId &&
          log.status === entry.status,
      );
      assert.ok(
        published,
        `SNS publish missing for ${entry.status} on ${entry.documentId}`,
      );
    }
    return;
  }

  const skipped = logs.filter((log) => log.event === 'sns_skipped');
  assert.equal(
    skipped.length,
    entries.length,
    `Empty SNS: expected ${entries.length} sns_skipped and got ${skipped.length}`,
  );
}

suite('worker integration (DynamoDB Local + S3 real)', () => {
  it(
    'two workers process 20 items exactly once',
    { timeout: 120_000 },
    async () => {
      assert.ok(DOCS_BUCKET !== '', 'Define DOCS_BUCKET to run with RUN_INTEGRATION=1');

      const { ddb, s3, ddbClient } = createClients();
      const runId = randomUUID().slice(0, 8);
      const items = Array.from({ length: 20 }, (_, index) =>
        makeDocument(runId, index),
      );
      const outputs: string[] = [];
      const children: ChildProcess[] = [];

      try {
        for (const item of items) {
          await s3.send(
            new PutObjectCommand({
              Bucket: DOCS_BUCKET,
              Key: item.s3Key,
              Body: Buffer.from(`contenido de ${item.filename}\n`, 'utf8'),
              ContentType: 'text/plain',
            }),
          );
          await ddb.send(
            new PutCommand({ TableName: DDB_TABLE, Item: item }),
          );
        }

        for (let index = 0; index < 2; index += 1) {
          children.push(startWorker(buildEnv(), outputs));
        }

        const allDone = await waitFor(async () => {
          const current = await Promise.all(
            items.map((item) => getItem(ddb, item.documentId)),
          );
          return current.every((item) => item?.status === 'DONE');
        }, 45_000);
        assert.ok(
          allDone,
          `Documents left without DONE.\n${outputs.join('')}`,
        );

        for (const item of items) {
          const current = await getItem(ddb, item.documentId);
          assert.equal(current?.status, 'DONE');
          assert.equal(
            (current?.result as Record<string, unknown> | undefined)?.mimeType,
            'text/plain',
          );
          assert.equal(
            (current?.result as Record<string, unknown> | undefined)?.sizeBytes,
            Buffer.byteLength(`contenido de ${item.filename}\n`, 'utf8'),
          );

          const transitions = (await getEvents(ddb, item.documentId)).map(
            (event) => event.toStatus as string,
          );
          assert.deepEqual(
            transitions.sort(),
            ['DONE', 'PROCESSING'],
            `Unexpected events for ${item.documentId}: ${transitions.join(',')}`,
          );
        }

        await Promise.all(children.map((child) => stopChild(child)));
        assertSns(
          parseLogs(outputs),
          items.map((item) => ({
            documentId: item.documentId,
            status: 'DONE',
          })),
        );
      } finally {
        await Promise.all(children.map((child) => stopChild(child)));
        await cleanupItems(ddb, s3, items);
        ddbClient.destroy();
        s3.destroy();
      }
    },
  );

  it(
    'skips objects not yet uploaded and fails those past the timeout',
    { timeout: 60_000 },
    async () => {
      assert.ok(DOCS_BUCKET !== '', 'Define DOCS_BUCKET to run with RUN_INTEGRATION=1');

      const { ddb, s3, ddbClient } = createClients();
      const runId = randomUUID().slice(0, 8);
      const now = new Date();
      const fresh = makeDocument(runId, 0, {
        filename: 'missing-now.txt',
        s3Key: 'uploads/integration-timeout/no-existe-ahora.txt',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      const expired = makeDocument(runId, 1, {
        filename: 'missing-old.txt',
        s3Key: 'uploads/integration-timeout/no-existe-vencido.txt',
        createdAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
        updatedAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
      });
      const items = [fresh, expired];
      const outputs: string[] = [];
      const children: ChildProcess[] = [];

      try {
        for (const item of items) {
          await ddb.send(
            new PutCommand({ TableName: DDB_TABLE, Item: item }),
          );
        }

        children.push(startWorker(buildEnv(), outputs));

        const expiredFailed = await waitFor(async () => {
          const current = await getItem(ddb, expired.documentId);
          return current?.status === 'FAILED';
        }, 45_000);
        assert.ok(
          expiredFailed,
          `The expired object did not transition to FAILED.\n${outputs.join('')}`,
        );

        // Let a couple of cycles run to confirm the recent object is
        // skipped without changing state.
        await delay(2_000);
        await Promise.all(children.map((child) => stopChild(child)));

        const freshItem = await getItem(ddb, fresh.documentId);
        assert.equal(freshItem?.status, 'PENDING');

        const expiredItem = await getItem(ddb, expired.documentId);
        assert.equal(expiredItem?.status, 'FAILED');
        assert.equal(expiredItem?.error, 'upload timeout');

        const expiredEvents = await getEvents(ddb, expired.documentId);
        assert.deepEqual(
          expiredEvents.map((event) => event.toStatus).sort(),
          ['FAILED'],
          `Unexpected events for ${expired.documentId}: ` +
            expiredEvents.map((event) => event.toStatus).join(','),
        );
        assert.equal(expiredEvents[0]?.actor, 'worker');

        const logs = parseLogs(outputs);
        assert.ok(
          logs.some(
            (log) =>
              log.event === 'upload_pending' &&
              log.documentId === fresh.documentId,
          ),
          `upload_pending was not logged for ${fresh.documentId}`,
        );
        assert.ok(
          logs.some(
            (log) =>
              log.event === 'upload_timeout' &&
              log.documentId === expired.documentId,
          ),
          `upload_timeout was not logged for ${expired.documentId}`,
        );
        assertSns(logs, [
          { documentId: expired.documentId, status: 'FAILED' },
        ]);
      } finally {
        await Promise.all(children.map((child) => stopChild(child)));
        await cleanupItems(ddb, s3, items);
        ddbClient.destroy();
        s3.destroy();
      }
    },
  );
});
