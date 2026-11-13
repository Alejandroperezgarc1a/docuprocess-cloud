/**
 * Entry point of the DocuProcess Cloud worker: loads config, runs the poll
 * loop over the DynamoDB queue and shuts down cleanly on SIGTERM/SIGINT.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAwsService, type AwsService } from './aws.js';
import { ConfigError, loadConfig, type WorkerConfig } from './config.js';
import { createLogger, errorFields, type Logger } from './logger.js';
import { processItem } from './process.js';

export interface RunWorkerOptions {
  /** Checked before claiming the next item and during the poll. */
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
 * Main loop. Never lets the failure of one item stop the worker. The query
 * limit is larger than the batch so the loop is not blocked by PENDING
 * documents that do not have a file in S3 yet.
 */
export async function runWorker(
  config: WorkerConfig,
  aws: AwsService,
  logger: Logger,
  options: RunWorkerOptions = {},
): Promise<void> {
  const isStopping = options.isStopping ?? (() => false);
  const queryLimit = Math.min(config.batchSize * 3, 300);

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
        // Extra defense: processItem already catches its own errors.
        logger.error('item_unhandled_error', {
          documentId: item.documentId,
          ...errorFields(error),
        });
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
