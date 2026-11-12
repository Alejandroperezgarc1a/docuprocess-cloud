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

suite('worker integration (DynamoDB Local + S3 real)', () => {
  it(
    'dos workers procesan 20 items exactamente una vez',
    { timeout: 120_000 },
    async () => {
      assert.ok(DOCS_BUCKET !== '', 'Define DOCS_BUCKET para RUN_INTEGRATION=1');

      const ddbClient = new DynamoDBClient({
        region: REGION,
        ...(DDB_ENDPOINT_URL !== '' ? { endpoint: DDB_ENDPOINT_URL } : {}),
      });
      const ddb = DynamoDBDocumentClient.from(ddbClient, {
        marshallOptions: { removeUndefinedValues: true },
      });
      const s3 = new S3Client({ region: REGION });
      const now = new Date().toISOString();
      const runId = randomUUID().slice(0, 8);
      const items: DocumentItem[] = Array.from({ length: 20 }, (_, index) => {
        const documentId = randomUUID();
        return {
          documentId,
          userId: `integration-${runId}`,
          filename: `doc-${index}.txt`,
          contentType: 'text/plain',
          s3Key: `uploads/integration-${runId}/${documentId}/doc-${index}.txt`,
          status: 'PENDING',
          createdAt: now,
          updatedAt: now,
        };
      });
      const outputs: string[] = [];

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

        const env = {
          ...process.env,
          AWS_REGION: REGION,
          DOCS_BUCKET,
          DDB_TABLE,
          DDB_EVENTS_TABLE,
          DDB_TRANSACTIONS: process.env.DDB_TRANSACTIONS ?? 'true',
          SNS_TOPIC_ARN: process.env.SNS_TOPIC_ARN ?? '',
          WORKER_POLL_SECONDS: '1',
          WORKER_BATCH_SIZE: '10',
          UPLOAD_TIMEOUT_MINUTES: '15',
          MAX_FILE_MB: '10',
          LOG_LEVEL: 'error',
          ...(DDB_ENDPOINT_URL !== ''
            ? { DDB_ENDPOINT_URL }
            : { DDB_ENDPOINT_URL: '' }),
        };

        const children = [1, 2].map(() =>
          spawn(process.execPath, ['dist/worker.js'], {
            cwd: APP_DIR,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        );
        for (const child of children) {
          child.stdout?.on('data', (chunk: Buffer) => {
            outputs.push(chunk.toString('utf8'));
          });
          child.stderr?.on('data', (chunk: Buffer) => {
            outputs.push(chunk.toString('utf8'));
          });
        }

        try {
          const deadline = Date.now() + 45_000;
          let pending = items.length;
          while (Date.now() < deadline) {
            pending = 0;
            for (const item of items) {
              const current = await ddb.send(
                new GetCommand({
                  TableName: DDB_TABLE,
                  Key: { documentId: item.documentId },
                  ConsistentRead: true,
                }),
              );
              if (current.Item?.status !== 'DONE') {
                pending += 1;
              }
            }
            if (pending === 0) {
              break;
            }
            await delay(500);
          }

          assert.equal(
            pending,
            0,
            `Quedaron ${pending} documentos sin DONE.\n${outputs.join('')}`,
          );

          for (const item of items) {
            const current = await ddb.send(
              new GetCommand({
                TableName: DDB_TABLE,
                Key: { documentId: item.documentId },
                ConsistentRead: true,
              }),
            );
            assert.equal(current.Item?.status, 'DONE');
            assert.equal(current.Item?.result?.mimeType, 'text/plain');
            assert.equal(current.Item?.result?.sizeBytes, Buffer.byteLength(
              `contenido de ${item.filename}\n`,
              'utf8',
            ));

            const events = await ddb.send(
              new QueryCommand({
                TableName: DDB_EVENTS_TABLE,
                KeyConditionExpression: 'documentId = :id',
                ExpressionAttributeValues: { ':id': item.documentId },
                ConsistentRead: true,
              }),
            );
            const transitions = (events.Items ?? []).map(
              (event) => event.toStatus as string,
            );
            assert.deepEqual(
              transitions.sort(),
              ['DONE', 'PROCESSING'],
              `Eventos inesperados para ${item.documentId}: ${transitions.join(',')}`,
            );
          }
        } finally {
          await Promise.all(children.map((child) => stopChild(child)));
        }
      } finally {
        for (const item of items) {
          await ddb
            .send(
              new DeleteCommand({
                TableName: DDB_TABLE,
                Key: { documentId: item.documentId },
              }),
            )
            .catch(() => undefined);
          const events = await ddb
            .send(
              new QueryCommand({
                TableName: DDB_EVENTS_TABLE,
                KeyConditionExpression: 'documentId = :id',
                ExpressionAttributeValues: { ':id': item.documentId },
              }),
            )
            .catch(() => ({ Items: [] as Record<string, unknown>[] }));
          for (const event of events.Items ?? []) {
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
        ddb.destroy();
        s3.destroy();
      }
    },
  );
});
