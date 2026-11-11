import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from './config.js';
import type { DocumentEvent, DocumentItem } from './types.js';

// Los GSI (índices secundarios globales) son consultas preconstruidas: DynamoDB no
// permite hacer WHERE libre, así que cada patrón de acceso tiene su índice (docs/
// rds-vs-dynamodb.md). Estos límites evitan respuestas enormes y costos inesperados.
const GSI_NAME = 'userId-createdAt';
const DOCUMENT_LIST_LIMIT = 50;
const EVENT_LIST_LIMIT = 200;
const PRESIGN_EXPIRES_SECONDS = 900;

/** AWS operations required by the documents layer. */
export interface AwsService {
  /** Verifies that the DynamoDB table is reachable. */
  healthCheck(): Promise<void>;
  /** Stores the document and its initial audit event (atomically when transactions are enabled). */
  createDocument(item: DocumentItem, event: DocumentEvent): Promise<void>;
  /** Returns the user's documents from the userId-createdAt GSI, newest first. */
  queryUserDocuments(userId: string): Promise<DocumentItem[]>;
  /** Reads one document with consistent read semantics. */
  getDocument(documentId: string): Promise<DocumentItem | undefined>;
  /** Returns the audit trail of one document in chronological order. */
  queryDocumentEvents(documentId: string): Promise<DocumentEvent[]>;
  /** Creates a pre-signed S3 PUT URL for the given key and content type. */
  presignUpload(key: string, contentType: string): Promise<string>;
}

/** Builds the production AWS service using SDK v3 clients. */
export function createAwsService(config: Config): AwsService {
  const ddbClient = new DynamoDBClient({
    region: config.awsRegion,
    maxAttempts: 2,
    ...(config.ddbEndpointUrl !== undefined ? { endpoint: config.ddbEndpointUrl } : {}),
  });
  const ddb = DynamoDBDocumentClient.from(ddbClient, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const s3 = new S3Client({
    region: config.awsRegion,
    maxAttempts: 2,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  return {
    /** Lee una clave fija para confirmar que DynamoDB responde (sin crear datos). */
    async healthCheck(): Promise<void> {
      await ddb.send(
        new GetCommand({
          TableName: config.ddbTable,
          Key: { documentId: 'health-check' },
        }),
      );
    },

    /**
     * Writes the document and its first audit event.
     *
     * With transactions (default) both items are committed or neither is: the state and the
     * audit trail can never disagree. The document condition also makes creation idempotent: a
     * duplicate documentId fails instead of overwriting an existing document.
     *
     * DDB_TRANSACTIONS=false is the Sandbox escape hatch: if the SCP denies TransactWriteItems,
     * the two PutItems run in sequence. The event is written after the document, so a failure
     * between them leaves a document without its PENDING event (documented in architecture, 12).
     */
    async createDocument(item: DocumentItem, event: DocumentEvent): Promise<void> {
      const documentPut = {
        TableName: config.ddbTable,
        Item: item,
        ConditionExpression: 'attribute_not_exists(documentId)',
      };
      const eventPut = {
        TableName: config.ddbEventsTable,
        Item: event,
        // La clave es (documentId, eventAt): la condición protege esa clave exacta, no impide
        // que el documento tenga otros eventos. El sufijo aleatorio de eventAt evita colisiones.
        ConditionExpression: 'attribute_not_exists(eventAt)',
      };

      if (config.ddbTransactions) {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [{ Put: documentPut }, { Put: eventPut }],
          }),
        );
        return;
      }

      await ddb.send(new PutCommand(documentPut));
      await ddb.send(new PutCommand(eventPut));
    },

    /** Devuelve los documentos del usuario, más recientes primero (límite 50). */
    async queryUserDocuments(userId: string): Promise<DocumentItem[]> {
      const output = await ddb.send(
        new QueryCommand({
          TableName: config.ddbTable,
          IndexName: GSI_NAME,
          KeyConditionExpression: '#userId = :userId',
          ExpressionAttributeNames: { '#userId': 'userId' },
          ExpressionAttributeValues: { ':userId': userId },
          ScanIndexForward: false, // false: del más reciente al más antiguo
          Limit: DOCUMENT_LIST_LIMIT,
        }),
      );
      return (output.Items ?? []) as DocumentItem[];
    },

    /** Lee un documento con lectura fuertemente consistente (no una copia del GSI atrasada). */
    async getDocument(documentId: string): Promise<DocumentItem | undefined> {
      const output = await ddb.send(
        new GetCommand({
          TableName: config.ddbTable,
          Key: { documentId },
          ConsistentRead: true, // el worker y el endpoint de detalle leen el estado vigente, no una réplica
        }),
      );
      return output.Item as DocumentItem | undefined;
    },

    /** Devuelve la bitácora del documento en orden cronológico (ascendente, máx. 200). */
    async queryDocumentEvents(documentId: string): Promise<DocumentEvent[]> {
      const output = await ddb.send(
        new QueryCommand({
          TableName: config.ddbEventsTable,
          KeyConditionExpression: '#documentId = :documentId',
          ExpressionAttributeNames: { '#documentId': 'documentId' },
          ExpressionAttributeValues: { ':documentId': documentId },
          ScanIndexForward: true, // true: del evento más antiguo al más reciente (orden de la bitácora)
          Limit: EVENT_LIST_LIMIT,
        }),
      );
      return (output.Items ?? []) as DocumentEvent[];
    },

    /** Devuelve una URL firmada (SigV4) válida 900 s para subir directo a S3 desde el navegador. */
    async presignUpload(key: string, contentType: string): Promise<string> {
      return getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: config.docsBucket,
          Key: key,
          ContentType: contentType,
        }),
        {
          expiresIn: PRESIGN_EXPIRES_SECONDS,
          // Solo content-type se firma: el navegador debe enviar exactamente el mismo
          // Content-Type declarado o S3 rechaza la subida.
          signableHeaders: new Set(['content-type']),
        },
      );
    },
  };
}
