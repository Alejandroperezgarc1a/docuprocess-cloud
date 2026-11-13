/**
 * Authentication routes and middleware for DocuProcess Cloud: registration,
 * login (bcrypt + HS256 JWT) and Bearer-token auth for protected routes.
 */
import bcrypt from 'bcryptjs';
import type { Express, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { EmailAlreadyExists } from './db.js';
import { errorResponse } from './errors.js';
import { readJsonBody } from './request.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const JWT_TTL_SECONDS = 3600;
const BCRYPT_ROUNDS = 12;

/** Normalizes and validates an email address; returns null when invalid. */
export function validateEmail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 255 || !EMAIL_RE.test(email)) {
    return null;
  }
  return email;
}

/**
 * Validates the password rules: at least 8 characters and at most 72 UTF-8 bytes.
 * Returns an error message, or null when the password is valid.
 */
export function validatePassword(value: unknown): string | null {
  if (typeof value !== 'string') {
    return 'La contrasena debe ser texto.';
  }
  if (value.length < 8) {
    return 'La contrasena debe tener al menos 8 caracteres.';
  }
  if (Buffer.byteLength(value, 'utf8') > 72) {
    return 'La contrasena no puede superar 72 bytes.';
  }
  return null;
}

/** Hashes a password with bcrypt using cost 12. */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/** Compares a plain password with a bcrypt hash; never throws. */
export async function verifyPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  try {
    return await bcrypt.compare(password, passwordHash);
  } catch {
    return false;
  }
}

/** Applies the schema, returning false when MySQL is unavailable. */
async function ensureSchemaOrError(db: Db): Promise<boolean> {
  try {
    await db.ensureSchema();
    return true;
  } catch (error) {
    console.error(
      `${new Date().toISOString()} ERROR docuprocess.api: no se pudo preparar el esquema de MySQL:`,
      error,
    );
    return false;
  }
}

/**
 * Express middleware that validates the Bearer JWT, requires the sub and iat
 * claims, and exposes userId/userEmail to downstream handlers.
 */
export function requireAuth(config: Config): RequestHandler {
  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const parts = header.split(/\s+/, 2);
    if (
      parts.length !== 2 ||
      parts[0]?.toLowerCase() !== 'bearer' ||
      parts[1] === undefined ||
      parts[1].trim() === ''
    ) {
      errorResponse(res, 'unauthorized', 'Falta el token Bearer.', 401);
      return;
    }

    const token = parts[1].trim();
    let payload: string | jwt.JwtPayload;
    try {
      payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        errorResponse(res, 'unauthorized', 'El token vencio.', 401);
        return;
      }
      errorResponse(res, 'unauthorized', 'Token invalido.', 401);
      return;
    }

    if (
      typeof payload === 'string' ||
      typeof payload.sub !== 'string' ||
      payload.sub === '' ||
      typeof payload.iat !== 'number'
    ) {
      errorResponse(res, 'unauthorized', 'Token invalido.', 401);
      return;
    }

    req.userId = payload.sub;
    req.userEmail = typeof payload.email === 'string' ? payload.email : '';
    next();
  };
}

/** Registers POST /api/auth/register and POST /api/auth/login. */
export function registerAuthRoutes(app: Express, config: Config, db: Db): void {
  app.post('/api/auth/register', async (req, res) => {
    const body = readJsonBody(req, res);
    if (body === null) {
      return;
    }

    const email = validateEmail(body.email);
    if (email === null) {
      errorResponse(res, 'invalid_email', 'El correo no es valido.', 400);
      return;
    }

    const password = body.password;
    const passwordError = validatePassword(password);
    if (passwordError !== null) {
      errorResponse(res, 'weak_password', passwordError, 400);
      return;
    }

    if (!(await ensureSchemaOrError(db))) {
      errorResponse(res, 'database_unavailable', 'Base de datos no disponible.', 503);
      return;
    }

    const passwordHash = await hashPassword(password as string);
    try {
      const userId = await db.createUser(email, passwordHash);
      res.status(201).json({ id: userId, email });
    } catch (error) {
      if (error instanceof EmailAlreadyExists) {
        errorResponse(
          res,
          'email_exists',
          'Ya existe una cuenta con ese correo.',
          409,
        );
        return;
      }
      db.markSchemaMissing(error);
      console.error(
        `${new Date().toISOString()} ERROR docuprocess.api: error de MySQL en register:`,
        error,
      );
      errorResponse(res, 'database_unavailable', 'Base de datos no disponible.', 503);
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const body = readJsonBody(req, res);
    if (body === null) {
      return;
    }

    const email = validateEmail(body.email);
    const password = body.password;
    if (
      email === null ||
      typeof password !== 'string' ||
      Buffer.byteLength(password, 'utf8') > 72
    ) {
      errorResponse(
        res,
        'invalid_credentials',
        'Correo o contrasena incorrectos.',
        401,
      );
      return;
    }

    if (!(await ensureSchemaOrError(db))) {
      errorResponse(res, 'database_unavailable', 'Base de datos no disponible.', 503);
      return;
    }

    let user;
    try {
      user = await db.findUserByEmail(email);
    } catch (error) {
      db.markSchemaMissing(error);
      console.error(
        `${new Date().toISOString()} ERROR docuprocess.api: error de MySQL en login:`,
        error,
      );
      errorResponse(res, 'database_unavailable', 'Base de datos no disponible.', 503);
      return;
    }

    if (user === undefined || !(await verifyPassword(password, user.password_hash))) {
      errorResponse(
        res,
        'invalid_credentials',
        'Correo o contrasena incorrectos.',
        401,
      );
      return;
    }

    const token = jwt.sign(
      { sub: String(user.id), email: user.email },
      config.jwtSecret,
      { algorithm: 'HS256', expiresIn: JWT_TTL_SECONDS },
    );

    res.status(200).json({ token, expiresIn: JWT_TTL_SECONDS });
  });
}
