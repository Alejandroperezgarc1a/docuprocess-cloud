import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type PutCommandInput,
  type TransactWriteUpdate,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { Readable } from 'node:stream';
import type { WorkerConfig } from './config.js';
import type { Logger } from './logger.js';
import { buildSubject } from './notify.js';
import type {
  DocumentEvent,
  DocumentItem,
  DocumentResult,
  DocumentStatus,
  NotificationPayload,
} from './types.js';

const PENDING = 'PENDING' as const;
const PROCESSING = 'PROCESSING' as const;
const DONE = 'DONE' as const;
const FAILED = 'FAILED' as const;

export interface ObjectHead {
  exists: boolean;
  sizeBytes?: number;
  /** Motivo cuando el objeto no es accesible (not_found o forbidden). */
  reason?: string;
}

export interface ObjectStream {
  stream: Readable;
  contentLength?: number;
}

/** Puerta de entrada a AWS; permite inyectar un fake en pruebas. */
export interface AwsService {
  queryPending(limit: number): Promise<DocumentItem[]>;
  headObject(key: string): Promise<ObjectHead>;
  getObjectStream(key: string): Promise<ObjectStream>;
  claim(item: DocumentItem, now: string): Promise<boolean>;
  complete(item: DocumentItem, result: DocumentResult, now: string): Promise<boolean>;
  fail(item: DocumentItem, error: string, now: string): Promise<boolean>;
  failPending(item: DocumentItem, error: string, now: string): Promise<boolean>;
  publish(payload: NotificationPayload): Promise<void>;
}

export function errorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name;
  }
  return 'UnknownError';
}

export function httpStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode;
}

/** Un claim perdido o una transicion ya aplicada. */
export function isConditionalCheckFailure(error: unknown): boolean {
  const name = errorName(error);
  if (name === 'ConditionalCheckFailedException') {
    return true;
  }
  if (name === 'TransactionCanceledException') {
    const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> })
      .CancellationReasons;
    return (
      reasons?.some((reason) => reason.Code === 'ConditionalCheckFailed') ?? false
    );
  }
  return false;
}

/**
 * Transaccion cancelada por un conflicto transitorio con otra transaccion sobre el mismo item
 * (p. ej., el claim de otro worker en el mismo instante). A diferencia de ConditionalCheckFailed,
 * no significa que otro gano: hay que reintentar. El SDK no la reintenta por su cuenta.
 */
export function isTransactionConflict(error: unknown): boolean {
  if (errorName(error) !== 'TransactionCanceledException') {
    return false;
  }
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> })
    .CancellationReasons;
  return (
    (reasons?.some((reason) => reason.Code === 'TransactionConflict') ?? false) &&
    !isConditionalCheckFailure(error)
  );
}

/**
 * Ejecuta `operation` y la reintenta con espera creciente mientras falle por TransactionConflict.
 * Las transiciones son condicionales e idempotentes (mismo evento, misma clave), asi que repetirlas
 * es seguro. Cualquier otro error, o el ultimo intento, se propaga.
 */
export async function withConflictRetry<T>(
  operation: () => Promise<T>,
  attempts = 5,
  baseDelayMs = 50,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isTransactionConflict(error)) {
        throw error;
      }
      await sleep(baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * baseDelayMs));
    }
  }
}

/** 403 y 404 significan que el objeto aun no es accesible; el resto se propaga. */
export function isObjectUnavailable(error: unknown): boolean {
  const status = httpStatusCode(error);
  if (status === 403 || status === 404) {
    return true;
  }
  const name = errorName(error);
  return (
    name === 'NotFound' ||
    name === 'NoSuchKey' ||
    name === 'AccessDenied' ||
    name === 'Forbidden'
  );
}

/** Construye el evento append-only de una transicion hecha por el worker. */
export function makeEvent(
  item: DocumentItem,
  fromStatus: DocumentStatus,
  toStatus: DocumentStatus,
  now: string,
  extra: Pick<DocumentEvent, 'reason' | 'error' | 'requestId'> = {},
): DocumentEvent {
  return {
    documentId: item.documentId,
    eventAt: `${now}#${randomUUID().slice(0, 6)}`,
    eventId: randomUUID(),
    userId: item.userId,
    eventDay: now.slice(0, 10),
    fromStatus,
    toStatus,
    actor: 'worker',
    schemaVersion: 1,
    ...extra,
  };
}

/** Expresion de actualizacion terminal, exportada para pruebas. */
export function buildTerminalUpdate(status: 'DONE' | 'FAILED'): string {
  return status === DONE
    ? 'SET #s = :done, #r = :result, updatedAt = :now REMOVE #e'
    : 'SET #s = :failed, #e = :error, updatedAt = :now REMOVE #r';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Crea el servicio real de AWS. Los clientes se configuran con reintentos
 * acotados y sin checksums adicionales en S3 (compatible con el resto del API).
 */
export function createAwsService(
  config: WorkerConfig,
  logger: Logger,
): AwsService {
  const dynamoClient = new DynamoDBClient({
    region: config.awsRegion,
    maxAttempts: 3,
    ...(config.ddbEndpointUrl !== undefined
      ? { endpoint: config.ddbEndpointUrl }
      : {}),
  });
  const ddb = DynamoDBDocumentClient.from(dynamoClient, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const s3 = new S3Client({
    region: config.awsRegion,
    maxAttempts: 3,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const sns = new SNSClient({
    region: config.awsRegion,
    maxAttempts: 3,
  });

  const sendTransition = async (
    update: UpdateCommandInput,
    event: DocumentEvent,
  ): Promise<boolean> => {
    const eventPut: PutCommandInput = {
      TableName: config.ddbEventsTable,
      Item: event,
      ConditionExpression: 'attribute_not_exists(eventAt)',
    };

    try {
      if (config.ddbTransactions) {
        await withConflictRetry(() =>
          ddb.send(
            new TransactWriteCommand({
              TransactItems: [
                { Update: update as TransactWriteUpdate },
                { Put: eventPut },
              ],
            }),
          ),
        );
      } else {
        await ddb.send(new UpdateCommand(update));
        await ddb.send(new PutCommand(eventPut));
      }
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        return false;
      }
      throw error;
    }
  };

  return {
    async queryPending(limit: number): Promise<DocumentItem[]> {
      const result = await ddb.send(
        new QueryCommand({
          TableName: config.ddbTable,
          IndexName: 'status-createdAt',
          KeyConditionExpression: '#s = :pending',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':pending': PENDING },
          ScanIndexForward: true,
          Limit: limit,
        }),
      );
      return (result.Items ?? []) as DocumentItem[];
    },

    async headObject(key: string): Promise<ObjectHead> {
      try {
        const result = await s3.send(
          new HeadObjectCommand({ Bucket: config.docsBucket, Key: key }),
        );
        return {
          exists: true,
          ...(result.ContentLength !== undefined
            ? { sizeBytes: result.ContentLength }
            : {}),
        };
      } catch (error) {
        if (isObjectUnavailable(error)) {
          return {
            exists: false,
            reason: httpStatusCode(error) === 403 ? 'forbidden' : 'not_found',
          };
        }
        throw error;
      }
    },

    async getObjectStream(key: string): Promise<ObjectStream> {
      const result = await s3.send(
        new GetObjectCommand({ Bucket: config.docsBucket, Key: key }),
      );
      if (result.Body === undefined) {
        throw new Error('S3 GetObject devolvio un Body vacio');
      }
      return {
        stream: result.Body as Readable,
        ...(result.ContentLength !== undefined
          ? { contentLength: result.ContentLength }
          : {}),
      };
    },

    async claim(item: DocumentItem, now: string): Promise<boolean> {
      return sendTransition(
        {
          TableName: config.ddbTable,
          Key: { documentId: item.documentId },
          UpdateExpression: 'SET #s = :processing, updatedAt = :now',
          ConditionExpression: '#s = :pending',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':pending': PENDING,
            ':processing': PROCESSING,
            ':now': now,
          },
        },
        makeEvent(item, PENDING, PROCESSING, now, { reason: 'worker claimed' }),
      );
    },

    async complete(
      item: DocumentItem,
      result: DocumentResult,
      now: string,
    ): Promise<boolean> {
      return sendTransition(
        {
          TableName: config.ddbTable,
          Key: { documentId: item.documentId },
          UpdateExpression: buildTerminalUpdate(DONE),
          ConditionExpression: '#s = :processing',
          ExpressionAttributeNames: {
            '#s': 'status',
            '#r': 'result',
            '#e': 'error',
          },
          ExpressionAttributeValues: {
            ':processing': PROCESSING,
            ':done': DONE,
            ':result': result,
            ':now': now,
          },
        },
        makeEvent(item, PROCESSING, DONE, now, { reason: 'processed' }),
      );
    },

    async fail(
      item: DocumentItem,
      error: string,
      now: string,
    ): Promise<boolean> {
      return sendTransition(
        {
          TableName: config.ddbTable,
          Key: { documentId: item.documentId },
          UpdateExpression: buildTerminalUpdate(FAILED),
          ConditionExpression: '#s = :processing',
          ExpressionAttributeNames: {
            '#s': 'status',
            '#r': 'result',
            '#e': 'error',
          },
          ExpressionAttributeValues: {
            ':processing': PROCESSING,
            ':failed': FAILED,
            ':error': error,
            ':now': now,
          },
        },
        makeEvent(item, PROCESSING, FAILED, now, {
          reason: 'processing failed',
          error,
        }),
      );
    },

    async failPending(
      item: DocumentItem,
      error: string,
      now: string,
    ): Promise<boolean> {
      return sendTransition(
        {
          TableName: config.ddbTable,
          Key: { documentId: item.documentId },
          UpdateExpression: buildTerminalUpdate(FAILED),
          ConditionExpression: '#s = :pending',
          ExpressionAttributeNames: {
            '#s': 'status',
            '#r': 'result',
            '#e': 'error',
          },
          ExpressionAttributeValues: {
            ':pending': PENDING,
            ':failed': FAILED,
            ':error': error,
            ':now': now,
          },
        },
        makeEvent(item, PENDING, FAILED, now, {
          reason: error,
          error,
        }),
      );
    },

    async publish(payload: NotificationPayload): Promise<void> {
      if (config.snsTopicArn === '') {
        logger.info('sns_skipped', { payload });
        return;
      }

      const subject = buildSubject(
        payload.filename,
        payload.status,
        payload.documentId,
      );
      const message = JSON.stringify(payload);
      let lastError: unknown;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await sns.send(
            new PublishCommand({
              TopicArn: config.snsTopicArn,
              Subject: subject,
              Message: message,
            }),
          );
          return;
        } catch (error) {
          lastError = error;
          logger.warn('sns_publish_retry', {
            attempt,
            documentId: payload.documentId,
            errorName: errorName(error),
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          if (attempt < 3) {
            await delay(200 * attempt);
          }
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error('SNS publish fallo');
    },
  };
}
