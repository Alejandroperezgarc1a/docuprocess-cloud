import type {
  DocumentItem,
  DocumentResult,
  DocumentStatus,
  NotificationPayload,
} from './types.js';

const SNS_SUBJECT_MAX = 100;

/** Elimina caracteres de control que rompen el subject de SNS. */
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
 * Subject de SNS: `DocuProcess: <filename> <status>`.
 * El limite de SNS es 100 caracteres; el filename puede tener 200.
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

/** Cuerpo JSON del contrato de C1. */
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

/** Plantilla de correo para la suscripción de SNS. */
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

    ...(result?.metadata?.pdf?.title
      ? [`  Título PDF: ${result.metadata.pdf.title}`]
      : []),

    ...(result?.summary
      ? [
          '',
          '  Resumen:',
          ...result.summary
            .replace(/\s+/g, ' ')
            .match(/.{1,72}(\s|$)/g)
            ?.map((line) => `    ${line.trim()}`) ?? [`    ${result.summary}`],
        ]
      : []),

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

/** Formatea bytes a `1.2 MB` (es-CO, 1 decimal). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export { formatBytes };