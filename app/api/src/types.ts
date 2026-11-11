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

/** Who produced a state transition (audit trail). */
export type DocumentEventActor = 'api' | 'worker' | 'system';

/** Immutable audit event stored in the document_events table. */
export interface DocumentEvent {
  documentId: string;
  /** Sort key: ISO-8601 UTC with milliseconds plus a random suffix. */
  eventAt: string;
  eventId: string;
  userId: string;
  /** UTC day (YYYY-MM-DD) used by the day-eventAt GSI. */
  eventDay: string;
  fromStatus?: DocumentStatus;
  toStatus: DocumentStatus;
  actor: DocumentEventActor;
  reason?: string;
  error?: string;
  requestId?: string;
  schemaVersion: number;
}

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}
