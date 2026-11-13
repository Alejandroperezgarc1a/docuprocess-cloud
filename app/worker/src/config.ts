import { hostname } from 'node:os';

/** Configuracion validada del worker. */
export interface WorkerConfig {
  docsBucket: string;
  ddbTable: string;
  ddbEventsTable: string;
  awsRegion: string;
  snsTopicArn: string;
  ddbEndpointUrl?: string;
  ddbTransactions: boolean;
  pollSeconds: number;
  batchSize: number;
  uploadTimeoutMinutes: number;
  /** Minutos que un documento puede quedar en PROCESSING antes de marcarlo FAILED. */
  processingTimeoutMinutes: number;
  maxFileBytes: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  workerId: string;
}

const REQUIRED_ENV = ['DOCS_BUCKET', 'DDB_TABLE', 'DDB_EVENTS_TABLE', 'AWS_REGION'];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = (env[name] ?? '').trim();
  if (raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} debe ser un entero entre ${min} y ${max}`);
  }
  return value;
}

function readLogLevel(env: Record<string, string | undefined>): WorkerConfig['logLevel'] {
  const raw = (env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (raw !== 'debug' && raw !== 'info' && raw !== 'warn' && raw !== 'error') {
    throw new ConfigError('LOG_LEVEL debe ser debug, info, warn o error');
  }
  return raw;
}

/** Carga la configuracion desde el entorno y falla rapido si no es valida. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): WorkerConfig {
  const missing = REQUIRED_ENV.filter((name) => (env[name] ?? '').trim() === '');
  if (missing.length > 0) {
    throw new ConfigError(
      `Faltan variables de entorno obligatorias: ${[...missing].sort().join(', ')}`,
    );
  }

  const transactionsRaw = (env.DDB_TRANSACTIONS ?? 'true').trim().toLowerCase();
  if (transactionsRaw !== 'true' && transactionsRaw !== 'false') {
    throw new ConfigError('DDB_TRANSACTIONS debe ser true o false');
  }

  const maxFileMb = readInt(env, 'MAX_FILE_MB', 10, 1, 100);
  const pollSeconds = readInt(env, 'WORKER_POLL_SECONDS', 5, 1, 3600);
  const batchSize = readInt(env, 'WORKER_BATCH_SIZE', 10, 1, 100);
  const uploadTimeoutMinutes = readInt(env, 'UPLOAD_TIMEOUT_MINUTES', 15, 1, 1440);
  const processingTimeoutMinutes = readInt(
    env,
    'PROCESSING_TIMEOUT_MINUTES',
    30,
    1,
    10080,
  );

  const workerId =
    (env.WORKER_ID ?? '').trim() || `${hostname()}:${process.pid}`;

  return {
    docsBucket: (env.DOCS_BUCKET ?? '').trim(),
    ddbTable: (env.DDB_TABLE ?? '').trim(),
    ddbEventsTable: (env.DDB_EVENTS_TABLE ?? '').trim(),
    awsRegion: (env.AWS_REGION ?? '').trim(),
    snsTopicArn: (env.SNS_TOPIC_ARN ?? '').trim(),
    ...((env.DDB_ENDPOINT_URL ?? '').trim() !== ''
      ? { ddbEndpointUrl: (env.DDB_ENDPOINT_URL ?? '').trim() }
      : {}),
    ddbTransactions: transactionsRaw === 'true',
    pollSeconds,
    batchSize,
    uploadTimeoutMinutes,
    processingTimeoutMinutes,
    maxFileBytes: maxFileMb * 1024 * 1024,
    logLevel: readLogLevel(env),
    workerId,
  };
}
