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
  /** Precisión de la posición (DOP). */
  dop?: number;
  /** Velocidad en m/s. */
  speed?: number;
  /** Dirección de la imagen en grados. */
  imgDirection?: number;
  /** Sello de tiempo GPS combinado (fecha + hora). */
  timestamp?: string;
  /** Método de procesamiento GPS. */
  processingMethod?: string;
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
  /** Resolución horizontal en DPI. */
  xResolution?: number;
  /** Resolución vertical en DPI. */
  yResolution?: number;
  /** Unidad de resolución: 2 = pulgadas, 3 = cm. */
  resolutionUnit?: number;
  /** Compensación de exposición en EV. */
  exposureCompensation?: number;
  /** Apertura máxima del objetivo. */
  maxAperture?: number;
  /** Distancia al sujeto en metros. */
  subjectDistance?: number;
  /** Fabricante del objetivo. */
  lensMake?: string;
  /** Número de serie del objetivo. */
  lensSerialNumber?: string;
  /** Número de serie del cuerpo de la cámara. */
  bodySerialNumber?: string;
  /** Tipo de captura de escena. */
  sceneCaptureType?: string;
  /** Contraste: 0=Normal, 1=Suave, 2=Duro. */
  contrast?: number;
  /** Saturación: 0=Normal, 1=Baja, 2=Alta. */
  saturation?: number;
  /** Nitidez: 0=Normal, 1=Suave, 2=Dura. */
  sharpness?: number;
  /** Fuente de luz. */
  lightSource?: string;
  /** Ratio de zoom digital. */
  digitalZoomRatio?: number;
  /** Versión EXIF. */
  exifVersion?: string;
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
  /** Gamma del archivo PNG. */
  gamma?: number;
  /** Intención de renderizado sRGB. */
  srgbIntent?: number;
  /** Si tiene perfil ICC embebido. */
  hasIccProfile?: boolean;
  /** Método de compresión (PNG). */
  compressionMethod?: number;
  /** Método de filtro (PNG). */
  filterMethod?: number;
  /** Marca de tiempo del archivo (chunk tIME). */
  lastModified?: string;
  /** Color de fondo (chunk bKGD). */
  backgroundColor?: string;
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
  /** Palabras únicas (aproximación). */
  uniqueWords?: number;
  /** Media de palabras por oración. */
  avgWordsPerSentence?: number;
  /** Longitud media de frase en caracteres. */
  avgSentenceLength?: number;
  /** Idioma estimado (heurística simple: 'es' | 'en' | 'mixed'). */
  language?: string;
}

export interface SourceMetadata {
  eTag?: string;
  versionId?: string;
  storageClass?: string;
  serverSideEncryption?: string;
  lastModified?: string;
  /** Clave S3 completa (bucket + ruta). */
  key?: string;
  /** MIME declarado por el cliente al subir. */
  declaredMimeType?: string;
  /** true si el MIME declarado difiere del detectado. */
  mimeMismatch?: boolean;
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
  /** Versión del esquema de metadatos (3 = GPS ampliado + EXIF/PNG/texto extra). */
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
