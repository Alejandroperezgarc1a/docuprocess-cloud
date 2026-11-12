/** Runtime configuration loaded from environment variables. */
export interface Config {
  docsBucket: string;
  ddbTable: string;
  ddbEventsTable: string;
  /** When false, state and audit event are written sequentially (Sandbox fallback). */
  // Por qué: el alta debe escribir documento + evento de forma atómica. Si una SCP
  // deniega las escrituras transaccionales, DDB_TRANSACTIONS=false permite seguir operando (sin
  // atomicidad) en vez de bloquear toda la plataforma.
  ddbTransactions: boolean;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  jwtSecret: string;
  awsRegion: string;
  ddbEndpointUrl?: string;
  corsAllowedOrigins: readonly string[];
}

const REQUIRED_ENV = [
  'DOCS_BUCKET',
  'DDB_TABLE',
  // Obligatoria a propósito: sin la tabla de eventos la API arrancaba "a medias"
  // (subidas sin bitácora). Fallar rápido al arranque es preferible a datos huérfanos.
  'DDB_EVENTS_TABLE',
  'DB_HOST',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'JWT_SECRET',
  'AWS_REGION',
] as const;

/** Raised when the environment configuration is missing or invalid. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Loads and validates the configuration from environment variables.
 * Fails fast when a required variable is missing or a value is invalid.
 * Secret values are never included in error messages.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Config {
  const values: Record<string, string> = {};
  const missing: string[] = [];

  for (const name of REQUIRED_ENV) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') {
      missing.push(name);
    } else {
      values[name] = raw;
    }
  }

  if (missing.length > 0) {
    throw new ConfigError(
      `Faltan variables de entorno obligatorias: ${[...missing].sort().join(', ')}`,
    );
  }

  const jwtSecret = values.JWT_SECRET ?? '';
  if (jwtSecret.length < 32) {
    throw new ConfigError('JWT_SECRET debe tener al menos 32 caracteres');
  }

  const portRaw = (env.DB_PORT ?? '3306').trim();
  const dbPort = Number(portRaw);
  if (!Number.isInteger(dbPort)) {
    throw new ConfigError('DB_PORT debe ser un numero entero');
  }
  if (dbPort < 1 || dbPort > 65535) {
    throw new ConfigError('DB_PORT debe estar entre 1 y 65535');
  }

  // Default 'true': la atomicidad es el comportamiento normal; false es solo el
  // escape hatch del Sandbox (ver docs/architecture.md, sección 12). Se valida de
  // forma estricta para no aceptar typos como 'si' o '1'.
  const transactionsRaw = (env.DDB_TRANSACTIONS ?? 'true').trim().toLowerCase();
  if (transactionsRaw !== 'true' && transactionsRaw !== 'false') {
    throw new ConfigError('DDB_TRANSACTIONS debe ser true o false');
  }

  const ddbEndpointUrl = (env.DDB_ENDPOINT_URL ?? '').trim() || undefined;
  const corsAllowedOrigins = (env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  return {
    docsBucket: (values.DOCS_BUCKET ?? '').trim(),
    ddbTable: (values.DDB_TABLE ?? '').trim(),
    ddbEventsTable: (values.DDB_EVENTS_TABLE ?? '').trim(),
    ddbTransactions: transactionsRaw === 'true',
    dbHost: (values.DB_HOST ?? '').trim(),
    dbPort,
    dbName: (values.DB_NAME ?? '').trim(),
    dbUser: (values.DB_USER ?? '').trim(),
    dbPassword: values.DB_PASSWORD ?? '',
    jwtSecret,
    awsRegion: (values.AWS_REGION ?? '').trim(),
    ddbEndpointUrl,
    corsAllowedOrigins,
  };
}
