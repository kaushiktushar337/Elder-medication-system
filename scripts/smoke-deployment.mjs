import assert from 'node:assert/strict';

const base = new URL(process.argv[2] || '');
assert.ok(base.protocol === 'https:' && base.origin === base.href.slice(0, -1), 'Pass the Vercel HTTPS origin.');
const options = { redirect: 'error', signal: AbortSignal.timeout(90_000) };
const request = (path, init = {}) => fetch(new URL(path, base), { ...options, ...init });

const frontend = await request('/');
assert.equal(frontend.status, 200, 'Frontend did not return HTTP 200.');
assert.match(await frontend.text(), /<title>CareCircle/, 'Unexpected frontend.');
assert.match(frontend.headers.get('content-security-policy') || '', /frame-ancestors 'none'/i);
const health = await request('/api/health');
assert.equal(health.status, 200, 'The Vercel rewrite or Render readiness check failed.');
assert.deepEqual(await health.json(), { ok: true });
const anonymous = await request('/api/patients');
assert.equal(anonymous.status, 401, 'The patient endpoint must deny anonymous access.');
assert.match(anonymous.headers.get('cache-control') || '', /no-store/i);
console.log('Frontend, Vercel API rewrite, Render database readiness, and anonymous access check passed.');

const { CARECIRCLE_TEST_EMAIL: email, CARECIRCLE_TEST_PASSWORD: password } = process.env;
assert.equal(Boolean(email), Boolean(password), 'Set both synthetic account variables or leave both unset.');
if (email && password) {
  const headers = { 'content-type': 'application/json', origin: base.origin };
  const login = await request('/api/login', { method: 'POST', headers, body: JSON.stringify({ email, password }) });
  assert.equal(login.status, 200, 'Synthetic account sign-in failed.');
  const session = login.headers.get('set-cookie') || '';
  const cookie = session.split(';')[0];
  try {
    assert.ok(/^care_session=[a-f0-9]{32}$/.test(cookie), 'The proxy did not return a session cookie.');
    assert.ok(/;\s*HttpOnly/i.test(session) && /;\s*Secure/i.test(session) && /;\s*SameSite=Lax/i.test(session) && !/;\s*Domain=/i.test(session), 'Unexpected hosted session cookie attributes.');
    assert.equal((await request('/api/patients', { headers: { cookie } })).status, 200, 'The proxy did not return the signed-in workspace.');
  } finally {
    const logout = await request('/api/logout', { method: 'POST', headers: { ...headers, cookie }, body: '{}' });
    assert.equal(logout.status, 200, 'Synthetic account sign-out failed.');
  }
  assert.equal((await request('/api/patients', { headers: { cookie } })).status, 401, 'The signed-out session was still accepted.');
  console.log('Secure same-origin sign-in and sign-out passed.');
} else {
  console.log('Synthetic account sign-in check skipped. Set CARECIRCLE_TEST_EMAIL and CARECIRCLE_TEST_PASSWORD to include it.');
}
