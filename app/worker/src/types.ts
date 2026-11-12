/** Contratos compartidos con la API (C1/B3). */

export type DocumentStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'FAILED';

/** Estado actual de un documento en la tabla `documents`. */
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

/** Metadatos extraidos del archivo real. */
export interface DocumentResult {
  sizeBytes: number;
  mimeType: string;
  sha256: string;
  pages?: number;
  width?: number;
  height?: number;
}

/** Evento append-only de `document_events` (contrato B3). */
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

/** Cuerpo JSON que se publica en SNS. */
export interface NotificationPayload {
  documentId: string;
  userId: string;
  filename: string;
  status: DocumentStatus;
  error?: string;
}
