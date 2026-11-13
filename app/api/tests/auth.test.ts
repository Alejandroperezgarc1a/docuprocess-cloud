/**
 * Auth route tests for the DocuProcess Cloud API: registration, login and
 * Bearer JWT validation on protected document routes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { verifyPassword } from '../src/auth.js';
import { makeApp } from './helpers/fakes.js';

describe('auth', () => {
  it('registers, stores the hash and returns 201', async () => {
    const { app, db } = makeApp();

    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'User@Example.COM', password: 'password123' });

    assert.equal(response.status, 201);
    assert.equal(response.body.email, 'user@example.com');
    assert.equal(typeof response.body.id, 'number');

    const user = db.users.get('user@example.com');
    assert.ok(user);
    assert.notEqual(user.password_hash, 'password123');
    assert.match(user.password_hash, /^\$2/);
    assert.equal(await verifyPassword('password123', user.password_hash), true);
  });

  it('returns 409 when the email already exists', async () => {
    const { app } = makeApp();
    const payload = { email: 'dup@example.com', password: 'password123' };

    const first = await request(app).post('/api/auth/register').send(payload);
    const second = await request(app).post('/api/auth/register').send(payload);

    assert.equal(first.status, 201);
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'email_exists');
  });

  it('rejects invalid email', async () => {
    const { app } = makeApp();

    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'no-es-correo', password: 'password123' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'invalid_email');
  });

  it('rejects short password', async () => {
    const { app } = makeApp();

    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'corta@example.com', password: '1234567' });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'weak_password');
  });

  it('rejects password longer than 72 bytes', async () => {
    const { app } = makeApp();

    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'larga@example.com', password: 'a'.repeat(73) });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'weak_password');
  });

  it('rejects invalid JSON', async () => {
    const { app } = makeApp();

    const response = await request(app)
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .send('{');

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'invalid_request');
  });

  it('rejects non-JSON Content-Type', async () => {
    const { app } = makeApp();

    const response = await request(app)
      .post('/api/auth/register')
      .set('Content-Type', 'text/plain')
      .send('{"email":"x@example.com","password":"password123"}');

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'invalid_request');
  });

  it('successful login returns token and claims', async () => {
    const { app, config } = makeApp();
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'login@example.com', password: 'password123' });

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@example.com', password: 'password123' });

    assert.equal(response.status, 200);
    assert.equal(response.body.expiresIn, 3600);
    assert.equal(typeof response.body.token, 'string');

    const payload = jwt.verify(response.body.token, config.jwtSecret, {
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    assert.equal(payload.email, 'login@example.com');
    assert.equal(typeof payload.sub, 'string');
    assert.equal(Number(payload.exp) - Number(payload.iat), 3600);
  });

  it('rejects wrong password', async () => {
    const { app } = makeApp();
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'wrong@example.com', password: 'password123' });

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'wrong@example.com', password: 'otra-clave' });

    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'invalid_credentials');
  });

  it('rejects nonexistent user', async () => {
    const { app } = makeApp();

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nadie@example.com', password: 'password123' });

    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'invalid_credentials');
  });

  it('rejects missing token', async () => {
    const { app } = makeApp();

    const response = await request(app).get('/api/documents');

    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'unauthorized');
    assert.equal(response.headers['www-authenticate'], 'Bearer');
  });

  it('rejects invalid token', async () => {
    const { app } = makeApp();

    const response = await request(app)
      .get('/api/documents')
      .set('Authorization', 'Bearer no-es-un-jwt');

    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'unauthorized');
  });

  it('rejects token with wrong signature', async () => {
    const { app } = makeApp();
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      {
        sub: '1',
        email: 'x@example.com',
        iat: now,
        exp: now + 3600,
      },
      'y'.repeat(32),
      { algorithm: 'HS256' },
    );

    const response = await request(app)
      .get('/api/documents')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(response.status, 401);
  });

  it('rejects expired token', async () => {
    const { app, config } = makeApp();
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      {
        sub: '1',
        email: 'x@example.com',
        iat: now - 7200,
        exp: now - 3600,
      },
      config.jwtSecret,
      { algorithm: 'HS256' },
    );

    const response = await request(app)
      .get('/api/documents')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(response.status, 401);
    assert.equal(response.body.error, 'unauthorized');
  });

  it('rejects token without sub', async () => {
    const { app, config } = makeApp();
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      {
        email: 'x@example.com',
        iat: now,
        exp: now + 3600,
      },
      config.jwtSecret,
      { algorithm: 'HS256' },
    );

    const response = await request(app)
      .get('/api/documents')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(response.status, 401);
  });

  for (const header of ['', 'Bearer', 'Token abc', 'Bearer   ']) {
    it(`rejects invalid Authorization header: "${header}"`, async () => {
      const { app } = makeApp();

      const response = await request(app)
        .get('/api/documents')
        .set('Authorization', header);

      assert.equal(response.status, 401);
    });
  }
});
