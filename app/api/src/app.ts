import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from 'express';
import type { AwsService } from './aws.js';
import { createAwsService } from './aws.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { createDb } from './db.js';
import { HTTP_ERRORS, errorResponse } from './errors.js';

export interface AppDependencies {
  config: Config;
  db?: Db;
  aws?: AwsService;
}

const KNOWN_ROUTES: ReadonlyArray<{ pattern: RegExp; methods: readonly string[] }> = [
  { pattern: /^\/api\/health\/?$/, methods: ['GET'] },
  { pattern: /^\/api\/auth\/register\/?$/, methods: ['POST'] },
  { pattern: /^\/api\/auth\/login\/?$/, methods: ['POST'] },
  { pattern: /^\/api\/documents\/?$/, methods: ['GET', 'POST'] },
  { pattern: /^\/api\/documents\/[^/]+\/?$/, methods: ['GET'] },
];

function requestLogger(): RequestHandler {
  return (req, _res, next) => {
    const started = process.hrtime.bigint();
    _res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      console.log(
        `${new Date().toISOString()} INFO docuprocess.api: ${req.method} ${req.path} -> ${_res.statusCode} (${elapsedMs.toFixed(1)} ms)`,
      );
    });
    next();
  };
}

function corsMiddleware(config: Config): RequestHandler {
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin !== undefined && config.corsAllowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.vary('Origin');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

function notFoundOrMethodNotAllowed(): RequestHandler {
  return (req, res) => {
    const known = KNOWN_ROUTES.some((route) => route.pattern.test(req.path));
    if (known) {
      errorResponse(
        res,
        HTTP_ERRORS[405]?.code ?? 'method_not_allowed',
        HTTP_ERRORS[405]?.message ?? 'Metodo no permitido.',
        405,
      );
      return;
    }
    errorResponse(
      res,
      HTTP_ERRORS[404]?.code ?? 'not_found',
      HTTP_ERRORS[404]?.message ?? 'Recurso no encontrado.',
      404,
    );
  };
}

function errorHandler(): ErrorRequestHandler {
  return (error, _req, res, _next) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { type?: unknown }).type === 'entity.too.large'
    ) {
      errorResponse(
        res,
        'payload_too_large',
        'El cuerpo de la solicitud es demasiado grande.',
        413,
      );
      return;
    }

    if (error instanceof SyntaxError && 'body' in error) {
      errorResponse(
        res,
        'invalid_request',
        'El cuerpo debe ser un objeto JSON.',
        400,
      );
      return;
    }

    console.error(
      `${new Date().toISOString()} ERROR docuprocess.api: error no controlado:`,
      error,
    );
    errorResponse(res, 'internal_error', 'Error interno del servidor.', 500);
  };
}

function healthHandler(config: Config, db: Db, aws: AwsService): RequestHandler {
  return async (req, res) => {
    const deep = String(req.query.deep ?? '').toLowerCase();
    if (deep !== '1' && deep !== 'true' && deep !== 'yes') {
      res.status(200).json({ status: 'ok' });
      return;
    }

    const checks: Record<string, string> = {};
    let healthy = true;

    try {
      await db.ping();
      checks.mysql = 'ok';
    } catch (error) {
      checks.mysql = 'error';
      healthy = false;
      console.warn(
        `${new Date().toISOString()} WARN docuprocess.api: health deep: MySQL no responde:`,
        error,
      );
    }

    try {
      await aws.healthCheck();
      checks.dynamodb = 'ok';
    } catch (error) {
      checks.dynamodb = 'error';
      healthy = false;
      console.warn(
        `${new Date().toISOString()} WARN docuprocess.api: health deep: DynamoDB no responde:`,
        error,
      );
    }

    if (healthy) {
      res.status(200).json({ status: 'ok', checks });
      return;
    }

    res.status(503).json({
      error: 'unhealthy',
      message: 'Una o mas dependencias no responden.',
      checks,
    });
  };
}

export function createApp({
  config,
  db = createDb(config),
  aws = createAwsService(config),
}: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestLogger());
  app.use(corsMiddleware(config));
  app.use(
    express.json({
      limit: '64kb',
      type: ['application/json', 'application/*+json'],
    }),
  );

  app.get('/api/health', healthHandler(config, db, aws));

  app.use(notFoundOrMethodNotAllowed());
  app.use(errorHandler());

  void db.ensureSchema().catch((error: unknown) => {
    console.warn(
      `${new Date().toISOString()} WARN docuprocess.api: no se pudo aplicar schema.sql al arrancar:`,
      error,
    );
  });

  return app;
}
