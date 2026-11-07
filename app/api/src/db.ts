import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import mysql, {
  type Pool,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';
import type { Config } from './config.js';

export interface UserRecord {
  id: number;
  email: string;
  password_hash: string;
}

export interface Db {
  ensureSchema(force?: boolean): Promise<void>;
  createUser(email: string, passwordHash: string): Promise<number>;
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  ping(): Promise<void>;
  markSchemaMissing(error: unknown): void;
  close(): Promise<void>;
}

export class EmailAlreadyExists extends Error {
  constructor(message = 'email duplicado') {
    super(message);
    this.name = 'EmailAlreadyExists';
  }
}

const SCHEMA_PATH = fileURLToPath(new URL('../schema.sql', import.meta.url));

function schemaStatements(raw: string): string[] {
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

export class MySqlDb implements Db {
  private readonly pool: Pool;
  private schemaReady = false;
  private schemaTask: Promise<void> | null = null;

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

  private async applySchema(force: boolean): Promise<void> {
    if (this.schemaReady && !force) {
      return;
    }

    const raw = await readFile(SCHEMA_PATH, 'utf8');
    for (const statement of schemaStatements(raw)) {
      await this.pool.query(statement);
    }
    this.schemaReady = true;
  }

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

  async findUserByEmail(email: string): Promise<UserRecord | undefined> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT id, email, password_hash FROM users WHERE email = ?',
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
    };
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1 AS ok');
  }

  markSchemaMissing(error: unknown): void {
    if (mysqlErrorCode(error) === 'ER_NO_SUCH_TABLE') {
      this.schemaReady = false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createDb(config: Config): Db {
  return new MySqlDb(config);
}
