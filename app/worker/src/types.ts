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

export interface FileMetadata {
  extension: string;
  sizeBytes: number;
  mimeType: string;
  sha256: string;
  sha1: string;
  md5: string;
}

export interface PdfPageSize {
  page: number;
  width: number;
  height: number;
}

export interface PdfMetadata {
  version?: string;
  pages: number;
  pageSizes?: PdfPageSize[];
  uniformPageSize?: { width: number; height: number };
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
  encrypted: boolean;
  hasForm: boolean;
  linearized: boolean;
}

export interface GpsMetadata {
  latitude: number;
  longitude: number;
  altitude?: number;
}

export interface ExifMetadata {
  make?: string;
  model?: string;
  lensModel?: string;
  software?: string;
  artist?: string;
  copyright?: string;
  description?: string;
  dateTimeOriginal?: string;
  createDate?: string;
  modifyDate?: string;
  exposureTime?: number;
  fNumber?: number;
  iso?: number;
  focalLength?: number;
  focalLength35mm?: number;
  orientation?: number;
  colorSpace?: string;
  flash?: string;
  whiteBalance?: string;
  meteringMode?: string;
  exposureProgram?: string;
}

export interface TextChunk {
  keyword: string;
  text: string;
}

export interface ImageMetadata {
  format: string;
  width: number;
  height: number;
  aspectRatio?: number;
  megapixels?: number;
  colorType?: string;
  bitDepth?: number;
  hasAlpha?: boolean;
  interlaced?: boolean;
  dpi?: number;
  textChunks?: TextChunk[];
  exif?: ExifMetadata;
  gps?: GpsMetadata;
}

export interface TextMetadata {
  source: 'txt' | 'pdf';
  encoding: string;
  bom: boolean;
  newline: string;
  lines: number;
  words: number;
  characters: number;
  paragraphs: number;
  pagesAnalyzed?: number;
  truncated: boolean;
  preview?: string;
}

export interface SourceMetadata {
  eTag?: string;
  versionId?: string;
  storageClass?: string;
  serverSideEncryption?: string;
  lastModified?: string;
}

export interface DocumentMetadata {
  file: FileMetadata;
  pdf?: PdfMetadata;
  image?: ImageMetadata;
  text?: TextMetadata;
  source?: SourceMetadata;
  metadataTruncated?: boolean;
}

/** Metadatos extraidos del archivo real. */
export interface DocumentResult {
  sizeBytes: number;
  mimeType: string;
  sha256: string;
  sha1?: string;
  md5?: string;
  pages?: number;
  width?: number;
  height?: number;
  /** Resumen extractivo del texto (solo TXT y PDF con texto seleccionable). */
  summary?: string;
  metadataVersion?: number;
  processedAt?: string;
  processingMs?: number;
  metadata?: DocumentMetadata;
  /** true si el resultado se recorto para caber en el limite de DynamoDB. */
  metadataTruncated?: boolean;
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
