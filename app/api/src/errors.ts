import type { Response } from 'express';

export function errorResponse(
  res: Response,
  code: string,
  message: string,
  status: number,
): Response {
  if (status === 401) {
    res.set('WWW-Authenticate', 'Bearer');
  }
  return res.status(status).json({ error: code, message });
}

export const HTTP_ERRORS: Readonly<Record<number, { code: string; message: string }>> = {
  400: { code: 'invalid_request', message: 'Solicitud invalida.' },
  401: { code: 'unauthorized', message: 'No autorizado.' },
  404: { code: 'not_found', message: 'Recurso no encontrado.' },
  405: { code: 'method_not_allowed', message: 'Metodo no permitido.' },
  413: {
    code: 'payload_too_large',
    message: 'El cuerpo de la solicitud es demasiado grande.',
  },
  415: { code: 'unsupported_media_type', message: 'Content-Type no soportado.' },
};
