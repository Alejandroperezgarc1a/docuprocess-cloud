import type { Express } from 'express';
import { requireAdmin, requireAuth } from './auth.js';
import type { AwsService } from './aws.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { errorResponse } from './errors.js';

const ADMIN_LIST_LIMIT = 50;

/**
 * Registers the admin-only routes. Everything here requires the `admin` role
 * (see requireAdmin); regular users get 403.
 */
export function registerAdminRoutes(
  app: Express,
  config: Config,
  aws: AwsService,
  db: Db,
): void {
  const auth = requireAuth(config, db);
  const admin = requireAdmin();

  // Vista global: todos los documentos de todos los usuarios (más recientes primero).
  app.get('/api/admin/documents', auth, admin, async (_req, res) => {
    try {
      const items = await aws.listAllDocuments(ADMIN_LIST_LIMIT);
      res.status(200).json({ items });
    } catch (error) {
      console.error(
        `${new Date().toISOString()} ERROR docuprocess.api: no se pudo listar los documentos (admin):`,
        error,
      );
      errorResponse(
        res,
        'storage_unavailable',
        'No se pudo consultar los documentos.',
        503,
      );
    }
  });
}
