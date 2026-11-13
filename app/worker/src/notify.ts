/**
 * SNS notification builders for the DocuProcess Cloud worker: subject,
 * JSON payload and email body.
 */
import type {
  DocumentItem,
  DocumentResult,
  DocumentStatus,
  NotificationPayload,
} from './types.js';

const SNS_SUBJECT_MAX = 100;

/** Removes control characters that break the SNS subject. */
function stripControls(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '');
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  if (chars.length <= max) {
    return value;
  }
  return `${chars.slice(0, max - 3).join('')}...`;
}

/**
 * SNS subject: `DocuProcess: <filename> <status>`.
 * The SNS limit is 100 characters; the filename can be 200.
 */
export function buildSubject(
  filename: string,
  status: DocumentStatus,
  documentId?: string,
): string {
  const preferred = stripControls(`DocuProcess: ${filename} ${status}`).trim();
  if (preferred.length > 0) {
    return truncate(preferred, SNS_SUBJECT_MAX);
  }
  return truncate(`DocuProcess: ${documentId ?? 'document'} ${status}`, SNS_SUBJECT_MAX);
}

/** JSON body of the C1 contract. */
export function buildPayload(
  item: DocumentItem,
  status: DocumentStatus,
  error?: string,
): NotificationPayload {
  return {
    documentId: item.documentId,
    userId: item.userId,
    filename: item.filename,
    status,
    ...(status === 'FAILED' && error !== undefined ? { error } : {}),
  };
}

/** Email template for the SNS subscription. */
export function buildEmail(
  item: DocumentItem,
  status: DocumentStatus,
  error?: string,
  result?: DocumentResult,
): string {
  const fecha = new Date().toLocaleDateString('es-CO', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const hora = new Date().toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const tamano = result?.sizeBytes
    ? formatBytes(result.sizeBytes)
    : error
      ? '—'
      : item.filename.includes('.') && !result
        ? '—'
        : '—';

  const tipo = result?.mimeType ?? item.contentType ?? 'application/octet-stream';
  const sha256 = result?.sha256 ?? '—';
  const id = item.documentId;
  const pid = item.documentId;

  const lines = [
    'DOCUPROCESS CLOUD',
    '──────────────────────────────────────',
    '',

    status === 'DONE'
      ? `Tu documento está listo`
      : status === 'FAILED'
        ? `No pudimos procesar tu documento`
        : '',

    '',
    `  Archivo:    ${item.filename}`,
    `  Estado:     ${status}`,

    ...(result?.mimeType
      ? [`  Tipo:       ${tipo}`]
      : []),

    ...(result?.sizeBytes
      ? [`  Tamaño:     ${formatBytes(result.sizeBytes)}`]
      : [`  Tamaño:     ${tamano}`]),

    ...(result?.pages
      ? [`  Páginas:    ${result.pages}`]
      : [
          ...(result?.width && result?.height
            ? [`  Dimensiones: ${result.width} × ${result.height} px`]
            : []),
        ]),

    `  SHA-256:    ${sha256}`,
    `  ID:         ${pid}`,

    ...(status === 'DONE'
      ? [`  Fecha:      ${fecha}, ${hora}`]
      : status === 'FAILED'
        ? [
            '',
            '  Qué puedes hacer:',
            `    • Vuelve a subir el archivo`,
            `    • Corrige el formato`,
          ]
        : []),

    '',
    '──────────────────────────────────────',
    'DocuProcess Cloud',
    'Este correo se envió automáticamente.',
  ];

  return lines.join('\n');
}

/** Formats bytes as `1.2 MB` (es-CO locale, 1 decimal). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export { formatBytes };