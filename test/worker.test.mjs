import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker, { remind } from '../src/worker.ts';
import { database } from '../scripts/database.mjs';

test('passcodes, scoped access, reminder deduplication and handoff', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-15T07:50:00+05:30') });
  let DB;
  if (process.env.TEST_POSTGRES) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { postgresQueries } = await import('../scripts/postgres.mjs');
    const pg = new PGlite();
    context.after(() => pg.close());
    await pg.exec(await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
    await pg.exec(await readFile(new URL('../migrations/0002_checkins.sql', import.meta.url), 'utf8'));
    await pg.exec(await readFile(new URL('../migrations/0003_accounts.sql', import.meta.url), 'utf8'));
    await pg.exec(await readFile(new URL('../migrations/0004_login.sql', import.meta.url), 'utf8'));
    await pg.exec(await readFile(new URL('../migrations/0005_care_plans.sql', import.meta.url), 'utf8'));
    await pg.exec(await readFile(new URL('../migrations/0006_invites.sql', import.meta.url), 'utf8'));
    const wrap = db => ({ query: async (sql, args) => {
      const result = await db.query(sql, args);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    } });
    DB = postgresQueries(operation => operation(wrap(pg)), operation => pg.transaction(tx => operation(wrap(tx))));
  } else {
    DB = database();
  }
  const invitationEmails = [];
  const env = { DB, sendInviteEmail: async (_env, to, key) => {
    invitationEmails.push({ to, key });
    return 'accepted';
  } };
  const selected = new Map();
  async function api(path, body, cookie, method = body ? 'POST' : 'GET', origin, patient = selected.get(cookie)) {
    const response = await worker.fetch(new Request(`https://care.test/api/${path}${patient ? '?patient=' + patient : ''}`, {
      method, headers: { ...(body && { 'content-type': 'application/json' }), ...(cookie && { cookie }), ...(origin && { origin }) },
      body: body && JSON.stringify(body)
    }), env);
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const password = 'synthetic-password-123';
  const ownerSignup = await api('profiles', { name: 'Asha', email: 'elder@example.com', password });
  assert.equal(ownerSignup.status, 201);
  assert.equal((await api('logout', {}, ownerSignup.cookie)).status, 200);
  assert.equal((await api('patients', undefined, ownerSignup.cookie)).status, 401);
  const owner = await api('login', { email: 'ELDER@example.com', password });
  assert.equal(owner.status, 200);
  assert.equal((await api('profiles', { name: 'Duplicate', email: 'Elder@example.com', password })).status, 409);
  assert.equal((await api('accounts', { name: 'Duplicate', email: ' ELDER@example.com ', password })).status, 409);
  const concurrentSignup = await Promise.all([
    api('accounts', { name: 'First request', email: 'race@example.com', password }),
    api('profiles', { name: 'Second request', email: 'RACE@example.com', password })
  ]);
  assert.deepEqual(concurrentSignup.map(result => result.status).sort(), [201, 409]);
  const [{ id: patient }] = (await api('patients', undefined, owner.cookie)).data.patients;
  selected.set(owner.cookie, patient);
  const invite = await api('contacts', { name: 'Dev', email: 'dev@example.com', alerts: true, invite: true }, owner.cookie);
  assert.equal((await api('legacy-login', { passcode: invite.data.passcode })).status, 401);
  const signup = await api('accounts', { name: 'Dev', email: 'doctor@example.com', password });
  assert.equal(signup.status, 201);
  assert.equal((await api('login', { email: 'doctor@example.com', password: 'different-password' })).status, 401);
  const helper = await api('login', { email: 'doctor@example.com', password });
  assert.equal((await api('join', { key: invite.data.passcode, relationship: 'Doctor' }, helper.cookie)).status, 201);
  assert.equal((await api('join', { key: invite.data.passcode, relationship: 'Doctor' }, helper.cookie)).status, 404);
  selected.set(helper.cookie, patient);
  const other = await api('profiles', { name: 'Other', email: 'other@example.com', password });
  const [{ id: otherPatient }] = (await api('patients', undefined, other.cookie)).data.patients;
  selected.set(other.cookie, otherPatient);
  assert.equal((await api('contacts', { name: 'Other', email: 'OTHER@example.com', emailInvite: true }, owner.cookie)).status, 409);
  const emailed = await api('contacts', { name: 'Doctor', email: 'doctor@example.com', emailInvite: true }, other.cookie);
  assert.equal(emailed.data.delivery, 'accepted');
  assert.deepEqual(invitationEmails, [{ to: 'doctor@example.com', key: emailed.data.passcode }]);
  assert.equal((await api('contacts', { name: 'Doctor', email: 'doctor@example.com', emailInvite: true }, other.cookie)).status, 409);
  assert.equal((await api('join', { key: emailed.data.passcode, decision: 'preview' }, owner.cookie)).status, 403);
  const unrelated = await api('accounts', { name: 'Unrelated', email: 'unrelated@example.com', password });
  assert.equal((await api('join', { key: emailed.data.passcode, decision: 'preview' }, unrelated.cookie)).status, 404);
  assert.equal((await api('join', { key: emailed.data.passcode, decision: 'preview' }, helper.cookie)).data.name, 'Other');
  assert.equal((await api('join', { key: emailed.data.passcode, decision: 'decline' }, helper.cookie)).status, 200);
  assert.equal((await api('join', { key: emailed.data.passcode, relationship: 'Doctor' }, helper.cookie)).status, 404);
  assert.ok((await api('state', undefined, other.cookie)).data.contacts.find(item => item.id === emailed.data.id).declined_at);
  const secondEmail = await api('contacts', { name: 'Dev', email: 'doctor@example.com', emailInvite: true }, other.cookie);
  assert.equal((await api('join', { key: secondEmail.data.passcode, decision: 'accept', relationship: 'Doctor' }, helper.cookie)).status, 201);
  const roster = (await api('state', undefined, other.cookie)).data.contacts;
  assert.ok(roster.some(item => item.access_name === 'Dev' && item.relationship === 'Doctor' && item.account && !item.revoked));
  assert.equal((await api('patients', undefined, helper.cookie)).data.patients.length, 2);
  const [{ id: doctor }] = (await api('state', undefined, owner.cookie)).data.doctors;
  const request = await api('appointment-requests', { name: 'Review appointment', doctor }, owner.cookie);
  assert.equal(request.status, 201);
  const requestPath = 'appointment-requests/' + request.data.id;
  assert.equal((await api(requestPath + '/accept', { due: Date.now() + 3600000 }, owner.cookie)).status, 403);
  assert.equal((await api('patients', undefined, helper.cookie)).data.patients.find(item => item.id === patient).pending, 1);
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
  const due = Date.now() + 10 * 60_000;
  const medication = await api('medications', { name: 'Demo tablet', amount: '1 tablet', time: '08:00' }, helper.cookie);
  assert.equal(medication.status, 201);
  const appointment = await api('appointments', { name: 'Check-in', due: due + 3_600_000 }, helper.cookie);
  assert.equal(appointment.status, 201);
  const inviteOnly = await api('contacts', { name: 'Invite only', invite: true }, owner.cookie);
  assert.equal((await api('contacts/' + inviteOnly.data.id, { name: 'Renamed' }, owner.cookie, 'PATCH')).status, 200);
  assert.equal((await api('demo', { due }, owner.cookie)).status, 404);
  const id = (await api('state', undefined, owner.cookie)).data.doses[0].id;
  assert.equal((await api('state', undefined, helper.cookie, 'GET', undefined, otherPatient)).data.medications.length, 0);
  assert.equal((await api('medications/' + medication.data.id, { name: 'Wrong patient', amount: '1', time: '08:00' }, helper.cookie, 'PATCH', undefined, otherPatient)).status, 404);
  assert.equal((await api(`doses/${id}/claim`, {}, other.cookie)).status, 404);
  const sent = [];
  const send = async (message) => { sent.push(message); return { state: 'accepted' }; };
  await Promise.all(Array.from({ length: 16 }, () => remind(env, due - 1000, send)));
  assert.equal(sent.filter(m => m.to === 'elder@example.com' && m.kind === 'upcoming').length, 1);
  assert.equal(sent.filter(m => m.to === 'dev@example.com' && m.kind === 'appointment').length, 1);
  assert.deepEqual(sent.filter(m => m.kind === 'appointment_request').map(m => m.to), ['doctor@example.com']);
  await remind(env, due + 31 * 60_000, send);
  await remind(env, due + 31 * 60_000, send);
  assert.equal(sent.filter(m => m.to === 'dev@example.com' && m.kind === 'unconfirmed').length, 1);
  assert.deepEqual(sent.filter(m => m.kind === 'checkin').map(m => m.to), ['dev@example.com']);
  context.mock.timers.setTime(due + 31 * 60_000);
  assert.equal((await api('patients', undefined, helper.cookie)).data.patients.find(item => item.id === patient).overdue, 1);
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
  const sendsBefore = sent.length;
  await remind(env, Date.now() + 1000, send);
  assert.equal(sent.length, sendsBefore);
  const dueAppointment = Date.now() + 7_200_000;
  assert.equal((await api(requestPath + '/accept', { due: dueAppointment, location: 'Clinic' }, helper.cookie)).status, 200);
  assert.equal((await api(requestPath + '/accept', { due: dueAppointment }, helper.cookie)).status, 409);
  assert.equal((await api('state', undefined, owner.cookie)).data.appointments.find(item => item.id === request.data.id).due, dueAppointment);
  const pattern = await api('medications', {
    name: 'Alternate pattern', amount: 'One', time: '09:00',
    start: '2026-11-15', end: '2026-11-19', interval: 2, skip: '2026-11-17'
  }, other.cookie);
  assert.equal(pattern.status, 201);
  assert.equal((await api('state', undefined, other.cookie)).data.doses.filter(item => item.medication === pattern.data.id).length, 1);
  for (const day of [16, 17, 18, 19, 20]) await remind(env, Date.parse('2026-11-' + day + 'T07:50:00+05:30'), send);
  const planned = await DB.prepare('SELECT due FROM doses WHERE medication = ? AND cancelled = 0 ORDER BY due').bind(pattern.data.id).all();
  assert.deepEqual(planned.results.map(item => new Date(item.due + 330 * 60_000).toISOString().slice(0, 10)), ['2026-11-15', '2026-11-19']);
  const secondAppointment = await api('appointments', { name: 'Provider test', due: Date.now() + 6 * 60_000 }, helper.cookie);
  assert.equal(secondAppointment.status, 201);
  assert.equal((await api(`contacts/${invite.data.id}/revoke`, {}, owner.cookie)).status, 200);
  assert.equal((await api('state', undefined, helper.cookie)).status, 404);
  assert.equal((await api('state', undefined, helper.cookie, 'GET', undefined, otherPatient)).status, 200);
  context.mock.timers.setTime(due + 32 * 60_000);
  const optIn = await api('contacts', { name: 'Retry target', email: 'retry@example.com', alerts: true }, owner.cookie);
  assert.equal(optIn.status, 201);
  const retryRequest = await api('checkins', {}, owner.cookie);
  assert.equal(retryRequest.status, 201);
  const retryAt = Date.now();
  const retry = async message => {
    if (message.kind === 'appointment') throw new Error('provider disconnected');
    return { state: message.to === 'retry@example.com' ? 'retry' : 'accepted' };
  };
  for (let i = 0; i < 4; i++) await remind(env, retryAt + i * 60_000, retry);
  const activity = (await api('state', undefined, owner.cookie)).data.deliveries;
  const delivery = activity.find(item => item.event === retryRequest.data.id && item.recipient === 'retry@example.com');
  assert.equal(delivery.attempts, 3);
  assert.equal(delivery.state, 'failed');
  const thrownSender = async () => { throw new Error('provider disconnected'); };
  await remind(env, retryAt + 1000, thrownSender);
  await remind(env, retryAt + 61_000, thrownSender);
  const unknown = (await api('state', undefined, owner.cookie)).data.deliveries.find(item =>
    item.event.startsWith(secondAppointment.data.id) && item.recipient === 'elder@example.com');
  assert.equal(unknown.state, 'review');
  assert.equal(unknown.attempts, 1);
  const oldCode = 'abcdef0123456789abcdef0123456789';
  const oldDigest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(oldCode))).toString('hex');
  await DB.prepare('INSERT INTO profiles (id, name, email) VALUES (?, ?, ?)').bind('legacy-profile', 'Legacy patient', '').run();
  await DB.prepare("INSERT INTO members (id, profile, name, role, pass) VALUES (?, ?, ?, 'owner', ?)").bind('legacy-owner', 'legacy-profile', 'Legacy patient', oldDigest).run();
  const legacyLogin = await api('legacy-login', { passcode: oldCode });
  assert.equal(legacyLogin.status, 200);
  assert.deepEqual((await api('patients', undefined, legacyLogin.cookie)).data.patients.map(item => item.id), ['legacy-profile']);
  assert.equal((await api('set-login', { email: 'legacy@example.com', password }, legacyLogin.cookie)).status, 200);
  assert.equal((await api('legacy-login', { passcode: oldCode })).status, 401);
  assert.equal((await api('login', { email: 'legacy@example.com', password })).status, 200);
  const invalidLogins = await Promise.all(Array.from({ length: 20 }, () => api('login', { passcode: 'invalid' })));
  assert.ok(invalidLogins.some(result => result.status === 429));
  assert.ok(invalidLogins.every(result => [401, 429].includes(result.status)));
});
