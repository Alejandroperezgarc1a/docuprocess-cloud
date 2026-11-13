import type { Express } from 'express';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import type { AwsService } from '../../src/aws.js';
import type { Config } from '../../src/config.js';
import type { Db, UserRecord } from '../../src/db.js';
import { EmailAlreadyExists } from '../../src/db.js';
import type { DocumentEvent, DocumentItem } from '../../src/types.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    docsBucket: 'test-docs-bucket',
    ddbTable: 'documents',
    ddbEventsTable: 'document_events',
    ddbTransactions: true,
    dbHost: '127.0.0.1',
    dbPort: 3306,
    dbName: 'docuprocess',
    dbUser: 'docuadmin',
    dbPassword: 'test-password',
    jwtSecret: 'test-secret-0123456789abcdefghij',
    awsRegion: 'us-east-1',
    adminEmails: [],
    corsAllowedOrigins: [
      'http://localhost:5500',
      'http://127.0.0.1:5500',
    ],
    ...overrides,
  };
}

export class FakeDb implements Db {
  readonly users = new Map<string, UserRecord>();
  readonly revoked = new Set<string>();
  promoteAdminsCalls: string[][] = [];
  schemaCalls = 0;
  schemaReady = false;
  failSchema = false;
  failPing = false;
  failQueries = false;
  failRevoke = false;
  private nextId = 1;

  async ensureSchema(_force = false): Promise<void> {
    this.schemaCalls += 1;
    if (this.failSchema) {
      throw new Error('MySQL apagado');
    }
    this.schemaReady = true;
  }

  async createUser(email: string, passwordHash: string): Promise<number> {
    if (this.failQueries) {
      throw new Error('MySQL apagado');
    }
    if (this.users.has(email)) {
      throw new EmailAlreadyExists();
    }
    const id = this.nextId;
    this.nextId += 1;
    this.users.set(email, { id, email, password_hash: passwordHash, role: 'user' });
    return id;
  }

  async findUserByEmail(email: string): Promise<UserRecord | undefined> {
    if (this.failQueries) {
      throw new Error('MySQL apagado');
    }
    return this.users.get(email);
  }

  async revokeToken(jti: string, _userId: number, _expiresAt: number): Promise<void> {
    if (this.failRevoke) {
      throw new Error('MySQL apagado');
    }
    this.revoked.add(jti);
  }

  async isTokenRevoked(jti: string): Promise<boolean> {
    if (this.failQueries) {
      throw new Error('MySQL apagado');
    }
    return this.revoked.has(jti);
  }

  async promoteAdmins(emails: readonly string[]): Promise<number> {
    this.promoteAdminsCalls.push([...emails]);
    let count = 0;
    for (const email of emails) {
      const user = this.users.get(email);
      if (user !== undefined && user.role !== 'admin') {
        this.users.set(email, { ...user, role: 'admin' });
        count += 1;
      }
    }
    return count;
  }

  async ping(): Promise<void> {
    if (this.failPing) {
      throw new Error('MySQL apagado');
    }
  }

  markSchemaMissing(_error: unknown): void {
    this.schemaReady = false;
  }

  async close(): Promise<void> {
    // nada
  }
}

// Fake en memoria de AwsService: imita DynamoDB/S3 sin credenciales ni Docker.
// La bitácora se acumula en `events`; las pruebas de orden cronológico y de fallo usan
// `failEventsQuery` para simular un error de DynamoDB contra la tabla document_events.
export class FakeAws implements AwsService {
  readonly documents = new Map<string, DocumentItem>();
  // Array de eventos append-only: createDocument agrega sin eliminar, como la tabla real.
  readonly events: DocumentEvent[] = [];
  failHealth = false;
  failPut = false;
  failPresign = false;
  failQuery = false;
  failGet = false;
  failEventsQuery = false;

  async healthCheck(): Promise<void> {
    if (this.failHealth) {
      throw new Error('DynamoDB apagado');
    }
  }

  async createDocument(item: DocumentItem, event: DocumentEvent): Promise<void> {
    if (this.failPut) {
      throw new Error('DynamoDB apagado');
    }
    // En producción esto va dentro de una transacción DynamoDB; aquí el fake guarda ambos,
    // como haría el caso exitoso de TransactWriteItems.
    this.documents.set(item.documentId, structuredClone(item));
    this.events.push(structuredClone(event));
  }

  async queryUserDocuments(userId: string): Promise<DocumentItem[]> {
    if (this.failQuery) {
      throw new Error('DynamoDB apagado');
    }
    return [...this.documents.values()]
      .filter((item) => item.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 50)
      .map((item) => structuredClone(item));
  }

  async getDocument(documentId: string): Promise<DocumentItem | undefined> {
    if (this.failGet) {
      throw new Error('DynamoDB apagado');
    }
    const item = this.documents.get(documentId);
    return item === undefined ? undefined : structuredClone(item);
  }

  async queryDocumentEvents(documentId: string): Promise<DocumentEvent[]> {
    if (this.failEventsQuery) {
      throw new Error('DynamoDB apagado');
    }
    return this.events
      .filter((event) => event.documentId === documentId)
      .sort((left, right) => left.eventAt.localeCompare(right.eventAt))
      .slice(0, 200)
      .map((event) => structuredClone(event));
  }

  async listAllDocuments(limit: number): Promise<DocumentItem[]> {
    if (this.failQuery) {
      throw new Error('DynamoDB apagado');
    }
    return [...this.documents.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((item) => structuredClone(item));
  }

  retryResult = true;
  retryCalls: Array<{ item: DocumentItem; now: string }> = [];

  async retryDocument(item: DocumentItem, now: string): Promise<boolean> {
    this.retryCalls.push({ item, now });
    const current = this.documents.get(item.documentId);
    if (current === undefined || current.status !== 'FAILED' || !this.retryResult) {
      return false;
    }
    const next: DocumentItem = { ...current, status: 'PENDING', updatedAt: now };
    delete next.error;
    delete next.result;
    this.documents.set(item.documentId, structuredClone(next));
    this.events.push({
      documentId: item.documentId,
      eventAt: `${now}#test`,
      eventId: `evt-${this.events.length + 1}`,
      userId: item.userId,
      eventDay: now.slice(0, 10),
      fromStatus: 'FAILED',
      toStatus: 'PENDING',
      actor: 'api',
      reason: 'manual retry',
      schemaVersion: 1,
    });
    return true;
  }

  async presignUpload(key: string, contentType: string): Promise<string> {
    if (this.failPresign) {
      throw new Error('S3 apagado');
    }
    return `https://test-docs-bucket.s3.amazonaws.com/${key}?X-Amz-Signature=fake&X-Amz-Expires=900&content-type=${encodeURIComponent(contentType)}`;
  }
}

export interface TestContext {
  app: Express;
  config: Config;
  db: FakeDb;
  aws: FakeAws;
}

export function makeApp(
  options: { config?: Partial<Config>; db?: FakeDb; aws?: FakeAws } = {},
): TestContext {
  const config = testConfig(options.config);
  const db = options.db ?? new FakeDb();
  const aws = options.aws ?? new FakeAws();
  const app = createApp({ config, db, aws });
  return { app, config, db, aws };
}

export async function registerAndLogin(
  app: Express,
  email = 'user@example.com',
  password = 'password123',
): Promise<{ headers: { Authorization: string }; userId: number; token: string }> {
  const registered = await request(app)
    .post('/api/auth/register')
    .send({ email, password });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));

  const loggedIn = await request(app)
    .post('/api/auth/login')
    .send({ email, password });
  assert.equal(loggedIn.status, 200, JSON.stringify(loggedIn.body));

  const token = loggedIn.body.token as string;
  return {
    headers: { Authorization: `Bearer ${token}` },
    userId: registered.body.id as number,
    token,
  };
}
