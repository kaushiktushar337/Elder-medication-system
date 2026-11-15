import { DAY, MINUTE, grace, localDay, query, rows } from './worker.ts';

export async function materialize(env, now, profile = null) {
  const start = localDay(now);
  for (const day of [start - DAY, start, start + DAY]) {
    await query(env, `INSERT INTO doses (id, profile, medication, name, amount, due)
      SELECT id || '-' || CAST(first_minute + CAST(? AS BIGINT) AS TEXT), profile, id, name, amount, first_minute + CAST(? AS BIGINT)
      FROM (SELECT *, (CAST(substr(time, 1, 2) AS INTEGER) * 60 + CAST(substr(time, 4, 2) AS INTEGER)) * 60000 AS first_minute
            FROM medications WHERE active = 1 AND (CAST(? AS TEXT) IS NULL OR profile = ?)) AS schedule
      WHERE first_minute + CAST(? AS BIGINT) >= effective
      ON CONFLICT(medication, due) DO UPDATE SET cancelled = 0, name = excluded.name, amount = excluded.amount
      WHERE doses.cancelled = 1`, day, day, profile, profile, day).run();
  }
}

const titles = {
  upcoming: 'A medication reminder is coming up',
  unconfirmed: 'A care check-in may be needed',
  appointment: 'An appointment is coming up'
};

async function deliver(env, message) {
  if (!env.BREVO_API_KEY) return { state: 'unconfigured' };
  const sms = message.channel === 'sms';
  const content = titles[message.kind] + '. Sign in to CareCircle to review the details. ' + (env.APP_URL || '');
  const body = sms
    ? { sender: env.BREVO_SMS_SENDER, recipient: message.to.slice(1), content, type: 'transactional' }
    : { sender: { name: 'CareCircle', email: env.BREVO_FROM_EMAIL }, to: [{ email: message.to }], subject: titles[message.kind], textContent: content };
  try {
    const response = await fetch('https://api.brevo.com/v3/' + (sms ? 'transactionalSMS/send' : 'smtp/email'), {
      method: 'POST', headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(7000)
    });
    if (response.ok) return { state: 'accepted' };
    if (response.status === 429) return { state: 'retry' };
    return { state: response.status >= 500 ? 'review' : 'failed' };
  } catch {
    return { state: 'review' };
  }
}

async function recipients(env, profile, kind) {
  const person = await query(env, 'SELECT email FROM profiles WHERE id = ?', profile).first();
  const contacts = kind === 'upcoming' ? [] : await rows(env, 'SELECT email, phone FROM contacts WHERE profile = ? AND alerts = 1', profile);
  const email = new Set([person.email, ...contacts.map(contact => contact.email)].filter(Boolean));
  const sms = env.BREVO_SMS_SENDER && new Set(contacts.map(contact => contact.phone).filter(Boolean));
  return [...Array.from(email, to => ({ to, channel: 'email' })), ...(sms ? Array.from(sms, to => ({ to, channel: 'sms' })) : [])];
}

export async function remind(env, now = Date.now(), send = message => deliver(env, message)) {
  await materialize(env, now);
  await query(env, "UPDATE deliveries SET state = 'review' WHERE state = 'sending' AND attempted <= ?", now - 5 * MINUTE).run();
  const doses = await rows(env, 'SELECT id, profile, due, demo FROM doses WHERE cancelled = 0 AND taken_at IS NULL AND due BETWEEN ? AND ? ORDER BY due', now - 120 * MINUTE, now + 15 * MINUTE);
  const appointments = await rows(env, 'SELECT id, profile, due FROM appointments WHERE due > ? AND due <= ? ORDER BY due', now, now + DAY);
  const events = [
    ...doses.filter(dose => dose.due > now).map(dose => ({ ...dose, kind: 'upcoming' })),
    ...doses.filter(dose => now >= dose.due + grace(env, dose.demo) && now < dose.due + grace(env, dose.demo) + 60 * MINUTE).map(dose => ({ ...dose, kind: 'unconfirmed' })),
    ...appointments.map(appointment => ({ ...appointment, kind: 'appointment' }))
  ];
  for (const event of events) {
    for (const recipient of await recipients(env, event.profile, event.kind)) {
      const id = event.kind === 'appointment' ? event.id + '-' + event.due : event.id;
      const keys = [id, event.kind, recipient.to, recipient.channel];
      const reserved = await query(env, `INSERT INTO deliveries VALUES (?, ?, ?, ?, ?, 'sending', ?, 1)
        ON CONFLICT(event, kind, recipient, channel) DO UPDATE
        SET state = 'sending', attempted = excluded.attempted, attempts = deliveries.attempts + 1
        WHERE deliveries.state IN ('retry', 'unconfigured') AND deliveries.attempts < 3 AND deliveries.attempted <= ?
        RETURNING attempts`, event.profile, ...keys, now, now - MINUTE).first();
      if (!reserved) continue;
      const current = event.kind === 'appointment'
        ? await query(env, 'SELECT 1 FROM appointments WHERE id = ? AND due = ?', event.id, event.due).first()
        : await query(env, 'SELECT 1 FROM doses WHERE id = ? AND cancelled = 0 AND taken_at IS NULL', event.id).first();
      const active = current && (await recipients(env, event.profile, event.kind)).some(candidate => candidate.channel === recipient.channel && candidate.to === recipient.to);
      let state = 'suppressed';
      if (active) {
        try { ({ state } = await send({ ...recipient, kind: event.kind })); } catch { state = 'review'; }
      }
      await query(env, 'UPDATE deliveries SET state = ? WHERE event = ? AND kind = ? AND recipient = ? AND channel = ? AND state = ? AND attempted = ?', state, ...keys, 'sending', now).run();
    }
  }
}
