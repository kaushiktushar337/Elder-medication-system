import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../../src/db/sqlite.mjs';
import { remind } from '../../src/features/reminders.ts';

for (const [status, expected] of [[201, 'accepted'], [429, 'retry'], [400, 'failed'], [500, 'review'], [null, 'review']]) {
  test('Brevo response ' + status + ' records ' + expected + ' without leaking care details', async t => {
    const DB = database();
    t.after(() => DB.close());
    const now = Date.now();
    await DB.prepare("INSERT INTO profiles VALUES ('patient','Private name','synthetic@example.test',0)").bind().run();
    await DB.prepare("INSERT INTO appointments(id,profile,name,location,due) VALUES ('visit','patient','Private reason','Private clinic',?)")
      .bind(now + 3600000).run();
    let sent = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      sent++;
      assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
      const body = JSON.parse(options.body);
      assert.equal(options.headers['api-key'], 'synthetic-key');
      assert.deepEqual(body.to, [{ email: 'synthetic@example.test' }]);
      assert.ok(!options.body.includes('Private'));
      assert.ok(options.signal);
      if (status === null) throw new Error('Connection interrupted');
      return new Response('{}', { status });
    });
    const env = { DB, BREVO_API_KEY: 'synthetic-key', BREVO_FROM_EMAIL: 'sender@example.test', APP_URL: 'https://care.test' };
    await remind(env, now);
    const entry = await DB.prepare('SELECT state, attempts FROM deliveries').bind().first();
    assert.equal(entry.state, expected);
    assert.equal(entry.attempts, 1);
    await remind(env, now + 1000);
    assert.equal(sent, 1, 'Immediate rerun must not resend even after an ambiguous provider failure.');
  });
}
