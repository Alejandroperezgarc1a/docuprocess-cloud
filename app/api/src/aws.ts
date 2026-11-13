/**
 * AWS integration layer for the DocuProcess Cloud API: DynamoDB document/event
 * tables and pre-signed S3 upload URLs.
 */
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

// GSIs (global secondary indexes) are prebuilt queries: DynamoDB does not allow
// free-form WHERE, so each access pattern has its index (docs/rds-vs-dynamodb.md).
// These limits avoid huge responses and unexpected costs.
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
    /** Reads a fixed key to confirm DynamoDB responds (creates no data). */
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
     * DDB_TRANSACTIONS=false is the Sandbox escape hatch: if the SCP denies the transactional
     * writes, the two PutItems run in sequence. The event is written after the document, so a failure
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
        // The key is (documentId, eventAt): the condition protects that exact key only; it
        // does not stop the document from having other events. The random suffix in eventAt
        // avoids collisions.
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

    /** Returns the user's documents, newest first (limit 50). */
    async queryUserDocuments(userId: string): Promise<DocumentItem[]> {
      const output = await ddb.send(
        new QueryCommand({
          TableName: config.ddbTable,
          IndexName: GSI_NAME,
          KeyConditionExpression: '#userId = :userId',
          ExpressionAttributeNames: { '#userId': 'userId' },
          ExpressionAttributeValues: { ':userId': userId },
          ScanIndexForward: false, // false: newest first
          Limit: DOCUMENT_LIST_LIMIT,
        }),
      );
      return (output.Items ?? []) as DocumentItem[];
    },

    /** Reads one document with strongly consistent read (not a stale GSI copy). */
    async getDocument(documentId: string): Promise<DocumentItem | undefined> {
      const output = await ddb.send(
        new GetCommand({
          TableName: config.ddbTable,
          Key: { documentId },
          ConsistentRead: true, // the worker and the detail endpoint read current state, not a replica
        }),
      );
      return output.Item as DocumentItem | undefined;
    },

    /** Returns the document audit trail in chronological order (ascending, max 200). */
    async queryDocumentEvents(documentId: string): Promise<DocumentEvent[]> {
      const output = await ddb.send(
        new QueryCommand({
          TableName: config.ddbEventsTable,
          KeyConditionExpression: '#documentId = :documentId',
          ExpressionAttributeNames: { '#documentId': 'documentId' },
          ExpressionAttributeValues: { ':documentId': documentId },
          ScanIndexForward: true, // true: oldest event first (audit log order)
          Limit: EVENT_LIST_LIMIT,
        }),
      );
      return (output.Items ?? []) as DocumentEvent[];
    },

    /** Returns a SigV4 pre-signed URL valid for 900 s to upload straight to S3 from the browser. */
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
          // Only content-type is signed: the browser must send exactly the same
          // declared Content-Type or S3 rejects the upload.
          signableHeaders: new Set(['content-type']),
        },
      );
    },
  };
}
