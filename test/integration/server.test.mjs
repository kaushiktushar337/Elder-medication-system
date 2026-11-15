import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('HTTP server protects sessions, serves security headers and handles concurrent reads', { timeout: 30000 }, async t => {
  // Whitelist the environment so tests cannot use a live database or email sender.
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('../../', import.meta.url),
    env: { ...env, PORT: '0', DATABASE_PATH: ':memory:' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Test server did not start.')), 10000);
    const finish = (error, value) => {
      clearTimeout(timeout);
      error ? reject(error) : resolve(value);
    };
    child.once('error', error => finish(error));
    child.once('exit', code => finish(new Error('Test server exited with code ' + code)));
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/listening on port (\d+)/);
      if (match) finish(null, Number(match[1]));
    });
  });
  const base = 'http://127.0.0.1:' + port;
  const request = (path, init = {}) => fetch(base + path, { signal: AbortSignal.timeout(10000), ...init });
  const post = (path, body, cookie) => request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, ...(cookie && { cookie }) },
    body: JSON.stringify(body)
  });

  await t.test('static responses and readiness', async () => {
    const response = await request('/');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(await response.text(), /CareCircle/);
    for (const asset of ['/js/app.js', '/js/appointments.js', '/js/medication-photo.js', '/js/view-helpers.js',
      '/js/language.js', '/js/i18n/hi.js', '/css/styles.css']) {
      const assetResponse = await request(asset);
      assert.equal(assetResponse.status, 200, asset + ' must be served after the folder restructure');
      assert.ok((await assetResponse.text()).length > 0);
    }
    assert.deepEqual(await (await request('/api/health')).json(), { ok: true });
    assert.equal((await request('/.env')).status, 404);
    assert.equal((await request('/api/patients')).status, 401);
  });

  await t.test('transport request size enforcement', async () => {
    const response = await post('/api/profiles', { name: 'x'.repeat(10000) });
    assert.equal(response.status, 413);
  });

  const credentials = { name: 'HTTP test', email: 'http-test@example.test', password: 'synthetic-password-123' };
  const signup = await post('/api/profiles', credentials);
  assert.equal(signup.status, 201);
  const session = signup.headers.get('set-cookie');
  assert.match(session, /HttpOnly/);
  assert.match(session, /SameSite=Lax/);
  const cookie = session.split(';')[0];
  const patients = await (await request('/api/patients', { headers: { cookie } })).json();
  const patient = patients.patients[0].id;

  await t.test('24 simultaneous dashboard reads stay scoped and return consistent data', async () => {
    const results = await Promise.all(Array.from({ length: 24 }, () =>
      request('/api/state?patient=' + patient, { headers: { cookie } })));
    assert.ok(results.every(result => result.status === 200));
    for (const response of results) {
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const state = await response.json();
      assert.equal(state.person.name, credentials.name);
      assert.equal(state.me.owner, true);
    }
  });
  assert.equal((await post('/api/logout', {}, cookie)).status, 200);
  assert.equal((await request('/api/patients', { headers: { cookie } })).status, 401);
});
