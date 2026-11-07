import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from 'express';
import swaggerUi from 'swagger-ui-express';
import { registerAuthRoutes } from './auth.js';
import type { AwsService } from './aws.js';
import { createAwsService } from './aws.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { createDb } from './db.js';
import { registerDocumentRoutes } from './documents.js';
import { HTTP_ERRORS, errorResponse } from './errors.js';
import { openApiSpec } from './openapi.js';

/** Dependencies that can be overridden in tests. */
export interface AppDependencies {
  config: Config;
  db?: Db;
  aws?: AwsService;
}

/**
 * Paths handled by the API. Used to distinguish a wrong HTTP method (405)
 * from an unknown route (404).
 */
const KNOWN_ROUTES: ReadonlyArray<{ pattern: RegExp; methods: readonly string[] }> = [
  { pattern: /^\/api\/health\/?$/, methods: ['GET'] },
  { pattern: /^\/api\/auth\/register\/?$/, methods: ['POST'] },
  { pattern: /^\/api\/auth\/login\/?$/, methods: ['POST'] },
  { pattern: /^\/api\/documents\/?$/, methods: ['GET', 'POST'] },
  { pattern: /^\/api\/documents\/[^/]+\/?$/, methods: ['GET'] },
  { pattern: /^\/api\/docs(?:\/.*)?$/, methods: ['GET'] },
  { pattern: /^\/api\/openapi\.json\/?$/, methods: ['GET'] },
];

/** Logs one line per request to stdout, which systemd captures in journald. */
function requestLogger(): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      console.log(
        `${new Date().toISOString()} INFO docuprocess.api: ${req.method} ${req.path} -> ${res.statusCode} (${elapsedMs.toFixed(1)} ms)`,
      );
    });
    next();
  };
}

/** Adds CORS headers only for configured origins and answers preflight requests. */
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
      res.status(200).end();
      return;
    }
    next();
  };
}

/**
 * Returns 405 for a known path with an unsupported method, or 404 otherwise.
 * Both responses use the API error format.
 */
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

/**
 * Maps body-parser and unexpected errors to the API error format.
 * Handles oversized bodies (413), malformed JSON (400) and unknown failures (500).
 */
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

/**
 * Returns the health handler. The shallow check never touches MySQL so the
 * ALB target group stays healthy even during a database outage. The deep check
 * verifies MySQL and DynamoDB when the query string contains deep=1|true|yes.
 */
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

/**
 * Builds the Express application with all routes, middleware and error handlers.
 * Dependencies are injectable so tests can replace MySQL and AWS.
 */
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
  registerAuthRoutes(app, config, db);
  registerDocumentRoutes(app, config, aws);

  app.get('/api/openapi.json', (_req, res) => {
    res.json(openApiSpec);
  });
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, { customSiteTitle: 'DocuProcess Cloud API' }),
  );

  app.use(notFoundOrMethodNotAllowed());
  app.use(errorHandler());

  // Startup must not fail when MySQL is down: the ALB health check still works.
  void db.ensureSchema().catch((error: unknown) => {
    console.warn(
      `${new Date().toISOString()} WARN docuprocess.api: no se pudo aplicar schema.sql al arrancar:`,
      error,
    );
  });

  return app;
}
