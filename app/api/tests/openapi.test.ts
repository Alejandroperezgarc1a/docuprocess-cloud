/**
 * OpenAPI tests for the DocuProcess Cloud API: spec served at /api/openapi.json
 * and Swagger UI served at /api/docs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { makeApp } from './helpers/fakes.js';

describe('openapi', () => {
  it('serves the OpenAPI specification', async () => {
    const { app } = makeApp();

    const response = await request(app).get('/api/openapi.json');

    assert.equal(response.status, 200);
    assert.equal(response.body.openapi, '3.0.3');
    assert.ok(response.body.paths['/api/health']);
    assert.ok(response.body.paths['/api/ready']);
    assert.ok(response.body.paths['/api/auth/register']);
    assert.ok(response.body.paths['/api/documents']);
    assert.ok(response.body.paths['/api/documents/{documentId}/events']);
    assert.ok(response.body.components.schemas.DocumentEvent);
    assert.ok(response.body.components.securitySchemes.bearerAuth);
  });

  it('serves Swagger UI', async () => {
    const { app } = makeApp();

    const response = await request(app).get('/api/docs/');

    assert.equal(response.status, 200);
    assert.match(response.text, /swagger-ui/i);
  });

  it('redirects /api/docs to /api/docs/', async () => {
    const { app } = makeApp();

    const response = await request(app).get('/api/docs');

    assert.equal(response.status, 301);
    assert.equal(response.headers.location, '/api/docs/');
  });
});
