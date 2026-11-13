import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAwsService, type AwsService } from './aws.js';
import { ConfigError, loadConfig, type WorkerConfig } from './config.js';
import { createLogger, errorFields, type Logger } from './logger.js';
import { processItem } from './process.js';

export interface RunWorkerOptions {
  /** Se consulta antes de reclamar el siguiente item y durante el poll. */
  isStopping?: () => boolean;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal?.aborted === true) {
      resolveSleep();
      return;
    }

    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolveSleep();
    };
    const onAbort = (): void => finish();
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Bucle principal. Nunca deja que el fallo de un item detenga el worker.
 * El limite de la query es mayor que el batch para no quedar bloqueado por
 * documentos PENDING que aun no tienen archivo en S3.
 */
export async function runWorker(
  config: WorkerConfig,
  aws: AwsService,
  logger: Logger,
  options: RunWorkerOptions = {},
): Promise<void> {
  const isStopping = options.isStopping ?? (() => false);
  const queryLimit = Math.min(config.batchSize * 3, 300);
  let lastReap = 0;

  while (!isStopping()) {
    let items: Awaited<ReturnType<AwsService['queryPending']>>;
    try {
      items = await aws.queryPending(queryLimit);
    } catch (error) {
      logger.error('query_pending_failed', errorFields(error));
      await sleep(config.pollSeconds * 1000, options.signal);
      continue;
    }

    let claimed = 0;
    for (const item of items) {
      if (isStopping() || claimed >= config.batchSize) {
        break;
      }
      try {
        if (await processItem(item, { aws, config, logger })) {
          claimed += 1;
        }
      } catch (error) {
        // Defensa adicional: processItem ya captura sus errores.
        logger.error('item_unhandled_error', {
          documentId: item.documentId,
          ...errorFields(error),
        });
      }
    }

    // Reaper de PROCESSING huerfanos: a lo sumo una vez por minuto, nunca bloqueante.
    if (Date.now() - lastReap >= 60_000) {
      lastReap = Date.now();
      try {
        const staleBefore = new Date(
          Date.now() - config.processingTimeoutMinutes * 60_000,
        ).toISOString();
        const reaped = await aws.reapStaleProcessing(
          new Date().toISOString(),
          staleBefore,
        );
        if (reaped > 0) {
          logger.warn('processing_reaper', { reaped });
        }
      } catch (error) {
        logger.error('processing_reaper_failed', errorFields(error));
      }
    }

    if (!isStopping()) {
      await sleep(config.pollSeconds * 1000, options.signal);
    }
  }
}

async function main(): Promise<void> {
  let config: WorkerConfig;
  try {
    config = loadConfig();
  } catch (error) {
    const message =
      error instanceof ConfigError || error instanceof Error
        ? error.message
        : String(error);
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'config_error',
        errorMessage: message,
      }),
    );
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config.logLevel, { workerId: config.workerId });
  const aws = createAwsService(config, logger);
  const controller = new AbortController();
  let stopping = false;

  const requestStop = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info('shutdown_requested', { signal });
    controller.abort();
  };

  process.once('SIGTERM', () => requestStop('SIGTERM'));
  process.once('SIGINT', () => requestStop('SIGINT'));

  logger.info('worker_started', {
    docsBucket: config.docsBucket,
    ddbTable: config.ddbTable,
    ddbEventsTable: config.ddbEventsTable,
    pollSeconds: config.pollSeconds,
    batchSize: config.batchSize,
    uploadTimeoutMinutes: config.uploadTimeoutMinutes,
    processingTimeoutMinutes: config.processingTimeoutMinutes,
    maxFileBytes: config.maxFileBytes,
    snsEnabled: config.snsTopicArn !== '',
    ddbTransactions: config.ddbTransactions,
  });

  try {
    await runWorker(config, aws, logger, {
      isStopping: () => stopping,
      signal: controller.signal,
    });
    logger.info('worker_stopped');
    process.exit(0);
  } catch (error) {
    logger.error('worker_fatal_error', errorFields(error));
    process.exit(1);
  }
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  void main();
}
