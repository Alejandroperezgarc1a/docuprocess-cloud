/**
 * Shared data types for the DocuProcess Cloud API: document state and the
 * immutable audit events stored in DynamoDB, plus Express request extensions.
 */
import 'express';

/** Document status values defined by the integration contract. */
export type DocumentStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';

/** DynamoDB document item stored in the documents table.
 * Current state of the document: overwritten on every transition (not history). */
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

/** Immutable audit event stored in the document_events table.
 * Append-only audit log: once written, the event is never modified or deleted.
 * Key: (documentId, eventAt). eventAt carries a random suffix so two events in
 * the same millisecond don't collide and overwrite each other. */
export interface DocumentEvent {
  documentId: string;
  /** Sort key: ISO-8601 UTC with milliseconds plus a random suffix (`...#a1b2c3`). */
  eventAt: string;
  eventId: string;
  userId: string;
  /** UTC day (YYYY-MM-DD) used by the day-eventAt GSI.
   * Materialized in the item because DynamoDB does not allow functions in GSI keys. */
  eventDay: string;
  /** Absent on the creation event (there is no previous state). */
  fromStatus?: DocumentStatus;
  toStatus: DocumentStatus;
  /** Who produced it: 'api' (registration), 'worker' (processing) or 'system' (maintenance). */
  actor: DocumentEventActor;
  reason?: string;
  error?: string;
  requestId?: string;
  /** Event schema version; lets the format evolve without breaking readers. */
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
