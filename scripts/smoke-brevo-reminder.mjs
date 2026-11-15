import assert from 'node:assert/strict';
import { database } from './database.mjs';
import { remind } from '../src/reminders.ts';

if (process.argv[2] !== '--send') throw new Error('Pass --send to send one real test email.');
const { BREVO_API_KEY, BREVO_TEST_EMAIL, APP_URL } = process.env;
const validAddress = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
let sender = process.env.BREVO_FROM_EMAIL?.trim() || '';
if (BREVO_API_KEY && !validAddress(sender) && process.argv.includes('--use-unique-active-sender')) {
  const response = await fetch('https://api.brevo.com/v3/senders', {
    headers: { 'api-key': BREVO_API_KEY },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Brevo sender lookup returned HTTP ' + response.status + '.');
  const { senders } = await response.json();
  const active = senders.filter(entry => entry.active && validAddress(entry.email));
  if (active.length !== 1) throw new Error('Brevo returned ' + active.length + ' active senders. Set BREVO_FROM_EMAIL explicitly.');
  sender = active[0].email;
}
const recipient = BREVO_TEST_EMAIL?.trim() || sender;
if (!BREVO_API_KEY || !validAddress(sender) || !validAddress(recipient)) {
  throw new Error('Configure a Brevo API key, sender, and valid test recipient.');
}

const DB = database();
const env = { DB, BREVO_API_KEY, BREVO_FROM_EMAIL: sender, APP_URL };
const due = Date.now() - 5 * 60_000;
await DB.prepare('INSERT INTO profiles (id, name, email) VALUES (?, ?, ?)').bind('test-patient', 'Synthetic patient', '').run();
await DB.prepare('INSERT INTO accounts (id, name, pass, email) VALUES (?, ?, ?, ?)').bind('test-caregiver', 'Synthetic caregiver', 'unused-test-code', recipient).run();
await DB.prepare("INSERT INTO members (id, profile, name, role, pass, account, relationship) VALUES (?, ?, ?, 'caregiver', ?, ?, 'Family')").bind('test-member', 'test-patient', 'Synthetic caregiver', 'unused-join-code', 'test-caregiver').run();
await DB.prepare('INSERT INTO doses (id, profile, name, amount, due) VALUES (?, ?, ?, ?, ?)').bind('test-dose', 'test-patient', 'Synthetic dose', 'Example', due).run();
let requests = 0;
let providerStatus;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  requests++;
  const response = await originalFetch(...args);
  providerStatus = response.status;
  return response;
};
await remind(env, due + 5 * 60_000 - 1);
assert.equal(requests, 0, 'Reminder ran before the five-minute threshold.');
await remind(env, due + 5 * 60_000);
const delivery = await DB.prepare("SELECT state FROM deliveries WHERE event = 'test-dose' AND kind = 'unconfirmed'").bind().first();
if (delivery?.state !== 'accepted') {
  console.error('Brevo did not accept the test reminder. HTTP status: ' + (providerStatus || 'unavailable') + '. Delivery state: ' + (delivery?.state || 'missing') + '.');
  process.exitCode = 1;
} else {
  await remind(env, due + 6 * 60_000);
  assert.equal(requests, 1, 'The scheduler attempted a duplicate send.');
  console.log('Brevo accepted one five-minute reminder (HTTP ' + providerStatus + '). No earlier or duplicate send occurred.');
}
