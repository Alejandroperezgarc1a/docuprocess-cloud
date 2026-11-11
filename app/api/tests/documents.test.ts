import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import request from 'supertest';
import type { DocumentItem } from '../src/types.js';
import { makeApp, registerAndLogin, type TestContext } from './helpers/fakes.js';

function createDocument(
  context: TestContext,
  headers: { Authorization: string },
  overrides: Record<string, unknown> = {},
) {
  return request(context.app)
    .post('/api/documents')
    .set(headers)
    .send({
      filename: 'demo.pdf',
      contentType: 'application/pdf',
      size: 12345,
      ...overrides,
    });
}

describe('documents', () => {
  it('crea el documento, devuelve la URL y lo guarda PENDING', async () => {
    const context = makeApp();
    const { headers, userId } = await registerAndLogin(context.app);

    const response = await createDocument(context, headers);

    assert.equal(response.status, 201);
    const body = response.body;
    const documentId = body.documentId as string;
    assert.match(
      documentId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(body.method, 'PUT');
    assert.deepEqual(body.headers, { 'Content-Type': 'application/pdf' });
    assert.equal(body.expiresIn, 900);
    assert.equal(body.key, `uploads/${userId}/${documentId}/demo.pdf`);
    assert.match(body.uploadUrl.toLowerCase(), /x-amz-signature/);
    assert.match(body.uploadUrl.toLowerCase(), /content-type/);
    assert.ok(body.uploadUrl.includes(documentId));

    const item = context.aws.documents.get(documentId);
    assert.ok(item);
    assert.equal(item.status, 'PENDING');
    assert.equal(item.userId, String(userId));
    assert.equal(item.filename, 'demo.pdf');
    assert.equal(item.contentType, 'application/pdf');
    assert.equal(item.s3Key, body.key);
    assert.equal(item.createdAt, item.updatedAt);
    assert.ok(item.createdAt.endsWith('Z'));

    // La bitacora nace con el evento inicial, escrito en la misma operacion que el documento.
    const events = context.aws.events.filter(
      (event) => event.documentId === documentId,
    );
    assert.equal(events.length, 1);
    const initial = events[0];
    assert.ok(initial);
    assert.equal(initial.toStatus, 'PENDING');
    assert.equal(initial.fromStatus, undefined);
    assert.equal(initial.actor, 'api');
    assert.equal(initial.userId, String(userId));
    assert.equal(initial.eventDay, item.createdAt.slice(0, 10));
    assert.ok(initial.eventAt.startsWith(item.createdAt));
    assert.match(initial.eventAt, /\.\d{3}Z#[0-9a-f]{6}$/);
    assert.equal(initial.schemaVersion, 1);
  });

  it('rechaza un tipo no permitido', async () => {
    const context = makeApp();
    const { headers } = await registerAndLogin(context.app);

    const response = await createDocument(context, headers, {
      contentType: 'application/zip',
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'invalid_file_type');
  });

  it('rechaza tamanos invalidos', async () => {
    const context = makeApp();
    const { headers } = await registerAndLogin(context.app);

    const cases = [
      10 * 1024 * 1024 + 1,
      0,
      true,
      '123',
    ];
    for (const size of cases) {
      const response = await createDocument(context, headers, { size });
      assert.equal(response.status, 400, `size=${String(size)}`);
      assert.equal(response.body.error, 'invalid_file_size');
    }
  });

  it('acepta el tamano maximo', async () => {
    const context = makeApp();
    const { headers } = await registerAndLogin(context.app);

    const response = await createDocument(context, headers, {
      size: 10 * 1024 * 1024,
    });

    assert.equal(response.status, 201);
  });

  it('sanea el nombre del archivo', async () => {
    const context = makeApp();
    const { headers } = await registerAndLogin(context.app);

    const traversal = await createDocument(context, headers, {
      filename: '../../etc/passwd',
    });
    assert.equal(traversal.status, 201);
    assert.ok(traversal.body.key.endsWith('/passwd'));
    assert.ok(!traversal.body.key.includes('..'));

    const backslashes = await createDocument(context, headers, {
      filename: '..\\..\\x.txt',
    });
    assert.equal(backslashes.status, 201);
    assert.ok(backslashes.body.key.endsWith('/x.txt'));

    const longName = await createDocument(context, headers, {
      filename: `${'a'.repeat(250)}.pdf`,
    });
    assert.equal(longName.status, 201);
    const lastSegment = (longName.body.key as string).split('/').pop() ?? '';
    assert.equal(lastSegment.length, 200);
    assert.ok(lastSegment.endsWith('.pdf'));

    const empty = await createDocument(context, headers, { filename: '..' });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'invalid_filename');
  });

  it('rechaza campos faltantes', async () => {
    const context = makeApp();
    const { headers } = await registerAndLogin(context.app);

    const payloads = [
      {},
      { contentType: 'application/pdf', size: 10 },
      { filename: 'a.pdf', size: 10 },
      { filename: 'a.pdf', contentType: 'application/pdf' },
    ];
    for (const payload of payloads) {
      const response = await request(context.app)
        .post('/api/documents')
        .set(headers)
        .send(payload);
      assert.equal(response.status, 400);
    }
  });

  it('acepta todos los tipos permitidos', async () => {
    const context = makeApp();
    const { headers } = await registerAndLogin(context.app);

    for (const contentType of [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'text/plain',
    ]) {
      const response = await createDocument(context, headers, { contentType });
      assert.equal(response.status, 201);
      assert.equal(response.body.headers['Content-Type'], contentType);
    }
  });

  it('lista solo los documentos del usuario', async () => {
    const context = makeApp();
    const userA = await registerAndLogin(context.app, 'a@example.com');
    const userB = await registerAndLogin(context.app, 'b@example.com');

    const docA = await createDocument(context, userA.headers, {
      filename: 'a.pdf',
    });
    const docB = await createDocument(context, userB.headers, {
      filename: 'b.pdf',
    });

    const responseA = await request(context.app)
      .get('/api/documents')
      .set(userA.headers);
    const responseB = await request(context.app)
      .get('/api/documents')
      .set(userB.headers);

    assert.equal(responseA.status, 200);
    assert.deepEqual(
      responseA.body.items.map((item: DocumentItem) => item.documentId),
      [docA.body.documentId],
    );
    assert.equal(responseB.status, 200);
    assert.deepEqual(
      responseB.body.items.map((item: DocumentItem) => item.documentId),
      [docB.body.documentId],
    );
  });

  it('ordena descendente y limita a 50', async () => {
    const context = makeApp();
    const { headers, userId } = await registerAndLogin(context.app);

    for (let index = 0; index < 55; index += 1) {
      const documentId = randomUUID();
      const createdAt = `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`;
      context.aws.documents.set(documentId, {
        documentId,
        userId: String(userId),
        filename: `doc-${index}.pdf`,
        contentType: 'application/pdf',
        s3Key: `uploads/${userId}/${documentId}/doc-${index}.pdf`,
        status: 'PENDING',
        createdAt,
        updatedAt: createdAt,
      });
    }

    const response = await request(context.app)
      .get('/api/documents')
      .set(headers);

    assert.equal(response.status, 200);
    const items = response.body.items as DocumentItem[];
    assert.equal(items.length, 50);
    assert.equal(items[0]?.createdAt, '2026-01-01T00:00:54.000Z');
    assert.equal(items.at(-1)?.createdAt, '2026-01-01T00:00:05.000Z');
  });

  it('devuelve el detalle propio y 404 para el ajeno o inexistente', async () => {
    const context = makeApp();
    const userA = await registerAndLogin(context.app, 'a@example.com');
    const userB = await registerAndLogin(context.app, 'b@example.com');

    const created = await createDocument(context, userA.headers);
    const documentId = created.body.documentId as string;

    const own = await request(context.app)
      .get(`/api/documents/${documentId}`)
      .set(userA.headers);
    const other = await request(context.app)
      .get(`/api/documents/${documentId}`)
      .set(userB.headers);
    const missing = await request(context.app)
      .get(`/api/documents/${randomUUID()}`)
      .set(userA.headers);
    const malformed = await request(context.app)
      .get('/api/documents/no-es-uuid')
      .set(userA.headers);

    assert.equal(own.status, 200);
    assert.equal(own.body.documentId, documentId);
    assert.equal(own.body.status, 'PENDING');

    for (const response of [other, missing, malformed]) {
      assert.equal(response.status, 404);
      assert.equal(response.body.error, 'not_found');
    }
  });

  it('serializa el result numerico del worker', async () => {
    const context = makeApp();
    const { headers, userId } = await registerAndLogin(context.app);
    const created = await createDocument(context, headers);
    const documentId = created.body.documentId as string;

    const item = context.aws.documents.get(documentId);
    assert.ok(item);
    context.aws.documents.set(documentId, {
      ...item,
      status: 'DONE',
      updatedAt: '2026-01-01T00:00:01.000Z',
      result: {
        sizeBytes: 123,
        mimeType: 'application/pdf',
        sha256: 'abc123',
        pages: 2,
        width: 10,
        height: 20,
      },
    });

    const response = await request(context.app)
      .get(`/api/documents/${documentId}`)
      .set(headers);

    assert.equal(response.status, 200);
    assert.equal(response.body.userId, String(userId));
    assert.deepEqual(response.body.result, {
      sizeBytes: 123,
      mimeType: 'application/pdf',
      sha256: 'abc123',
      pages: 2,
      width: 10,
      height: 20,
    });
  });

  it('devuelve 503 si DynamoDB falla al crear', async () => {
    const context = makeApp();
    const { headers } = await registerAndLogin(context.app);
    context.aws.failPut = true;

    const response = await createDocument(context, headers);

    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'storage_unavailable');
  });

  it('devuelve 503 si S3 falla al firmar', async () => {
    const context = makeApp();
    const { headers } = await registerAndLogin(context.app);
    context.aws.failPresign = true;

    const response = await createDocument(context, headers);

    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'storage_unavailable');
  });

  it('devuelve 503 si falla la lista', async () => {
    const context = makeApp();
    const { headers } = await registerAndLogin(context.app);
    context.aws.failQuery = true;

    const response = await request(context.app)
      .get('/api/documents')
      .set(headers);

    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'storage_unavailable');
  });

  it('devuelve 503 si falla el detalle', async () => {
    const context = makeApp();
    const { headers } = await registerAndLogin(context.app);
    const created = await createDocument(context, headers);
    context.aws.failGet = true;

    const response = await request(context.app)
      .get(`/api/documents/${String(created.body.documentId)}`)
      .set(headers);

    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'storage_unavailable');
  });

  it('devuelve la bitacora en orden ascendente', async () => {
    const context = makeApp();
    const { headers, userId } = await registerAndLogin(context.app);
    const created = await createDocument(context, headers);
    const documentId = created.body.documentId as string;

    // El evento inicial usa la hora real; los siguientes se calculan a partir de ella para que
    // el orden sea determinista (no se puede asumir una hora fija).
    const initialAt = context.aws.events[0]?.eventAt ?? '';
    const at = (offsetMs: number, suffix: string) =>
      `${new Date(new Date(initialAt.slice(0, 24)).getTime() + offsetMs).toISOString()}#${suffix}`;

    context.aws.events.push({
      documentId,
      eventAt: at(2000, 'ffffff'),
      eventId: '22222222-2222-4222-8222-222222222222',
      userId: String(userId),
      eventDay: '2026-11-11',
      fromStatus: 'PROCESSING',
      toStatus: 'DONE',
      actor: 'worker',
      schemaVersion: 1,
    });
    context.aws.events.push({
      documentId,
      eventAt: at(1000, 'aaaaaa'),
      eventId: '11111111-1111-4111-8111-111111111111',
      userId: String(userId),
      eventDay: '2026-11-11',
      fromStatus: 'PENDING',
      toStatus: 'PROCESSING',
      actor: 'worker',
      schemaVersion: 1,
    });

    const response = await request(context.app)
      .get(`/api/documents/${documentId}/events`)
      .set(headers);

    assert.equal(response.status, 200);
    const items = response.body.items as Array<{ toStatus: string }>;
    assert.deepEqual(
      items.map((event) => event.toStatus),
      ['PENDING', 'PROCESSING', 'DONE'],
    );
  });

  it('404 en la bitacora de otro usuario, inexistente o mal formada', async () => {
    // 404 en los tres casos: el API no revela si el documento existe o pertenece a otro.
    const context = makeApp();
    const userA = await registerAndLogin(context.app, 'a@example.com');
    const userB = await registerAndLogin(context.app, 'b@example.com');
    const created = await createDocument(context, userA.headers);
    const documentId = created.body.documentId as string;

    const responses = [
      await request(context.app)
        .get(`/api/documents/${documentId}/events`)
        .set(userB.headers),
      await request(context.app)
        .get(`/api/documents/${randomUUID()}/events`)
        .set(userA.headers),
      await request(context.app)
        .get('/api/documents/no-es-uuid/events')
        .set(userA.headers),
    ];

    for (const response of responses) {
      assert.equal(response.status, 404);
      assert.equal(response.body.error, 'not_found');
    }
  });

  it('401 sin token en la bitacora', async () => {
    const context = makeApp();

    const response = await request(context.app).get(
      `/api/documents/${randomUUID()}/events`,
    );

    assert.equal(response.status, 401);
  });

  it('503 si DynamoDB falla al leer la bitacora', async () => {
    // 503 (no 500): la API distingue errores de dependencia de errores internos.
    const context = makeApp();
    const { headers } = await registerAndLogin(context.app);
    const created = await createDocument(context, headers);
    context.aws.failEventsQuery = true;

    const response = await request(context.app)
      .get(`/api/documents/${String(created.body.documentId)}/events`)
      .set(headers);

    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'storage_unavailable');
  });

  it('503 si falla el documento al leer la bitacora', async () => {
    const context = makeApp();
    const { headers } = await registerAndLogin(context.app);
    const created = await createDocument(context, headers);
    context.aws.failGet = true;

    const response = await request(context.app)
      .get(`/api/documents/${String(created.body.documentId)}/events`)
      .set(headers);

    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'storage_unavailable');
  });

  it('devuelve 413 si el cuerpo supera 64 KB', async () => {
    const context = makeApp();
    const { headers } = await registerAndLogin(context.app);

    const response = await request(context.app)
      .post('/api/documents')
      .set(headers)
      .send({
        filename: 'a.pdf',
        contentType: 'application/pdf',
        size: 10,
        padding: 'x'.repeat(70 * 1024),
      });

    assert.equal(response.status, 413);
    assert.equal(response.body.error, 'payload_too_large');
  });
});
