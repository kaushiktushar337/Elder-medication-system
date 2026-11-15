import { DAY, IST, MINUTE, grace, localDay, query, rows } from './shared.ts';
import { refillForecast, refillLevels, remaining } from './refills.ts';

export async function materialize(env, now, profile = null) {
  const start = localDay(now);
  const days = [start - DAY, start, start + DAY].flatMap(day =>
    [day, '%|' + new Date(day + IST).toISOString().slice(0, 10) + '|%']);
  return query(env, `WITH days(day, skip) AS (
      VALUES (CAST(? AS BIGINT), CAST(? AS TEXT)), (CAST(? AS BIGINT), CAST(? AS TEXT)), (CAST(? AS BIGINT), CAST(? AS TEXT))
    ), schedule AS (
      SELECT m.id, m.profile, m.name, m.amount, m.effective,
        days.day + (CAST(substr(m.time, 1, 2) AS INTEGER) * 60 + CAST(substr(m.time, 4, 2) AS INTEGER)) * 60000 AS due
      FROM medications m CROSS JOIN days
      WHERE m.active = 1 ${profile === null ? '' : 'AND m.profile = ?'}
        AND (m.start_day IS NULL OR (m.start_day <= days.day AND ((days.day - m.start_day) / 86400000) % m.interval_days = 0))
        AND (m.end_day IS NULL OR m.end_day >= days.day) AND m.skip_dates NOT LIKE days.skip
    )
    INSERT INTO doses (id, profile, medication, name, amount, due)
    SELECT id || '-' || CAST(due AS TEXT), profile, id, name, amount, due
    FROM schedule WHERE due >= effective
    ON CONFLICT(medication, due) DO UPDATE SET cancelled = 0, name = excluded.name, amount = excluded.amount
    WHERE doses.cancelled = 1`, ...days, ...(profile === null ? [] : [profile])).run();
}

const titles = {
  upcoming: 'A medication reminder is coming up',
  unconfirmed: 'A scheduled dose is still unconfirmed',
  checkin: 'Someone in your care circle asked for a check-in',
  checkin_backup: 'A check-in still needs a responder',
  dose_backup: 'An overdue dose still needs a responder',
  refill: 'A medication refill may be needed',
  appointment_request: 'A patient requested an appointment',
  appointment_change: 'A patient proposed a different appointment time',
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

const emails = (...values) => [...new Set(values.filter(Boolean))].map(to => ({ to, channel: 'email' }));

async function handoffContacts(env, profile) {
  return query(env, `SELECT h.wait_minutes, pa.email AS primary_email, ba.email AS backup_email
    FROM handoff_rules h
    LEFT JOIN members pm ON pm.id = h.primary_member AND pm.revoked = 0 AND pm.profile = h.profile
    LEFT JOIN accounts pa ON pa.id = pm.account
    LEFT JOIN members bm ON bm.id = h.backup_member AND bm.revoked = 0 AND bm.profile = h.profile
    LEFT JOIN accounts ba ON ba.id = bm.account
    WHERE h.profile = ?`, profile).first();
}

async function recipients(env, event, now) {
  const { profile, kind, doctor } = event;
  if (kind === 'refill') {
    const [refill] = await refillLevels(env, profile, event.id);
    if (!refill || remaining(refill) > refill.threshold || !refillForecast(refill, now)) return [];
    const address = await query(env, `SELECT p.email AS patient_email, a.email AS contact_email FROM profiles p
      LEFT JOIN members m ON m.id = ? AND m.profile = p.id AND m.revoked = 0
      LEFT JOIN accounts a ON a.id = m.account WHERE p.id = ?`, refill.contact, profile).first();
    return emails(address?.contact_email || address?.patient_email);
  }
  if (['appointment_request', 'appointment_change'].includes(kind)) {
    const recipient = await query(env, "SELECT a.email FROM members m JOIN accounts a ON a.id = m.account WHERE m.id = ? AND m.profile = ? AND m.revoked = 0 AND m.relationship = 'Doctor'", doctor, profile).first();
    return recipient?.email ? [{ to: recipient.email, channel: 'email' }] : [];
  }
  if (['checkin', 'unconfirmed', 'checkin_backup', 'dose_backup'].includes(kind)) {
    const handoff = await handoffContacts(env, profile);
    if (kind.endsWith('_backup')) {
      if (!handoff?.primary_email || !handoff.backup_email || now < event.ready + handoff.wait_minutes * MINUTE) return [];
      return emails(handoff.backup_email);
    }
    if (handoff?.primary_email || handoff?.backup_email) return emails(handoff.primary_email || handoff.backup_email);
  }
  if (kind === 'unconfirmed') {
    const careTeam = await rows(env, `SELECT a.email FROM members m JOIN accounts a ON a.id = m.account
      WHERE m.profile = ? AND m.revoked = 0 AND m.role = 'caregiver'
      UNION SELECT c.email FROM contacts c WHERE c.profile = ? AND c.alerts = 1 AND c.member IS NULL`, profile, profile);
    return careTeam.filter(item => item.email).map(item => ({ to: item.email, channel: 'email' }));
  }
  const person = await query(env, 'SELECT email FROM profiles WHERE id = ?', profile).first();
  const contacts = kind === 'upcoming' ? [] : await rows(env, `SELECT c.email, c.phone FROM contacts c LEFT JOIN members m ON m.id = c.member
    WHERE c.profile = ? AND c.alerts = 1 AND m.declined_at IS NULL AND (m.id IS NULL OR m.revoked = 0)`, profile);
  const email = new Set([kind === 'checkin' ? '' : person.email, ...contacts.map(contact => contact.email)].filter(Boolean));
  const sms = env.BREVO_SMS_SENDER && new Set(contacts.map(contact => contact.phone).filter(Boolean));
  return [...Array.from(email, to => ({ to, channel: 'email' })), ...(sms ? Array.from(sms, to => ({ to, channel: 'sms' })) : [])];
}

async function eventIsCurrent(env, event, now) {
  const { id, kind } = event;
  if (kind === 'appointment_change') {
    return query(env, "SELECT 1 FROM appointment_requests WHERE id = ? AND proposal_state = 'pending' AND proposed_at = ? AND due > ? AND proposed_due > ?", id, event.proposed_at, now, now).first();
  }
  if (kind === 'appointment_request') {
    return query(env, "SELECT 1 FROM appointment_requests WHERE id = ? AND status = 'pending'", id).first();
  }
  if (kind === 'appointment') {
    return event.status === 'scheduled'
      ? query(env, "SELECT 1 FROM appointment_requests WHERE id = ? AND status = 'scheduled' AND due = ?", id, event.due).first()
      : query(env, 'SELECT 1 FROM appointments WHERE id = ? AND due = ?', id, event.due).first();
  }
  if (kind === 'checkin' || kind === 'checkin_backup') {
    return query(env, 'SELECT 1 FROM checkins WHERE id = ? AND claimed_at IS NULL AND completed_at IS NULL', id).first();
  }
  if (kind === 'refill') return true; // The recipient lookup rechecks the refill snapshot and remaining stock.
  return query(env, 'SELECT 1 FROM doses WHERE id = ? AND cancelled = 0 AND taken_at IS NULL AND claimed_at IS NULL', id).first();
}

export async function remind(env, now = Date.now(), send = message => deliver(env, message)) {
  await materialize(env, now);
  await query(env, "UPDATE deliveries SET state = 'review' WHERE state = 'sending' AND attempted <= ?", now - 5 * MINUTE).run();
  const doses = await rows(env, 'SELECT id, profile, due FROM doses WHERE demo = 0 AND cancelled = 0 AND taken_at IS NULL AND claimed_at IS NULL AND due BETWEEN ? AND ? ORDER BY due', now - DAY, now + 15 * MINUTE);
  const appointments = await rows(env, 'SELECT id, profile, due FROM appointments WHERE due > ? AND due <= ? ORDER BY due', now, now + DAY);
  const requests = await rows(env, "SELECT id, profile, doctor, due, status FROM appointment_requests WHERE (status = 'pending' AND requested_at BETWEEN ? AND ?) OR (status = 'scheduled' AND due BETWEEN ? AND ?)", now - DAY, now, now, now + DAY);
  const proposals = await rows(env, "SELECT id, profile, doctor, proposed_at FROM appointment_requests WHERE proposal_state = 'pending' AND due > ? AND proposed_due > ? AND proposed_at >= ?", now, now, now - DAY);
  const checkins = await rows(env, 'SELECT id, profile, requested_at FROM checkins WHERE claimed_at IS NULL AND completed_at IS NULL AND requested_at BETWEEN ? AND ?', now - DAY, now);
  const refills = (await refillLevels(env)).filter(item => remaining(item) <= item.threshold);
  const events = [
    ...checkins.filter(item => now < item.requested_at + 60 * MINUTE).map(checkin => ({ ...checkin, kind: 'checkin' })),
    ...checkins.map(item => ({ ...item, kind: 'checkin_backup', ready: item.requested_at })),
    ...requests.map(item => ({ ...item, kind: item.status === 'pending' ? 'appointment_request' : 'appointment' })),
    ...proposals.map(item => ({ ...item, kind: 'appointment_change' })),
    ...doses.filter(dose => dose.due > now).map(dose => ({ ...dose, kind: 'upcoming' })),
    ...doses.filter(dose => now >= dose.due + grace && now < dose.due + grace + 60 * MINUTE).map(dose => ({ ...dose, kind: 'unconfirmed' })),
    ...doses.filter(item => now >= item.due + grace).map(item => ({ ...item, kind: 'dose_backup', ready: item.due + grace })),
    ...refills.map(item => ({ id: item.snapshot, profile: item.profile, kind: 'refill' })),
    ...appointments.map(appointment => ({ ...appointment, kind: 'appointment' }))
  ];
  for (const event of events) {
    for (const recipient of await recipients(env, event, now)) {
      const id = event.kind === 'appointment' ? event.id + '-' + event.due : event.kind === 'appointment_change' ? event.id + '-' + event.proposed_at : event.id;
      const keys = [id, event.kind, recipient.to, recipient.channel];
      const reserved = await query(env, `INSERT INTO deliveries VALUES (?, ?, ?, ?, ?, 'sending', ?, 1)
        ON CONFLICT(event, kind, recipient, channel) DO UPDATE
        SET state = 'sending', attempted = excluded.attempted, attempts = deliveries.attempts + 1
        WHERE deliveries.state IN ('retry', 'unconfigured') AND deliveries.attempts < 3 AND deliveries.attempted <= ?
        RETURNING attempts`, event.profile, ...keys, now, now - MINUTE).first();
      if (!reserved) continue;
      const current = await eventIsCurrent(env, event, now);
      const active = current && (await recipients(env, event, now)).some(candidate => candidate.channel === recipient.channel && candidate.to === recipient.to);
      let state = 'suppressed';
      if (active) {
        try { ({ state } = await send({ ...recipient, kind: event.kind })); } catch { state = 'review'; }
      }
      if (state === 'retry' && reserved.attempts >= 3) state = 'failed';
      await query(env, 'UPDATE deliveries SET state = ? WHERE event = ? AND kind = ? AND recipient = ? AND channel = ? AND state = ? AND attempted = ?', state, ...keys, 'sending', now).run();
    }
  }
}
