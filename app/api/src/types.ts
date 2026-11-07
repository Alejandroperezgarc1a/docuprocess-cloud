import 'express';

/** Document status values defined by the integration contract. */
export type DocumentStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';

/** DynamoDB document item stored in the documents table. */
export interface DocumentItem {
  documentId: string;
  userId: string;
  filename: string;
  contentType: string;
  s3Key: string;
  status: DocumentStatus;
  createdAt: string;
  updatedAt: string;
  result?: Record<string, unknown>;
  error?: string;
}

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}
