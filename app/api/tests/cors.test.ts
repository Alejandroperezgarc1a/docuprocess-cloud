/**
 * CORS middleware tests for DocuProcess Cloud: allowed origins, preflight
 * handling and CORS headers on error responses.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { makeApp, registerAndLogin } from './helpers/fakes.js';

const ALLOWED_ORIGIN = 'http://localhost:5500';
const DISALLOWED_ORIGIN = 'http://evil.example.com';

describe('cors', () => {
  it('returns CORS for an allowed origin', async () => {
    const { app } = makeApp();

    const response = await request(app)
      .get('/api/health')
      .set('Origin', ALLOWED_ORIGIN);

    assert.equal(response.status, 200);
    assert.equal(response.headers['access-control-allow-origin'], ALLOWED_ORIGIN);
    assert.match(response.headers.vary ?? '', /Origin/);
  });

  it('does not return CORS for a disallowed origin', async () => {
    const { app } = makeApp();

    const response = await request(app)
      .get('/api/health')
      .set('Origin', DISALLOWED_ORIGIN);

    assert.equal(response.headers['access-control-allow-origin'], undefined);
  });

  it('answers the documents preflight request', async () => {
    const { app } = makeApp();

    const response = await request(app)
      .options('/api/documents')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization, Content-Type');

    assert.equal(response.status, 200);
    assert.equal(response.headers['access-control-allow-origin'], ALLOWED_ORIGIN);
    assert.match(
      response.headers['access-control-allow-headers'] ?? '',
      /Authorization/,
    );
    assert.match(
      response.headers['access-control-allow-methods'] ?? '',
      /POST/,
    );
  });

  it('the 401 response also carries CORS', async () => {
    const { app } = makeApp();

    const response = await request(app)
      .get('/api/documents')
      .set('Origin', ALLOWED_ORIGIN);

    assert.equal(response.status, 401);
    assert.equal(response.headers['access-control-allow-origin'], ALLOWED_ORIGIN);
  });

  it('an authenticated user receives CORS', async () => {
    const { app } = makeApp();
    const { headers } = await registerAndLogin(app);

    const response = await request(app)
      .get('/api/documents')
      .set(headers)
      .set('Origin', ALLOWED_ORIGIN);

    assert.equal(response.status, 200);
    assert.equal(response.headers['access-control-allow-origin'], ALLOWED_ORIGIN);
  });
});
