/** Contracts shared with the API (C1/B3) for the DocuProcess Cloud worker. */

export type DocumentStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';

/** Current state of a document in the `documents` table. */
export interface DocumentItem {
  documentId: string;
  userId: string;
  filename: string;
  contentType: string;
  s3Key: string;
  status: DocumentStatus;
  createdAt: string;
  updatedAt: string;
  result?: DocumentResult;
  error?: string;
}

/** Metadata extracted from the real file. */
export interface DocumentResult {
  sizeBytes: number;
  mimeType: string;
  sha256: string;
  pages?: number;
  width?: number;
  height?: number;
}

/** Append-only event of `document_events` (contract B3). */
export interface DocumentEvent {
  documentId: string;
  eventAt: string;
  eventId: string;
  userId: string;
  eventDay: string;
  fromStatus?: DocumentStatus;
  toStatus: DocumentStatus;
  actor: 'api' | 'worker' | 'system';
  reason?: string;
  error?: string;
  requestId?: string;
  schemaVersion: number;
}

/** JSON body published to SNS. */
export interface NotificationPayload {
  documentId: string;
  userId: string;
  filename: string;
  status: DocumentStatus;
  error?: string;
}
