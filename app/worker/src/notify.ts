import type {
  DocumentItem,
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
