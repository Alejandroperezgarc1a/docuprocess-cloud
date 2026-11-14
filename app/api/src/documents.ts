import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { requireAuth } from './auth.js';
import type { AwsService } from './aws.js';
import type { Config } from './config.js';
import { errorResponse } from './errors.js';
import { readJsonBody } from './request.js';
import type { DocumentEvent, DocumentItem } from './types.js';

const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/plain',
]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const PRESIGN_EXPIRES_SECONDS = 900;
const S3_UPLOAD_PREFIX = 'uploads';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Removes paths and control characters and caps the filename at 200 characters. */
export function sanitizeFilename(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const base = value.replace(/\\/g, '/').split('/').pop() ?? '';
  const name = base
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');

  if (name.length === 0) {
    return null;
  }
  if (name.length <= 200) {
    return name;
  }

  const lastDot = name.lastIndexOf('.');
  const extension = lastDot > 0 ? name.slice(lastDot + 1) : '';
  if (lastDot > 0 && extension.length > 0 && extension.length <= 20) {
    const keep = 200 - extension.length - 1;
    return `${name.slice(0, keep)}.${extension}`;
  }
  return name.slice(0, 200);
}

/** Lowercases and validates the declared content type against the allowlist. */
export function validateContentType(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const contentType = value.trim().toLowerCase();
  return ALLOWED_CONTENT_TYPES.has(contentType) ? contentType : null;
}

/** Validates an integer size between 1 byte and 10 MB. */
export function validateSize(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return null;
  }
  if (value < 1 || value > MAX_UPLOAD_BYTES) {
    return null;
  }
  return value;
}

/** Registers the authenticated document creation, list and detail routes. */
export function registerDocumentRoutes(
  app: Express,
  config: Config,
  aws: AwsService,
): void {
  const auth = requireAuth(config);

  app.post('/api/documents', auth, async (req, res) => {
    const userId = req.userId;
    if (userId === undefined) {
      errorResponse(res, 'unauthorized', 'Falta el token Bearer.', 401);
      return;
    }

    const body = readJsonBody(req, res);
    if (body === null) {
      return;
    }

    const filename = sanitizeFilename(body.filename);
    if (filename === null) {
      errorResponse(
        res,
        'invalid_filename',
        'El nombre del archivo no es valido.',
        400,
      );
      return;
    }

    const contentType = validateContentType(body.contentType);
    if (contentType === null) {
      errorResponse(
        res,
        'invalid_file_type',
        'Tipo no permitido. Usa PDF, PNG, JPG o TXT.',
        400,
      );
      return;
    }

    if (validateSize(body.size) === null) {
      errorResponse(
        res,
        'invalid_file_size',
        'El archivo debe pesar entre 1 byte y 10 MB.',
        400,
      );
      return;
    }

    const documentId = randomUUID();
    const key = `${S3_UPLOAD_PREFIX}/${userId}/${documentId}/${filename}`;
    const timestamp = new Date().toISOString();
    const item: DocumentItem = {
      documentId,
      userId,
      filename,
      contentType,
      s3Key: key,
      status: 'PENDING',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // Evento inicial de la bitácora. actor=api (lo produce la API, no el worker) y fromStatus
    // ausente (no hay estado anterior). eventDay se materializa porque DynamoDB no permite
    // funciones en las claves del GSI day-eventAt. eventAt lleva un sufijo aleatorio para que
    // dos eventos del mismo milisegundo no colisionen en la clave (documentId, eventAt).
    const event: DocumentEvent = {
      documentId,
      eventAt: `${timestamp}#${randomUUID().slice(0, 6)}`,
      eventId: randomUUID(),
      userId,
      eventDay: timestamp.slice(0, 10),
      toStatus: 'PENDING',
      actor: 'api',
      schemaVersion: 1,
    };

    let uploadUrl: string;
    try {
      uploadUrl = await aws.presignUpload(key, contentType);
      await aws.createDocument(item, event);
    } catch (error) {
      console.error(
        `${new Date().toISOString()} ERROR docuprocess.api: no se pudo preparar el documento en AWS:`,
        error,
      );
      errorResponse(res, 'storage_unavailable', 'No se pudo preparar la subida.', 503);
      return;
    }

    res.status(201).json({
      documentId,
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      key,
      expiresIn: PRESIGN_EXPIRES_SECONDS,
    });
  });

  app.get('/api/documents', auth, async (req, res) => {
    const userId = req.userId;
    if (userId === undefined) {
      errorResponse(res, 'unauthorized', 'Falta el token Bearer.', 401);
      return;
    }

    let items: DocumentItem[];
    try {
      items = await aws.queryUserDocuments(userId);
    } catch (error) {
      console.error(
        `${new Date().toISOString()} ERROR docuprocess.api: no se pudo listar documentos:`,
        error,
      );
      errorResponse(
        res,
        'storage_unavailable',
        'No se pudo consultar los documentos.',
        503,
      );
      return;
    }

    res.status(200).json({ items });
  });

  app.get('/api/documents/:documentId', auth, async (req, res) => {
    const userId = req.userId;
    if (userId === undefined) {
      errorResponse(res, 'unauthorized', 'Falta el token Bearer.', 401);
      return;
    }

    const rawDocumentId = req.params.documentId;
    const documentId = typeof rawDocumentId === 'string' ? rawDocumentId : '';
    // 404 (no 400) para no revelar si el id existe: mismo criterio que el resto del API.
    if (!UUID_RE.test(documentId)) {
      errorResponse(res, 'not_found', 'Documento no encontrado.', 404);
      return;
    }

    let item: DocumentItem | undefined;
    try {
      item = await aws.getDocument(documentId);
    } catch (error) {
      console.error(
        `${new Date().toISOString()} ERROR docuprocess.api: no se pudo leer el documento:`,
        error,
      );
      errorResponse(
        res,
        'storage_unavailable',
        'No se pudo consultar el documento.',
        503,
      );
      return;
    }

    // 404 (no 403): un usuario no puede distinguir "no existe" de "es de otro". Se evita
    // revelar la existencia del recurso — y de paso, la propiedad se comprueba siempre.
    if (item === undefined || item.userId !== userId) {
      errorResponse(res, 'not_found', 'Documento no encontrado.', 404);
      return;
    }

    res.status(200).json(item);
  });

  // URL firmada de lectura para la vista previa embebida del modal. La API no
  // proxya los bytes: valida propiedad y delega la descarga a S3 con expiracion corta.
  app.get('/api/documents/:documentId/download', auth, async (req, res) => {
    const userId = req.userId;
    if (userId === undefined) {
      errorResponse(res, 'unauthorized', 'Falta el token Bearer.', 401);
      return;
    }

    const rawDocumentId = req.params.documentId;
    const documentId = typeof rawDocumentId === 'string' ? rawDocumentId : '';
    if (!UUID_RE.test(documentId)) {
      errorResponse(res, 'not_found', 'Documento no encontrado.', 404);
      return;
    }

    let item: DocumentItem | undefined;
    try {
      item = await aws.getDocument(documentId);
    } catch (error) {
      console.error(
        `${new Date().toISOString()} ERROR docuprocess.api: no se pudo leer el documento para la vista previa:`,
        error,
      );
      errorResponse(
        res,
        'storage_unavailable',
        'No se pudo preparar la vista previa.',
        503,
      );
      return;
    }

    if (item === undefined || item.userId !== userId) {
      errorResponse(res, 'not_found', 'Documento no encontrado.', 404);
      return;
    }

    if (item.status !== 'DONE') {
      errorResponse(
        res,
        'not_ready',
        'El documento aun no esta listo para previsualizarse.',
        409,
      );
      return;
    }

    let url: string;
    try {
      url = await aws.presignDownload(
        item.s3Key,
        item.filename,
        item.contentType,
      );
    } catch (error) {
      console.error(
        `${new Date().toISOString()} ERROR docuprocess.api: no se pudo firmar la vista previa:`,
        error,
      );
      errorResponse(
        res,
        'storage_unavailable',
        'No se pudo preparar la vista previa.',
        503,
      );
      return;
    }

    res.status(200).json({
      url,
      expiresIn: PRESIGN_EXPIRES_SECONDS,
      method: 'GET',
      filename: item.filename,
      contentType: item.contentType,
    });
  });

  // Bitácora auditable del documento. Se lee de document_events (append-only), no del ítem
  // documents: así el historial no se puede reescribir y sobrevive a cambios de estado.
  app.get('/api/documents/:documentId/events', auth, async (req, res) => {
    const userId = req.userId;
    if (userId === undefined) {
      errorResponse(res, 'unauthorized', 'Falta el token Bearer.', 401);
      return;
    }

    const rawDocumentId = req.params.documentId;
    const documentId = typeof rawDocumentId === 'string' ? rawDocumentId : '';
    // 404 (no 400) para no revelar si el id existe: mismo criterio que el resto del API.
    if (!UUID_RE.test(documentId)) {
      errorResponse(res, 'not_found', 'Documento no encontrado.', 404);
      return;
    }

    // Primero se comprueba la propiedad del documento: un usuario no puede leer la bitácora
    // de otro. Después se consulta la tabla de eventos.
    let item: DocumentItem | undefined;
    try {
      item = await aws.getDocument(documentId);
    } catch (error) {
      console.error(
        `${new Date().toISOString()} ERROR docuprocess.api: no se pudo leer el documento para la bitacora:`,
        error,
      );
      errorResponse(
        res,
        'storage_unavailable',
        'No se pudo consultar el documento.',
        503,
      );
      return;
    }

    // 404 (no 403): un usuario no puede distinguir "no existe" de "es de otro". Se evita
    // revelar la existencia del recurso — y de paso, la propiedad se comprueba siempre.
    if (item === undefined || item.userId !== userId) {
      errorResponse(res, 'not_found', 'Documento no encontrado.', 404);
      return;
    }

    let events: DocumentEvent[];
    try {
      events = await aws.queryDocumentEvents(documentId);
    } catch (error) {
      console.error(
        `${new Date().toISOString()} ERROR docuprocess.api: no se pudo leer la bitacora:`,
        error,
      );
      errorResponse(
        res,
        'storage_unavailable',
        'No se pudo consultar la bitacora.',
        503,
      );
      return;
    }

    res.status(200).json({ items: events });
  });
}
