import cluster from 'node:cluster';
import { createApp } from './app.js';
import { createAwsService } from './aws.js';
import { ConfigError, loadConfig } from './config.js';
import { createDb } from './db.js';

const PORT = Number(process.env.PORT ?? 8000);

/** Returns the number of workers to fork (WEB_CONCURRENCY, default 2). */
function workerCount(): number {
  const raw = process.env.WEB_CONCURRENCY ?? '2';
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 8) {
    return parsed;
  }
  return 2;
}

/** Starts the HTTP server in the current process and wires graceful shutdown. */
function startWorker(): void {
  const config = loadConfig();
  const db = createDb(config);
  const aws = createAwsService(config);
  const app = createApp({ config, db, aws });

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `${new Date().toISOString()} INFO docuprocess.api: escuchando en 0.0.0.0:${PORT} (pid ${process.pid})`,
    );

  });
  server.keepAliveTimeout = 65000; // más que los 60 s del ALB
  server.headersTimeout = 66000;   // debe ser mayor que keepAliveTimeout

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(
      `${new Date().toISOString()} INFO docuprocess.api: ${signal} recibido, cerrando (pid ${process.pid})`,
    );

  server.keepAliveTimeout = 65000; // más que los 60 s del ALB
  server.headersTimeout = 66000;   // debe ser mayor que keepAliveTimeout
    server.close(() => {
      void db.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 30_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/** Forks the workers and restarts them if they exit unexpectedly. */
function startPrimary(workers: number): void {
  loadConfig();
  for (let index = 0; index < workers; index += 1) {
    cluster.fork();
  }

  let shuttingDown = false;
  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) {
      return;
    }
    console.error(
      `${new Date().toISOString()} ERROR docuprocess.api: worker ${worker.process.pid ?? '?'} termino (code=${code}, signal=${signal}); reiniciando`,
    );

  server.keepAliveTimeout = 65000; // más que los 60 s del ALB
  server.headersTimeout = 66000;   // debe ser mayor que keepAliveTimeout
    cluster.fork();
  });

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(
      `${new Date().toISOString()} INFO docuprocess.api: ${signal} recibido, cerrando workers`,
    );

  server.keepAliveTimeout = 65000; // más que los 60 s del ALB
  server.headersTimeout = 66000;   // debe ser mayor que keepAliveTimeout
    for (const worker of Object.values(cluster.workers ?? {})) {
      worker?.kill('SIGTERM');
    }
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/** Chooses cluster mode or single-process mode based on WEB_CONCURRENCY. */
function main(): void {
  const workers = workerCount();
  if (cluster.isPrimary && workers > 1) {
    startPrimary(workers);
    return;
  }
  startWorker();
}

try {
  main();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(
      `${new Date().toISOString()} ERROR docuprocess.api: configuracion invalida: ${error.message}`,
    );

  server.keepAliveTimeout = 65000; // más que los 60 s del ALB
  server.headersTimeout = 66000;   // debe ser mayor que keepAliveTimeout
    process.exit(1);
  }
  throw error;
}
