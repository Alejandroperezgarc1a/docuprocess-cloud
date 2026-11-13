/** JSON logger to stdout for the DocuProcess Cloud worker (journald on instances). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function serializableError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { errorMessage: String(error) };
  }

  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return {
    errorName: error.name,
    errorMessage: error.message,
    ...(metadata?.httpStatusCode !== undefined
      ? { httpStatusCode: metadata.httpStatusCode }
      : {}),
  };
}

/** Creates a JSON logger to stdout (journald on the instances). */
export function createLogger(
  level: LogLevel,
  base: Record<string, unknown> = {},
): Logger {
  const threshold = ORDER[level];

  const write = (
    entryLevel: LogLevel,
    event: string,
    fields: Record<string, unknown> = {},
  ): void => {
    if (ORDER[entryLevel] < threshold) {
      return;
    }
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: entryLevel,
        event,
        ...base,
        ...fields,
      }),
    );
  };

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

export function errorFields(error: unknown): Record<string, unknown> {
  return serializableError(error);
}
