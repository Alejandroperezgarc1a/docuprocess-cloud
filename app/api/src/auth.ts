import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
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
 * Express middleware that validates the Bearer JWT (HS256), requires the sub,
 * iat and jti claims, rejects tokens revoked via logout (revoked_tokens table),
 * and exposes userId/userEmail/userRole and tokenJti/tokenExp to handlers.
 */
export function requireAuth(config: Config, db: Db): RequestHandler {
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
      typeof payload.iat !== 'number' ||
      typeof payload.jti !== 'string' ||
      payload.jti === ''
    ) {
      errorResponse(res, 'unauthorized', 'Token invalido.', 401);
      return;
    }

    const jti = payload.jti;
    void db
      .isTokenRevoked(jti)
      .then((revoked) => {
        if (revoked) {
          errorResponse(res, 'unauthorized', 'El token fue revocado.', 401);
          return;
        }
        req.userId = payload.sub as string;
        req.userEmail = typeof payload.email === 'string' ? payload.email : '';
        req.userRole = typeof payload.role === 'string' ? payload.role : 'user';
        req.tokenJti = jti;
        req.tokenExp =
          typeof payload.exp === 'number' ? payload.exp : 0;
        next();
      })
      .catch((error: unknown) => {
        console.error(
          `${new Date().toISOString()} ERROR docuprocess.api: no se pudo consultar revoked_tokens:`,
          error,
        );
        errorResponse(
          res,
          'database_unavailable',
          'Base de datos no disponible.',
          503,
        );
      });
  };
}

/**
 * Rejects requests whose authenticated user does not have the admin role.
 * Must run after requireAuth (it reads req.userRole).
 */
export function requireAdmin(): RequestHandler {
  return (req, res, next) => {
    if (req.userRole !== 'admin') {
      errorResponse(res, 'forbidden', 'Se requiere el rol admin.', 403);
      return;
    }
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
      if (config.adminEmails.includes(email)) {
        try {
          await db.promoteAdmins([email]);
        } catch (error) {
          console.error(
            `${new Date().toISOString()} ERROR docuprocess.api: no se pudo promover a admin en register:`,
            error,
          );
        }
      }
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

    // Promueve a admin segun ADMIN_EMAILS tambien en login: en un despliegue
    // limpio la tabla users puede estar vacia y el rol solo se aplicaria al
    // arranque (antes de existiera el usuario). Aqui se garantiza antes de
    // firmar el token.
    let role = typeof user.role === 'string' ? user.role : 'user';
    if (config.adminEmails.includes(user.email) && role !== 'admin') {
      try {
        await db.promoteAdmins([user.email]);
        role = 'admin';
      } catch (error) {
        console.error(
          `${new Date().toISOString()} ERROR docuprocess.api: no se pudo promover a admin en login:`,
          error,
        );
      }
    }

    const token = jwt.sign(
      { sub: String(user.id), email: user.email, role, jti: randomUUID() },
      config.jwtSecret,
      { algorithm: 'HS256', expiresIn: JWT_TTL_SECONDS },
    );

    res.status(200).json({ token, expiresIn: JWT_TTL_SECONDS });
  });

  // Logout real: revoca el jti del token usado en este request. El token queda
  // inutilizable de inmediato aunque su exp no haya llegado.
  app.post('/api/auth/logout', requireAuth(config, db), async (req, res) => {
    const jti = req.tokenJti;
    const userId = req.userId;
    const exp = req.tokenExp ?? 0;
    if (jti === undefined || userId === undefined) {
      errorResponse(res, 'unauthorized', 'Token invalido.', 401);
      return;
    }
    try {
      await db.revokeToken(jti, Number(userId), exp);
    } catch (error) {
      db.markSchemaMissing(error);
      console.error(
        `${new Date().toISOString()} ERROR docuprocess.api: error de MySQL en logout:`,
        error,
      );
      errorResponse(res, 'database_unavailable', 'Base de datos no disponible.', 503);
      return;
    }
    res.status(204).end();
  });
}
