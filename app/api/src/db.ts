import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import mysql, {
  type Pool,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';
import type { Config } from './config.js';

/** MySQL user row returned by the repository. */
export interface UserRecord {
  id: number;
  email: string;
  password_hash: string;
  role: string;
}

/** Persistence operations required by the authentication layer. */
export interface Db {
  /** Applies schema.sql once per process unless `force` is true. */
  ensureSchema(force?: boolean): Promise<void>;
  /** Inserts a user and returns the generated id. */
  createUser(email: string, passwordHash: string): Promise<number>;
  /** Finds a user by normalized email. */
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  /** Revokes a JWT by its jti so it stops being accepted. */
  revokeToken(jti: string, userId: number, expiresAt: number): Promise<void>;
  /** Returns true when the jti was revoked (logout). */
  isTokenRevoked(jti: string): Promise<boolean>;
  /** Promotes every configured email to admin; returns how many users were promoted. */
  promoteAdmins(emails: readonly string[]): Promise<number>;
  /** Runs a lightweight query to verify that MySQL is reachable. */
  ping(): Promise<void>;
  /** Clears the schema flag when MySQL reports a missing table. */
  markSchemaMissing(error: unknown): void;
  /** Closes the connection pool. */
  close(): Promise<void>;
}

/** Raised when the email already exists in MySQL (error 1062). */
export class EmailAlreadyExists extends Error {
  constructor(message = 'email duplicado') {
    super(message);
    this.name = 'EmailAlreadyExists';
  }
}

const SCHEMA_PATH = fileURLToPath(new URL('../schema.sql', import.meta.url));

/** Splits schema.sql into individual statements, ignoring comments and blank lines. */
export function parseSchemaStatements(raw: string): string[] {
  const lines = raw
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('--'));

  return lines
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function mysqlErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** MySQL implementation backed by a mysql2 connection pool. */
export class MySqlDb implements Db {
  private readonly pool: Pool;
  private schemaReady = false;
  private schemaTask: Promise<void> | null = null;

  /** Creates the pool with the timeouts and charset required by the contract. */
  constructor(private readonly config: Config) {
    this.pool = mysql.createPool({
      host: config.dbHost,
      port: config.dbPort,
      user: config.dbUser,
      password: config.dbPassword,
      database: config.dbName,
      charset: 'utf8mb4',
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 3000,
      enableKeepAlive: true,
    });
  }

  /** Applies schema.sql at most once concurrently; retries after a failure. */
  async ensureSchema(force = false): Promise<void> {
    if (this.schemaReady && !force) {
      return;
    }
    if (this.schemaTask !== null) {
      return this.schemaTask;
    }

    this.schemaTask = this.applySchema(force).finally(() => {
      this.schemaTask = null;
    });
    return this.schemaTask;
  }

  /** Executes every statement from schema.sql (CREATE TABLE IF NOT EXISTS). */
  private async applySchema(force: boolean): Promise<void> {
    if (this.schemaReady && !force) {
      return;
    }

    const raw = await readFile(SCHEMA_PATH, 'utf8');
    for (const statement of parseSchemaStatements(raw)) {
      await this.pool.query(statement);
    }
    // Migración para tablas users creadas antes de la columna role (MySQL 8 no soporta
    // ADD COLUMN IF NOT EXISTS). En un deploy nuevo el CREATE ya incluye la columna.
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'`,
      [this.config.dbName],
    );
    if (Number((rows[0] as { n?: unknown })?.n ?? 0) === 0) {
      await this.pool.query(
        "ALTER TABLE users ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'user'",
      );
    }
    this.schemaReady = true;
  }

  /** Inserts a user, translating duplicate emails to EmailAlreadyExists. */
  async createUser(email: string, passwordHash: string): Promise<number> {
    try {
      const [result] = await this.pool.execute<ResultSetHeader>(
        'INSERT INTO users (email, password_hash) VALUES (?, ?)',
        [email, passwordHash],
      );
      return Number(result.insertId);
    } catch (error) {
      if (mysqlErrorCode(error) === 'ER_DUP_ENTRY') {
        throw new EmailAlreadyExists();
      }
      throw error;
    }
  }

  /** Returns the user row for an email, or undefined when it does not exist. */
  async findUserByEmail(email: string): Promise<UserRecord | undefined> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT id, email, password_hash, role FROM users WHERE email = ?',
      [email],
    );
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      id: Number(row.id),
      email: String(row.email),
      password_hash: String(row.password_hash),
      role: String(row.role),
    };
  }

  /** Inserts the token's jti into revoked_tokens; idempotent. */
  async revokeToken(jti: string, userId: number, expiresAt: number): Promise<void> {
    await this.pool.execute(
      `INSERT INTO revoked_tokens (jti, user_id, expires_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE jti = jti`,
      [jti, userId, expiresAt],
    );
    // Poda oportunista: las filas cuyo token ya vencería naturalmente no guardan valor.
    await this.pool.execute('DELETE FROM revoked_tokens WHERE expires_at < ?', [
      Math.floor(Date.now() / 1000),
    ]);
  }

  /** Returns true when the jti was revoked. */
  async isTokenRevoked(jti: string): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT jti FROM revoked_tokens WHERE jti = ? LIMIT 1',
      [jti],
    );
    return rows.length > 0;
  }

  /** Promotes every configured email to admin; returns how many rows changed. */
  async promoteAdmins(emails: readonly string[]): Promise<number> {
    if (emails.length === 0) {
      return 0;
    }
    const placeholders = emails.map(() => '?').join(', ');
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE users SET role = 'admin' WHERE email IN (${placeholders})`,
      [...emails],
    );
    return Number(result.affectedRows);
  }

  /** Executes SELECT 1 to verify connectivity. */
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1 AS ok');
  }

  /** Marks the schema as missing when MySQL returns ER_NO_SUCH_TABLE (1146). */
  markSchemaMissing(error: unknown): void {
    if (mysqlErrorCode(error) === 'ER_NO_SUCH_TABLE') {
      this.schemaReady = false;
    }
  }

  /** Closes all pooled connections. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Creates the production MySQL repository. */
export function createDb(config: Config): Db {
  return new MySqlDb(config);
}
