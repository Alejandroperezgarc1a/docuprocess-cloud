import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { makeApp, registerAndLogin } from './helpers/fakes.js';

async function createDoc(
  context: ReturnType<typeof makeApp>,
  headers: { Authorization: string },
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await request(context.app)
    .post('/api/documents')
    .set(headers)
    .send({
      filename: 'demo.pdf',
      contentType: 'application/pdf',
      size: 12345,
      ...overrides,
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.documentId as string;
}

describe('logout y revocacion de tokens', () => {
  it('el login emite jti y role en el token', async () => {
    const context = makeApp();
    const { token } = await registerAndLogin(context.app);

    const payload = jwt.decode(token) as Record<string, unknown>;
    assert.equal(typeof payload.jti, 'string');
    assert.match(payload.jti as string, /^[0-9a-f-]{36}$/);
    assert.equal(payload.role, 'user');
  });

  it('logout revoca el token actual y los requests posteriores devuelven 401', async () => {
    const context = makeApp();
    const { headers } = await registerAndLogin(context.app);

    const logout = await request(context.app)
      .post('/api/auth/logout')
      .set(headers);
    assert.equal(logout.status, 204);

    const list = await request(context.app)
      .get('/api/documents')
      .set(headers);
    assert.equal(list.status, 401);
  });

  it('logout sin token devuelve 401', async () => {
    const context = makeApp();
    const response = await request(context.app).post('/api/auth/logout');
    assert.equal(response.status, 401);
  });

  it('un token sin jti no es aceptado', async () => {
    const context = makeApp();
    const legacy = jwt.sign(
      { sub: '1', email: 'user@example.com', iat: Math.floor(Date.now() / 1000) },
      context.config.jwtSecret,
      { algorithm: 'HS256', expiresIn: 3600 },
    );

    const list = await request(context.app)
      .get('/api/documents')
      .set({ Authorization: `Bearer ${legacy}` });
    assert.equal(list.status, 401);
  });
});

describe('admin y retry de documentos fallidos', () => {
  it('GET /api/admin/documents devuelve 403 para un usuario normal', async () => {
    const context = makeApp();
    const { headers } = await registerAndLogin(context.app);

    const response = await request(context.app)
      .get('/api/admin/documents')
      .set(headers);
    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'forbidden');
  });

  it('GET /api/admin/documents devuelve la lista global a un administrador', async () => {
    const context = makeApp();
    const regular = await registerAndLogin(context.app, 'regular@example.com');
    await createDoc(context, regular.headers, { filename: 'a.pdf' });

    const admin = await registerAndLogin(context.app, 'admin@example.com');
    await createDoc(context, admin.headers, { filename: 'b.pdf' });
    await context.db.promoteAdmins(['admin@example.com']);

    // re-login para emitir token con role=admin (promoteAdmins actualiza la fila; el
    // login lee role desde la base, asi que hay que volver a entrar)
    const relogin = await request(context.app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'password123' });
    assert.equal(relogin.status, 200);
    const adminHeaders = { Authorization: `Bearer ${relogin.body.token}` };

    const response = await request(context.app)
      .get('/api/admin/documents')
      .set(adminHeaders);
    assert.equal(response.status, 200);
    assert.equal(response.body.items.length, 2);
  });

  it('retry de un documento FAILED lo vuelve a PENDING', async () => {
    const context = makeApp();
    const { headers } = await registerAndLogin(context.app);
    const documentId = await createDoc(context, headers);

    const item = context.aws.documents.get(documentId);
    assert.ok(item);
    context.aws.documents.set(documentId, {
      ...item,
      status: 'FAILED',
      error: 'processing failed',
    });

    const retry = await request(context.app)
      .post(`/api/documents/${documentId}/retry`)
      .set(headers);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.status, 'PENDING');

    const after = context.aws.documents.get(documentId);
    assert.equal(after?.status, 'PENDING');
    assert.equal(after?.error, undefined);
  });

  it('retry de un documento que no esta FAILED devuelve 409', async () => {
    const context = makeApp();
    const { headers } = await registerAndLogin(context.app);
    const documentId = await createDoc(context, headers);

    const retry = await request(context.app)
      .post(`/api/documents/${documentId}/retry`)
      .set(headers);
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error, 'invalid_state');
  });

  it('retry de un documento ajeno devuelve 404', async () => {
    const context = makeApp();
    const owner = await registerAndLogin(context.app, 'owner@example.com');
    const documentId = await createDoc(context, owner.headers);

    const intruder = await registerAndLogin(context.app, 'intruder@example.com');
    const retry = await request(context.app)
      .post(`/api/documents/${documentId}/retry`)
      .set(intruder.headers);
    assert.equal(retry.status, 404);
  });
});
