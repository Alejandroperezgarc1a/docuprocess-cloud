/**
 * Per-item processing pipeline for the DocuProcess Cloud worker: claim,
 * download, metadata extraction, terminal transition and SNS notification.
 */
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { AwsService, ObjectHead } from './aws.js';
import type { WorkerConfig } from './config.js';
import {
  extractMetadata,
  FileTooLargeError,
  PermanentProcessingError,
} from './extract.js';
import { errorFields, type Logger } from './logger.js';
import { buildPayload, buildEmail } from './notify.js';
import type {
  DocumentItem,
  DocumentResult,
  DocumentStatus,
} from './types.js';

export interface ProcessDeps {
  aws: AwsService;
  config: WorkerConfig;
  logger: Logger;
  /** Injectable in tests to control the timeout window. */
  now?: () => Date;
  /** Base directory for temp files; defaults to os.tmpdir(). */
  tempRoot?: string;
}

interface TempFile {
  dir: string;
  filePath: string;
}

function ageInMinutes(createdAt: string, now: Date): number {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) {
    return Number.POSITIVE_INFINITY;
  }
  return (now.getTime() - created) / 60_000;
}

/** Timestamp of each transition; the item's start time is not reused. */
function currentIso(deps: ProcessDeps): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

function failureMessage(error: unknown): string {
  if (error instanceof PermanentProcessingError) {
    return error.message;
  }
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return 's3 timeout';
    }
    return 'processing failed';
  }
  return 'processing failed';
}

async function downloadToTemp(
  stream: Readable,
  maxBytes: number,
  tempRoot?: string,
): Promise<TempFile> {
  const dir = await mkdtemp(join(tempRoot ?? tmpdir(), 'docuprocess-worker-'));
  const filePath = join(dir, 'document');
  const handle = await open(filePath, 'wx', 0o600);
  let total = 0;

  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > maxBytes) {
        throw new FileTooLargeError();
      }

      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(
          buffer,
          offset,
          buffer.length - offset,
        );
        if (bytesWritten <= 0) {
          throw new Error('No se pudo escribir el archivo temporal');
        }
        offset += bytesWritten;
      }
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  await handle.close();
  return { dir, filePath };
}

async function notify(
  deps: ProcessDeps,
  item: DocumentItem,
  status: DocumentStatus,
  error?: string,
  result?: DocumentResult,
): Promise<void> {
  const payload = buildPayload(item, status, error);
  const emailBody = result && status === 'DONE' ? buildEmail(item, status, error, result) : undefined;
  try {
    await deps.aws.publish(payload, emailBody);
    deps.logger.info('sns_published', {
      documentId: item.documentId,
      status,
    });
  } catch (publishError) {
    // The transition is already persisted; SNS is at-least-once and is not reverted.
    deps.logger.error('sns_failed', {
      documentId: item.documentId,
      status,
      ...errorFields(publishError),
    });
  }
}

async function handleMissingObject(
  deps: ProcessDeps,
  item: DocumentItem,
  now: Date,
  head: ObjectHead,
): Promise<boolean> {
  if (ageInMinutes(item.createdAt, now) < deps.config.uploadTimeoutMinutes) {
    deps.logger.info('upload_pending', {
      documentId: item.documentId,
      reason: head.reason ?? 'not_found',
    });
    return false;
  }

  const transitioned = await deps.aws.failPending(
    item,
    'upload timeout',
    currentIso(deps),
  );
  if (!transitioned) {
    deps.logger.info('upload_timeout_claim_lost', {
      documentId: item.documentId,
    });
    return false;
  }

  deps.logger.warn('upload_timeout', { documentId: item.documentId });
  await notify(deps, item, 'FAILED', 'upload timeout');
  return true;
}

/**
 * Processes a PENDING item. Returns true if this instance claimed it and
 * brought it to a terminal state; false if it was skipped (still uploading,
 * no file yet, or claimed by another worker).
 */
export async function processItem(
  item: DocumentItem,
  deps: ProcessDeps,
): Promise<boolean> {
  const started = Date.now();
  const now = deps.now?.() ?? new Date();

  let head: ObjectHead;
  try {
    head = await deps.aws.headObject(item.s3Key);
  } catch (error) {
    deps.logger.error('head_object_failed', {
      documentId: item.documentId,
      ...errorFields(error),
    });
    return false;
  }

  if (!head.exists) {
    return handleMissingObject(deps, item, now, head);
  }

  if (
    head.sizeBytes !== undefined &&
    head.sizeBytes > deps.config.maxFileBytes
  ) {
    const claimed = await deps.aws.claim(item, currentIso(deps));
    if (!claimed) {
      deps.logger.info('claim_lost', { documentId: item.documentId });
      return false;
    }
    const message = new FileTooLargeError().message;
    try {
      const failed = await deps.aws.fail(item, message, currentIso(deps));
      if (failed) {
        deps.logger.warn('file_too_large', {
          documentId: item.documentId,
          sizeBytes: head.sizeBytes,
        });
        await notify(deps, item, 'FAILED', message);
      }
    } catch (error) {
      deps.logger.error('fail_transition_failed', {
        documentId: item.documentId,
        ...errorFields(error),
      });
    }
    deps.logger.info('item_processed', {
      documentId: item.documentId,
      status: 'FAILED',
      durationMs: Date.now() - started,
    });
    return true;
  }

  const claimed = await deps.aws.claim(item, currentIso(deps));
  if (!claimed) {
    deps.logger.info('claim_lost', { documentId: item.documentId });
    return false;
  }

  deps.logger.info('item_claimed', { documentId: item.documentId });
  let temp: TempFile | undefined;

  try {
    const object = await deps.aws.getObjectStream(item.s3Key);
    if (
      object.contentLength !== undefined &&
      object.contentLength > deps.config.maxFileBytes
    ) {
      throw new FileTooLargeError();
    }

    temp = await downloadToTemp(
      object.stream,
      deps.config.maxFileBytes,
      deps.tempRoot,
    );
    const result: DocumentResult = await extractMetadata(
      temp.filePath,
      item.contentType,
      deps.config.maxFileBytes,
    );

    if (result.mimeType !== item.contentType) {
      deps.logger.warn('mime_type_mismatch', {
        documentId: item.documentId,
        declaredContentType: item.contentType,
        detectedMimeType: result.mimeType,
      });
    }

    const completed = await deps.aws.complete(item, result, currentIso(deps));
    if (!completed) {
      deps.logger.info('complete_claim_lost', {
        documentId: item.documentId,
      });
      return true;
    }

    await notify(deps, item, 'DONE', undefined, result);
    deps.logger.info('item_processed', {
      documentId: item.documentId,
      status: 'DONE',
      durationMs: Date.now() - started,
    });
    return true;
  } catch (error) {
    deps.logger.error('processing_failed', {
      documentId: item.documentId,
      ...errorFields(error),
    });

    const message = failureMessage(error);
    try {
      const failed = await deps.aws.fail(item, message, currentIso(deps));
      if (failed) {
        await notify(deps, item, 'FAILED', message);
      } else {
        deps.logger.info('fail_claim_lost', {
          documentId: item.documentId,
        });
      }
    } catch (failError) {
      deps.logger.error('fail_transition_failed', {
        documentId: item.documentId,
        ...errorFields(failError),
      });
    }

    deps.logger.info('item_processed', {
      documentId: item.documentId,
      status: 'FAILED',
      durationMs: Date.now() - started,
    });
    return true;
  } finally {
    if (temp !== undefined) {
      await rm(temp.dir, { recursive: true, force: true }).catch((error) => {
        deps.logger.warn('temp_cleanup_failed', {
          documentId: item.documentId,
          ...errorFields(error),
        });
      });
    }
  }
}
