import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/http/router.ts';
import { database } from '../../src/db/sqlite.mjs';

test('request validation rejects malformed bodies, foreign origins and unsupported methods', async t => {
  const DB = database();
  t.after(() => DB.close());
  const cases = [
    { name: 'foreign origin', headers: { origin: 'https://attacker.test' }, body: '{}', status: 403 },
    { name: 'null origin', headers: { origin: 'null' }, body: '{}', status: 403 },
    { name: 'wrong content type', headers: { 'content-type': 'text/plain' }, body: '{}', status: 415 },
    { name: 'malformed JSON', body: '{', status: 400 },
    { name: 'array JSON', body: '[]', status: 400 },
    { name: 'null JSON', body: 'null', status: 400 },
    { name: 'oversized JSON', body: JSON.stringify({ data: 'x'.repeat(9000) }), status: 413 },
    { name: 'unsupported method', method: 'PUT', body: '{}', status: 405 },
    { name: 'extra route segment', path: 'profiles/a/b/c', body: '{}', status: 404 }
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const response = await worker.fetch(new Request('https://care.test/api/' + (item.path || 'profiles'), {
        method: item.method || 'POST',
        headers: { 'content-type': 'application/json', ...item.headers },
        body: item.body
      }), { DB });
      assert.equal(response.status, item.status);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    });
  }
  assert.equal((await DB.prepare('SELECT COUNT(*) AS count FROM accounts').bind().first()).count, 0);
});

test('another linked doctor cannot edit or delete an assigned direct appointment', async t => {
  const DB = database();
  t.after(() => DB.close());
  const { appointments } = await import('../../src/features/appointments.ts');
  await DB.prepare("INSERT INTO profiles VALUES ('patient', 'Synthetic', '', 0)").bind().run();
  for (const id of ['doctor-a', 'doctor-b']) {
    await DB.prepare("INSERT INTO members(id,profile,name,role,pass,relationship) VALUES (?, 'patient', ?, 'caregiver', ?, 'Doctor')")
      .bind(id, id, id).run();
  }
  const now = Date.now();
  await DB.prepare("INSERT INTO appointments(id,profile,name,location,due,doctor) VALUES ('visit','patient','Original','Clinic',?,'doctor-a')")
    .bind(now + 3600000).run();
  const context = { id: 'visit', profile: 'patient', now, member: { id: 'doctor-b', relationship: 'Doctor' }, body: { name: 'Changed', due: now + 7200000 } };
  assert.equal((await appointments({ DB }, { ...context, method: 'PATCH' })).status, 404);
  assert.equal((await appointments({ DB }, { ...context, method: 'DELETE' })).status, 404);
  assert.equal((await DB.prepare("SELECT name FROM appointments WHERE id='visit'").bind().first()).name, 'Original');
  assert.equal((await appointments({ DB }, { ...context, member: { id: 'doctor-a', relationship: 'Doctor' }, method: 'PATCH' })).status, 200);
});
