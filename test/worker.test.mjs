import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker, { remind } from '../src/worker.ts';
import { database } from '../scripts/database.mjs';

test('passcodes, scoped access, reminder deduplication and handoff', async (context) => {
  context.mock.timers.enable({ apis: ['Date'] });
  let DB;
  if (process.env.TEST_POSTGRES) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { postgresQueries } = await import('../scripts/postgres.mjs');
    const pg = new PGlite();
    context.after(() => pg.close());
    await pg.exec(await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
    await pg.exec(await readFile(new URL('../migrations/0002_checkins.sql', import.meta.url), 'utf8'));
    const wrap = db => ({ query: async (sql, args) => {
      const result = await db.query(sql, args);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    } });
    DB = postgresQueries(operation => operation(wrap(pg)), operation => pg.transaction(tx => operation(wrap(tx))));
  } else {
    DB = database();
  }
  const env = { DB, DEMO_MINUTES: '1' };
  async function api(path, body, cookie, method = body ? 'POST' : 'GET', origin) {
    const response = await worker.fetch(new Request(`https://care.test/api/${path}`, {
      method, headers: { ...(body && { 'content-type': 'application/json' }), ...(cookie && { cookie }), ...(origin && { origin }) },
      body: body && JSON.stringify(body)
    }), env);
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const owner = await api('profiles', { name: 'Asha', email: 'elder@example.com' });
  assert.equal(owner.status, 201);
  const invite = await api('contacts', { name: 'Dev', email: 'dev@example.com', alerts: true, invite: true }, owner.cookie);
  const helper = await api('login', { passcode: invite.data.passcode });
  assert.equal(helper.status, 200);
  const other = await api('profiles', { name: 'Other' });
  assert.equal((await api('state')).status, 401);
  assert.equal((await api('checkins', {}, owner.cookie, 'POST', 'https://other.test')).status, 403);
  assert.equal((await api('medications', { name: 'Test', amount: '1', time: '24:00' }, owner.cookie)).status, 400);
  assert.equal((await api('medications', { name: 'x'.repeat(9000) }, owner.cookie)).status, 413);
  assert.equal((await api('checkins', {}, helper.cookie)).status, 403);
  const requests = await Promise.all(Array.from({ length: 32 }, () => api('checkins', {}, owner.cookie)));
  assert.equal(requests.filter(result => result.status === 409).length, 31);
  const checkin = requests.find(result => result.status === 201);
  assert.ok(checkin);
  const checkinPath = 'checkins/' + checkin.data.id;
  assert.equal((await api('checkins', {}, owner.cookie)).status, 409);
  assert.equal((await api(checkinPath + '/claim', {}, other.cookie)).status, 404);
  assert.equal((await api(checkinPath + '/complete', {}, helper.cookie)).status, 409);
  const due = Date.now() + 3000;
  const medication = await api('medications', { name: 'Demo tablet', amount: '1 tablet', time: '08:00' }, helper.cookie);
  assert.equal(medication.status, 201);
  const appointment = await api('appointments', { name: 'Check-in', due: due + 3_600_000 }, helper.cookie);
  assert.equal(appointment.status, 201);
  const inviteOnly = await api('contacts', { name: 'Invite only', invite: true }, owner.cookie);
  assert.equal((await api('contacts/' + inviteOnly.data.id, { name: 'Renamed' }, owner.cookie, 'PATCH')).status, 200);
  const demo = await api('demo', { due }, owner.cookie);
  assert.equal(demo.status, 201);
  const id = demo.data.id;
  assert.equal((await api(`doses/${id}/claim`, {}, other.cookie)).status, 404);
  const sent = [];
  const send = async (message) => { sent.push(message); return { state: 'accepted' }; };
  await Promise.all(Array.from({ length: 16 }, () => remind(env, due - 1000, send)));
  assert.equal(sent.filter(m => m.to === 'elder@example.com' && m.kind === 'upcoming').length, 1);
  assert.equal(sent.filter(m => m.to === 'dev@example.com' && m.kind === 'appointment').length, 1);
  await remind(env, due + 61_000, send);
  await remind(env, due + 61_000, send);
  assert.equal(sent.filter(m => m.to === 'dev@example.com' && m.kind === 'unconfirmed').length, 1);
  assert.deepEqual(sent.filter(m => m.kind === 'checkin').map(m => m.to), ['dev@example.com']);
  context.mock.timers.setTime(due + 61_000);
  const claims = await Promise.all(Array.from({ length: 32 }, () => api(checkinPath + '/claim', {}, helper.cookie)));
  assert.equal(claims.filter(result => result.status === 200).length, 1);
  assert.equal(claims.filter(result => result.status === 409).length, 31);
  assert.equal((await api(checkinPath + '/complete', {}, helper.cookie)).status, 200);
  assert.equal((await api(`doses/${id}/claim`, {}, helper.cookie)).status, 200);
  assert.equal((await api(`doses/${id}/claim`, {}, owner.cookie)).status, 409);
  assert.equal((await api(`doses/${id}/complete`, {}, helper.cookie)).status, 200);
  const completed = await api('state', undefined, owner.cookie);
  assert.equal(completed.data.doses.find(d => d.id === id).taken_at, null);
  assert.ok(completed.data.doses.find(d => d.id === id).completed_at);
  assert.ok(completed.data.checkins.find(item => item.id === checkin.data.id).completed_at);
  assert.equal((await api(`doses/${id}/taken`, {}, owner.cookie)).status, 200);
  const state = await api('state', undefined, owner.cookie);
  assert.equal(state.data.doses.find(d => d.id === id).claimed_by, 'Dev');
  assert.ok(state.data.doses.find(d => d.id === id).taken_at);
  const next = await api('demo', {}, owner.cookie);
  context.mock.timers.setTime(next.data.due + 1000);
  assert.equal((await api(`doses/${next.data.id}/taken`, {}, owner.cookie)).status, 200);
  const sendsBefore = sent.length;
  await remind(env, next.data.due + 61_000, send);
  assert.equal(sent.length, sendsBefore);
  assert.equal((await api(`contacts/${invite.data.id}/revoke`, {}, owner.cookie)).status, 200);
  assert.equal((await api('state', undefined, helper.cookie)).status, 401);
  context.mock.timers.setTime(due + 2 * 60_000);
  const optIn = await api('contacts', { name: 'Retry target', email: 'retry@example.com', alerts: true }, owner.cookie);
  assert.equal(optIn.status, 201);
  const retryRequest = await api('checkins', {}, owner.cookie);
  assert.equal(retryRequest.status, 201);
  const retryAt = Date.now();
  const retry = async message => ({ state: message.to === 'retry@example.com' ? 'retry' : 'accepted' });
  for (let i = 0; i < 4; i++) await remind(env, retryAt + i * 60_000, retry);
  const activity = (await api('state', undefined, owner.cookie)).data.deliveries;
  const delivery = activity.find(item => item.event === retryRequest.data.id && item.recipient === 'retry@example.com');
  assert.equal(delivery.attempts, 3);
  assert.equal(delivery.state, 'failed');
  const thrownSender = async () => { throw new Error('provider disconnected'); };
  const secondAppointment = await api('appointments', { name: 'Provider test', due: retryAt + 5 * 60_000 }, owner.cookie);
  await remind(env, retryAt + 1000, thrownSender);
  await remind(env, retryAt + 61_000, thrownSender);
  const unknown = (await api('state', undefined, owner.cookie)).data.deliveries.find(item =>
    item.event.startsWith(secondAppointment.data.id) && item.recipient === 'elder@example.com');
  assert.equal(unknown.state, 'review');
  assert.equal(unknown.attempts, 1);
  const invalidLogins = await Promise.all(Array.from({ length: 20 }, () => api('login', { passcode: 'invalid' })));
  assert.ok(invalidLogins.some(result => result.status === 429));
  assert.ok(invalidLogins.every(result => [401, 429].includes(result.status)));
});
