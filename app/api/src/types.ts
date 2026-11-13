import 'express';

/** Document status values defined by the integration contract. */
export type DocumentStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';

/** DynamoDB document item stored in the documents table.
 * Estado actual del documento: se REescribe en cada transición (no es historial). */
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
 * Bitácora append-only: una vez escrito, el evento no se modifica ni se borra.
 * Clave: (documentId, eventAt). El eventAt lleva un sufijo aleatorio para que dos
 * eventos del mismo milisegundo no colisionen y se sobrescriban. */
export interface DocumentEvent {
  documentId: string;
  /** Sort key: ISO-8601 UTC with milliseconds plus a random suffix (`...#a1b2c3`). */
  eventAt: string;
  eventId: string;
  userId: string;
  /** UTC day (YYYY-MM-DD) used by the day-eventAt GSI.
   * Materializado en el ítem porque DynamoDB no permite funciones en las claves de un GSI. */
  eventDay: string;
  /** Ausente en el evento de creación (no hay estado anterior). */
  fromStatus?: DocumentStatus;
  toStatus: DocumentStatus;
  /** Quién lo generó: 'api' (alta), 'worker' (procesamiento) o 'system' (mantenimiento). */
  actor: DocumentEventActor;
  reason?: string;
  error?: string;
  requestId?: string;
  /** Versión del esquema del evento; permite evolucionar el formato sin romper lectores. */
  schemaVersion: number;
}

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
      userRole?: string;
      tokenJti?: string;
      tokenExp?: number;
    }
  }
}
