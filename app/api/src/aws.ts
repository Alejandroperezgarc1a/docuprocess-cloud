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

export interface AwsService {
  healthCheck(): Promise<void>;
  putDocument(item: DocumentItem): Promise<void>;
  queryUserDocuments(userId: string): Promise<DocumentItem[]>;
  getDocument(documentId: string): Promise<DocumentItem | undefined>;
  presignUpload(key: string, contentType: string): Promise<string>;
}

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
    async healthCheck(): Promise<void> {
      await ddb.send(
        new GetCommand({
          TableName: config.ddbTable,
          Key: { documentId: 'health-check' },
        }),
      );
    },

    async putDocument(item: DocumentItem): Promise<void> {
      await ddb.send(
        new PutCommand({
          TableName: config.ddbTable,
          Item: item,
        }),
      );
    },

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
