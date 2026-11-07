import type { Request, Response } from 'express';
import { errorResponse } from './errors.js';

export function readJsonBody(
  req: Request,
  res: Response,
): Record<string, unknown> | null {
  const rawContentType = req.get('content-type') ?? '';
  const mediaType = rawContentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'application/json' && !mediaType.endsWith('+json')) {
    errorResponse(
      res,
      'invalid_request',
      'Content-Type debe ser application/json.',
      400,
    );
    return null;
  }

  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    errorResponse(
      res,
      'invalid_request',
      'El cuerpo debe ser un objeto JSON.',
      400,
    );
    return null;
  }

  return body as Record<string, unknown>;
}
