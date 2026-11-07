import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from './config.js';
import type { DocumentItem } from './types.js';

const GSI_NAME = 'userId-createdAt';
const DOCUMENT_LIST_LIMIT = 50;
const PRESIGN_EXPIRES_SECONDS = 900;

/** AWS operations required by the documents layer. */
export interface AwsService {
  /** Verifies that the DynamoDB table is reachable. */
  healthCheck(): Promise<void>;
  /** Stores a document item in DynamoDB. */
  putDocument(item: DocumentItem): Promise<void>;
  /** Returns the user's documents from the userId-createdAt GSI, newest first. */
  queryUserDocuments(userId: string): Promise<DocumentItem[]>;
  /** Reads one document with consistent read semantics. */
  getDocument(documentId: string): Promise<DocumentItem | undefined>;
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
  const s3 = new S3Client({ region: config.awsRegion, maxAttempts: 2 });

  return {
    /** Reads a fixed key to confirm that DynamoDB responds. */
    async healthCheck(): Promise<void> {
      await ddb.send(
        new GetCommand({
          TableName: config.ddbTable,
          Key: { documentId: 'health-check' },
        }),
      );
    },

    /** Writes the document item to the configured table. */
    async putDocument(item: DocumentItem): Promise<void> {
      await ddb.send(
        new PutCommand({
          TableName: config.ddbTable,
          Item: item,
        }),
      );
    },

    /** Queries the user's documents with a descending sort and a limit of 50. */
    async queryUserDocuments(userId: string): Promise<DocumentItem[]> {
      const output = await ddb.send(
        new QueryCommand({
          TableName: config.ddbTable,
          IndexName: GSI_NAME,
          KeyConditionExpression: '#userId = :userId',
          ExpressionAttributeNames: { '#userId': 'userId' },
          ExpressionAttributeValues: { ':userId': userId },
          ScanIndexForward: false,
          Limit: DOCUMENT_LIST_LIMIT,
        }),
      );
      return (output.Items ?? []) as DocumentItem[];
    },

    /** Fetches one document using ConsistentRead. */
    async getDocument(documentId: string): Promise<DocumentItem | undefined> {
      const output = await ddb.send(
        new GetCommand({
          TableName: config.ddbTable,
          Key: { documentId },
          ConsistentRead: true,
        }),
      );
      return output.Item as DocumentItem | undefined;
    },

    /** Returns a SigV4 pre-signed URL valid for 900 seconds. */
    async presignUpload(key: string, contentType: string): Promise<string> {
      return getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: config.docsBucket,
          Key: key,
          ContentType: contentType,
        }),
        { expiresIn: PRESIGN_EXPIRES_SECONDS },
      );
    },
  };
}
