import { materialize, remind, sendInviteEmail } from './reminders.ts';
import { hashPassword, validPassword, verifyPassword } from './password.ts';
export { remind };

export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const IST = 330 * MINUTE;
export const localDay = (now: number) => Math.floor((now + IST) / DAY) * DAY - IST;
export const grace = 30 * MINUTE;
export const query = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
export const rows = async (env, sql, ...args) => (await query(env, sql, ...args).all()).results;
const uuid = () => crypto.randomUUID();
const token = () => uuid().replaceAll('-', '');
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
const error = (message, status = 400) => json({ error: message }, status);
const text = (value, max = 100) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const emailOf = value => text(value, 254).toLowerCase();
const cookieName = 'care_session';
const sessionCookie = (request, value, age) => cookieName + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + age + (new URL(request.url).protocol === 'https:' ? '; Secure' : '');
const sessionToken = request => request.headers.get('cookie')?.match(/(?:^|;\s*)care_session=([a-f0-9]{32})(?:;|$)/)?.[1];
const dateInput = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = Date.parse(value + 'T00:00:00+05:30');
  return Number.isFinite(at) && new Date(at + IST).toISOString().slice(0, 10) === value ? at : null;
};

function medicationPattern(body, now) {
  const start = body.start ? dateInput(body.start) : localDay(now);
  const end = body.end ? dateInput(body.end) : null;
  const interval = Number(body.interval ?? 1);
  const skip = typeof body.skip === 'string' ? [...new Set(body.skip.split(/[\s,]+/).filter(Boolean))] : [];
  if (start === null || (body.end && end === null) || (end !== null && end < start) ||
      !Number.isInteger(interval) || interval < 1 || interval > 90 || skip.length > 90 ||
      skip.some(value => dateInput(value) === null)) return null;
  return [start, end, interval, skip.length ? '|' + skip.join('|') + '|' : ''];
}

async function signIn(request, env, account, body, status = 200) {
  const session = token();
  await query(env, 'INSERT INTO account_sessions VALUES (?, ?, ?)', await hash(session), account, Date.now() + 7 * DAY).run();
  return json(body, status, { 'set-cookie': sessionCookie(request, session, 604800) });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.split('/').slice(2);
  const [resource, id, action] = path;
  const method = request.method;
  const now = Date.now();
  if (method !== 'GET') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin && origin !== env.APP_URL) return error('Origin denied', 403);
    if (!request.headers.get('content-type')?.startsWith('application/json')) return error('JSON required', 415);
  }
  let body = {};
  if (method !== 'GET') {
    const raw = await request.text();
    if (raw.length > 8192) return error('Request too large', 413);
    try { body = JSON.parse(raw); } catch { return error('Invalid JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return error('Invalid request');
  }
  if (method === 'POST' && !id && ['login', 'legacy-login', 'profiles', 'accounts'].includes(resource)) {
    const address = (env.clientAddress || 'local') + ':' + resource;
    const bucket = Math.floor(now / (15 * MINUTE));
    const attempt = await query(env, 'INSERT INTO attempts VALUES (?, ?, 1) ON CONFLICT(address) DO UPDATE SET count = CASE WHEN attempts.bucket = excluded.bucket THEN attempts.count + 1 ELSE 1 END, bucket = excluded.bucket RETURNING count', address, bucket).first();
    if (attempt.count > (resource.includes('login') ? 15 : 8)) return error('Too many attempts. Try again later.', 429);
    if (resource === 'login') {
      const email = emailOf(body.email);
      if (!validEmail(email) || !validPassword(body.password)) return error('Email or password is incorrect.', 401);
      const found = await query(env, 'SELECT id, password_hash FROM accounts WHERE email = ?', email).first();
      if (!await verifyPassword(body.password, found?.password_hash)) return error('Email or password is incorrect.', 401);
      return signIn(request, env, found.id, { ok: true });
    }
    if (resource === 'legacy-login') {
      const passcode = text(body.passcode, 80).replaceAll('-', '').toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(passcode)) return error('Enter your personal sign-in code.', 401);
      const digest = await hash(passcode);
      let account = await query(env, 'SELECT id FROM accounts WHERE pass = ? AND password_hash IS NULL', digest).first();
      if (!account) {
        const legacy = await query(env, "SELECT id, name FROM members WHERE pass = ? AND revoked = 0 AND role = 'owner' AND account IS NULL", digest).first();
        if (!legacy) return error('Invalid sign-in code. Use patient invite keys after signing in.', 401);
        await env.DB.batch([
          query(env, "INSERT INTO accounts (id, name, pass, kind) VALUES (?, ?, ?, 'patient') ON CONFLICT DO NOTHING", legacy.id, legacy.name, digest),
          query(env, "UPDATE members SET account = ?, relationship = 'Patient' WHERE id = ? AND account IS NULL", legacy.id, legacy.id)
        ]);
        account = legacy;
      }
      return signIn(request, env, account.id, { ok: true });
    }
    const name = text(body.name);
    const email = emailOf(body.email);
    if (!name || !validEmail(email) || !validPassword(body.password)) return error('Enter your name, email and a password of 12 to 128 characters.');
    if (resource === 'profiles' && env.PROFILE_SETUP_KEY && body.setupKey !== env.PROFILE_SETUP_KEY) return error('Enter the profile setup key.', 403);
    const profile = uuid();
    const member = uuid();
    if (await query(env, 'SELECT 1 FROM accounts WHERE email = ? UNION ALL SELECT 1 FROM profiles WHERE lower(trim(email)) = ? LIMIT 1', email, email).first()) {
      return error('This email is already in use. Sign in or use an existing personal code.', 409);
    }
    const kind = resource === 'profiles' ? 'patient' : 'care-team';
    const digest = await hash(token());
    const passwordHash = await hashPassword(body.password);
    const changes = [query(env, 'INSERT INTO accounts (id, name, pass, email, password_hash, kind) VALUES (?, ?, ?, ?, ?, ?)', member, name, digest, email, passwordHash, kind)];
    if (kind === 'patient') changes.push(
      query(env, 'INSERT INTO profiles (id, name, email) VALUES (?, ?, ?)', profile, name, email),
      query(env, "INSERT INTO members (id, profile, name, role, pass, account, relationship) VALUES (?, ?, ?, 'owner', ?, ?, 'Patient')", member, profile, name, digest, member)
    );
    try { await env.DB.batch(changes); }
    catch (exception) {
      if (exception?.code === '23505' || exception?.errcode === 2067) return error('This email is already in use. Sign in to continue.', 409);
      throw exception;
    }
    return signIn(request, env, member, { ok: true }, 201);
  }

  const session = sessionToken(request);
  const sessionHash = session && await hash(session);
  const account = sessionHash && await query(env, 'SELECT a.id, a.name, a.kind, a.email FROM account_sessions s JOIN accounts a ON a.id = s.account WHERE s.token = ? AND s.expires > ?', sessionHash, now).first();
  if (!account) return error('Sign in with your personal code.', 401);
  if (resource === 'logout' && method === 'POST') {
    await query(env, 'DELETE FROM account_sessions WHERE token = ?', sessionHash).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, '', 0) });
  }
  if (resource === 'set-login' && method === 'POST') {
    if (account.email) return error('This account already has an email sign-in.', 409);
    const email = emailOf(body.email);
    if (!validEmail(email) || !validPassword(body.password)) return error('Enter a valid email and a password of 12 to 128 characters.');
    const legacy = await query(env, "SELECT p.email FROM profiles p JOIN members m ON m.profile = p.id WHERE m.account = ? AND m.role = 'owner'", account.id).first();
    const profileEmail = emailOf(legacy?.email);
    if (profileEmail && profileEmail !== email &&
        !await query(env, 'SELECT 1 FROM accounts WHERE email = ?', profileEmail).first()) {
      return error('Use the email saved on your patient profile.');
    }
    if (profileEmail !== email &&
        await query(env, 'SELECT 1 FROM profiles WHERE lower(trim(email)) = ? LIMIT 1', email).first()) {
      return error('This email is already associated with another patient profile.', 409);
    }
    const used = await query(env, 'SELECT 1 FROM accounts WHERE email = ? LIMIT 1', email).first();
    if (used) return error('This email is already used by another account.', 409);
    try {
      const result = await query(env, 'UPDATE accounts SET email = ?, password_hash = ? WHERE id = ? AND email IS NULL', email, await hashPassword(body.password), account.id).run();
      if (!result.meta.changes) return error('This account already has an email sign-in.', 409);
    } catch (exception) {
      if (exception?.code === '23505' || exception?.errcode === 2067) return error('This email is already used by another account.', 409);
      throw exception;
    }
    return json({ ok: true });
  }
  if (!account.email && resource !== 'patients') return error('Set up email sign-in to continue.', 403);
  if (resource === 'join' && method === 'POST') {
    if (account.kind !== 'care-team') return error('Only care team accounts can link patients.', 403);
    const passcode = text(body.key, 80).replaceAll('-', '').toLowerCase();
    const relationship = text(body.relationship);
    const decision = text(body.decision) || 'accept';
    if (!/^[a-f0-9]{32}$/.test(passcode) || !['preview', 'accept', 'decline'].includes(decision)) return error('Enter a valid patient invite key.');
    if (decision === 'accept' && !['Family', 'Caregiver', 'Doctor', 'Other'].includes(relationship)) return error('Choose your relationship to the patient.');
    const invite = await query(env, `SELECT m.id, m.profile, p.name FROM members m JOIN profiles p ON p.id = m.profile
      WHERE m.pass = ? AND m.role = 'caregiver' AND m.revoked = 0 AND m.account IS NULL
      AND (m.invite_expires IS NULL OR m.invite_expires > ?) AND (m.invite_email IS NULL OR m.invite_email = ?)`, await hash(passcode), now, account.email).first();
    if (!invite) return error('This invitation is expired, already used, or belongs to a different email.', 404);
    if (decision === 'preview') return json({ name: invite.name });
    if (decision === 'decline') {
      const declined = await query(env, 'UPDATE members SET revoked = 1, declined_at = ? WHERE id = ? AND account IS NULL AND revoked = 0', now, invite.id).run();
      return declined.meta.changes ? json({ ok: true }) : error('This invitation is no longer available.', 409);
    }
    try {
      const result = await query(env, 'UPDATE members SET account = ?, name = ?, relationship = ? WHERE id = ? AND account IS NULL AND revoked = 0 AND NOT EXISTS (SELECT 1 FROM members WHERE profile = ? AND account = ? AND revoked = 0)', account.id, account.name, relationship, invite.id, invite.profile, account.id).run();
      if (result.meta.changes) return json({ patient: invite.profile }, 201);
    } catch (exception) {
      if (exception?.code !== '23505') throw exception;
    }
    return error('This patient is already linked or the invite is unavailable.', 409);
  }
  if (resource === 'patients' && method === 'GET') {
    const patients = await rows(env, `SELECT p.id, p.name, m.relationship, m.role,
      (SELECT COUNT(*) FROM doses d WHERE d.profile = p.id AND d.demo = 0 AND d.cancelled = 0 AND d.taken_at IS NULL AND d.due BETWEEN ? AND ?) AS overdue,
      (SELECT COUNT(*) FROM appointment_requests ar WHERE ar.profile = p.id AND ar.status = 'pending') AS pending
      FROM members m JOIN profiles p ON p.id = m.profile WHERE m.account = ? AND m.revoked = 0
      ORDER BY overdue DESC, pending DESC, p.name, p.id`, localDay(now) - DAY, now - grace, account.id);
    return json({ account: { name: account.name, kind: account.kind, needsSetup: !account.email }, patients });
  }
  const patient = url.searchParams.get('patient');
  if (!patient) return error('Select a patient first.', 400);
  const member = await query(env, 'SELECT * FROM members WHERE account = ? AND profile = ? AND revoked = 0', account.id, patient).first();
  if (!member) return error('This patient is unavailable to your account.', 404);
  const profile = member.profile;
  const owner = member.role === 'owner';
  if (resource === 'state' && method === 'GET') {
    await materialize(env, now, profile);
    const start = localDay(now);
    const [person, medications, appointments, requests, doctors, doses, checkins, contacts, deliveries] = await Promise.all([
      query(env, 'SELECT name, email, demo FROM profiles WHERE id = ?', profile).first(),
      rows(env, 'SELECT * FROM medications WHERE profile = ? AND active = 1 ORDER BY time', profile),
      rows(env, `SELECT id, profile, name, location, due, CAST(NULL AS TEXT) AS status FROM appointments WHERE profile = ?
        UNION ALL SELECT id, profile, name, location, due, status FROM appointment_requests WHERE profile = ? AND status = 'scheduled'
        ORDER BY due`, profile, profile),
      rows(env, `SELECT r.*, m.name AS doctor_name FROM appointment_requests r JOIN members m ON m.id = r.doctor
        WHERE r.profile = ? AND (? = 1 OR r.doctor = ? OR r.status = 'scheduled') ORDER BY r.requested_at DESC LIMIT 30`, profile, Number(owner), member.id),
      owner ? rows(env, "SELECT id, name FROM members WHERE profile = ? AND relationship = 'Doctor' AND account IS NOT NULL AND revoked = 0 ORDER BY name", profile) : [],
      rows(env, 'SELECT * FROM doses WHERE profile = ? AND cancelled = 0 AND demo = 0 AND due >= ? AND due < ? ORDER BY due', profile, start - 6 * DAY, start + DAY),
      rows(env, 'SELECT * FROM checkins WHERE profile = ? AND (completed_at IS NULL OR completed_at >= ?) ORDER BY CASE WHEN completed_at IS NULL THEN 0 ELSE 1 END, requested_at DESC LIMIT 20', profile, start - 6 * DAY),
      owner ? rows(env, 'SELECT c.*, m.revoked, m.relationship, m.account, m.name AS access_name, m.invite_expires, m.declined_at FROM contacts c LEFT JOIN members m ON m.id = c.member WHERE c.profile = ? ORDER BY c.name', profile) : [],
      owner ? rows(env, 'SELECT * FROM deliveries WHERE profile = ? ORDER BY attempted DESC LIMIT 20', profile) : []
    ]);
    return json({ person, me: { id: member.id, name: member.name, owner, relationship: member.relationship }, medications, appointments, requests, doctors, doses, checkins, contacts, deliveries, now, start });
  }
  if (resource === 'appointment-requests' && method === 'POST') {
    if (!id) {
      if (!owner) return error('Only the patient can request an appointment.', 403);
      const name = text(body.name);
      const doctor = await query(env, "SELECT id FROM members WHERE id = ? AND profile = ? AND relationship = 'Doctor' AND account IS NOT NULL AND revoked = 0", text(body.doctor), profile).first();
      if (!name || !doctor) return error('Choose a linked doctor and enter an appointment title.');
      const requestId = uuid();
      const result = await query(env, 'INSERT INTO appointment_requests (id, profile, doctor, name, requested_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', requestId, profile, doctor.id, name, now).run();
      return result.meta.changes ? json({ id: requestId }, 201) : error('This doctor already has a pending request with that title.', 409);
    }
    if (action === 'cancel' && owner) {
      const result = await query(env, "UPDATE appointment_requests SET status = 'cancelled' WHERE id = ? AND profile = ? AND status = 'pending'", id, profile).run();
      return result.meta.changes ? json({ ok: true }) : error('This request is no longer pending.', 409);
    }
    if (member.relationship !== 'Doctor' || !['accept', 'decline'].includes(action)) return error('Only the assigned doctor can respond.', 403);
    const due = Number(body.due);
    if (action === 'accept' && (!Number.isSafeInteger(due) || due <= now || due > now + 366 * DAY)) return error('Choose a future appointment time.');
    const result = await query(env, "UPDATE appointment_requests SET status = ?, due = ?, location = ? WHERE id = ? AND profile = ? AND doctor = ? AND status = 'pending'",
      action === 'accept' ? 'scheduled' : 'declined', action === 'accept' ? due : null, action === 'accept' ? text(body.location) : '', id, profile, member.id).run();
    return result.meta.changes ? json({ ok: true }) : error('No pending request for this doctor.', 409);
  }
  if (resource === 'checkins' && method === 'POST') {
    if (!id) {
      if (!owner) return error('Owner access required.', 403);
      const checkin = uuid();
      const result = await query(env, 'INSERT INTO checkins (id, profile, requested_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', checkin, profile, now).run();
      return result.meta.changes ? json({ id: checkin }, 201) : error('A check-in is already open.', 409);
    }
    if (['claim', 'complete'].includes(action)) {
      const checkin = await query(env, 'SELECT id FROM checkins WHERE id = ? AND profile = ?', id, profile).first();
      if (!checkin) return error('Check-in not found.', 404);
      const update = action === 'claim'
        ? query(env, 'UPDATE checkins SET claimed_member = ?, claimed_by = ?, claimed_at = ? WHERE id = ? AND profile = ? AND claimed_at IS NULL AND completed_at IS NULL', member.id, member.name, now, id, profile)
        : query(env, 'UPDATE checkins SET completed_at = ? WHERE id = ? AND profile = ? AND claimed_at IS NOT NULL AND completed_at IS NULL AND (claimed_member = ? OR ? = 1)', now, id, profile, member.id, Number(owner));
      const result = await update.run();
      return result.meta.changes ? json({ ok: true }) : error('Another member has claimed or completed this check-in, or it still needs a caller.', 409);
    }
  }
  if (resource === 'contacts' && !owner) return error('Owner access required.', 403);
  if (resource === 'contacts') {
    if (id && action === 'revoke' && method === 'POST') {
      const contact = await query(env, 'SELECT member FROM contacts WHERE id = ? AND profile = ?', id, profile).first();
      if (!contact?.member) return error('Invite not found.', 404);
      await env.DB.batch([
        query(env, 'UPDATE members SET revoked = 1 WHERE id = ? AND profile = ?', contact.member, profile),
        query(env, 'DELETE FROM sessions WHERE member = ?', contact.member)
      ]);
      return json({ ok: true });
    }
    if (id && method === 'DELETE') {
      const contact = await query(env, 'SELECT member FROM contacts WHERE id = ? AND profile = ?', id, profile).first();
      if (!contact) return error('Contact not found.', 404);
      const changes = [query(env, 'DELETE FROM contacts WHERE id = ? AND profile = ?', id, profile)];
      if (contact.member) changes.push(query(env, 'UPDATE members SET revoked = 1 WHERE id = ?', contact.member), query(env, 'DELETE FROM sessions WHERE member = ?', contact.member));
      await env.DB.batch(changes);
      return json({ ok: true });
    }
    if ((!id && method === 'POST') || (id && method === 'PATCH')) {
      const name = text(body.name);
      const email = emailOf(body.email);
      const phone = text(body.phone, 25).replace(/[ ()-]/g, '');
      if (!name || (email && !validEmail(email)) || (phone && !/^\+[1-9]\d{6,14}$/.test(phone))) return error('Enter a name and valid contact details.');
      if (id) {
        const contact = await query(env, 'SELECT member FROM contacts WHERE id = ? AND profile = ?', id, profile).first();
        if (!contact) return error('Contact not found.', 404);
        if (!email && !phone && !contact.member) return error('Enter an email or international phone number.');
        const changes = [query(env, 'UPDATE contacts SET name = ?, email = ?, phone = ?, alerts = ? WHERE id = ? AND profile = ?', name, email, phone, body.alerts ? 1 : 0, id, profile)];
        await env.DB.batch(changes);
        return json({ ok: true });
      }
      const emailInvite = body.emailInvite === true;
      const makeInvite = body.invite === true || emailInvite;
      if (emailInvite && !email) return error('Enter the email address for this invitation.');
      if (!email && !phone && !makeInvite) return error('Enter an email or international phone number, or enable an invite.');
      if (makeInvite && email && await query(env, `SELECT 1 FROM accounts WHERE email = ? AND kind = 'patient'
        UNION ALL SELECT 1 FROM profiles WHERE lower(trim(email)) = ? LIMIT 1`, email, email).first()) {
        return error('Patient accounts cannot receive care-team invitations.', 409);
      }
      const contact = uuid();
      const invited = makeInvite ? uuid() : null;
      const passcode = invited ? token() : null;
      if (emailInvite) await query(env, 'UPDATE members SET revoked = 1 WHERE profile = ? AND invite_email = ? AND account IS NULL AND invite_expires <= ?', profile, email, now).run();
      const changes = invited ? [query(env, "INSERT INTO members (id, profile, name, role, pass, invite_email, invite_expires) VALUES (?, ?, ?, 'caregiver', ?, ?, ?)", invited, profile, name, await hash(passcode), emailInvite ? email : null, now + 7 * DAY)] : [];
      changes.push(query(env, 'INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?)', contact, profile, name, email, phone, body.alerts ? 1 : 0, invited));
      try { await env.DB.batch(changes); }
      catch (exception) {
        if (exception?.code === '23505' || exception?.errcode === 2067) return error('An invitation is already pending for that email.', 409);
        throw exception;
      }
      const delivery = emailInvite ? await (env.sendInviteEmail || sendInviteEmail)(env, email, passcode) : null;
      return json({ id: contact, passcode, delivery }, 201);
    }
  }
  if (resource === 'medications') {
    if (id && ['PATCH', 'DELETE'].includes(method)) {
      const previous = await query(env, 'SELECT * FROM medications WHERE id = ? AND profile = ? AND active = 1', id, profile).first();
      if (!previous) return error('Schedule not found.', 404);
      const name = text(body.name);
      const amount = text(body.amount);
      const time = text(body.time);
      const pattern = medicationPattern(body, now);
      if (method === 'PATCH' && (!name || !amount || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !pattern)) return error('Check the medication, time, and schedule dates.');
      const update = method === 'DELETE' ? query(env, 'UPDATE medications SET active = 0 WHERE id = ? AND profile = ?', id, profile) : query(env, 'UPDATE medications SET name = ?, amount = ?, time = ?, effective = ?, start_day = ?, end_day = ?, interval_days = ?, skip_dates = ? WHERE id = ? AND profile = ?', name, amount, time, now, ...pattern, id, profile);
      await env.DB.batch([update, query(env, 'UPDATE doses SET cancelled = 1 WHERE medication = ? AND profile = ? AND due > ? AND taken_at IS NULL', id, profile, now)]);
      return json({ ok: true });
    }
    if (!id && method === 'POST') {
      const name = text(body.name);
      const amount = text(body.amount);
      const time = text(body.time);
      const pattern = medicationPattern(body, now);
      if (!name || !amount || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !pattern) return error('Check the medication, time, and schedule dates.');
      const medication = uuid();
      await query(env, 'INSERT INTO medications (id, profile, name, amount, time, effective, start_day, end_day, interval_days, skip_dates) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', medication, profile, name, amount, time, now, ...pattern).run();
      return json({ id: medication }, 201);
    }
  }
  if (resource === 'appointments') {
    if (owner) return error('Send a request to your linked doctor.', 403);
    if (id && method === 'DELETE') {
      const result = await query(env, 'DELETE FROM appointments WHERE id = ? AND profile = ?', id, profile).run();
      return result.meta.changes ? json({ ok: true }) : error('Appointment not found.', 404);
    }
    if ((!id && method === 'POST') || (id && method === 'PATCH')) {
      const name = text(body.name);
      const location = text(body.location);
      const due = Number(body.due);
      if (!name || !Number.isSafeInteger(due) || due <= now || due > now + 366 * DAY) return error('Enter a title and a future appointment within one year.');
      if (id) {
        const result = await query(env, 'UPDATE appointments SET name = ?, location = ?, due = ? WHERE id = ? AND profile = ?', name, location, due, id, profile).run();
        return result.meta.changes ? json({ ok: true }) : error('Appointment not found.', 404);
      }
      const appointment = uuid();
      await query(env, 'INSERT INTO appointments VALUES (?, ?, ?, ?, ?)', appointment, profile, name, location, due).run();
      return json({ id: appointment }, 201);
    }
  }
  if (resource === 'doses' && id && method === 'POST' && ['taken', 'claim', 'complete'].includes(action)) {
    const dose = await query(env, 'SELECT * FROM doses WHERE id = ? AND profile = ? AND cancelled = 0 AND demo = 0', id, profile).first();
    if (!dose) return error('Dose not found.', 404);
    if (action === 'taken') {
      if (dose.due > now) return error('This dose is upcoming.', 409);
      await query(env, 'UPDATE doses SET taken_at = ?, taken_by = ? WHERE id = ? AND profile = ? AND cancelled = 0 AND taken_at IS NULL', now, member.name, id, profile).run();
      return json({ ok: true });
    }
    if (action === 'complete') {
      const result = await query(env, 'UPDATE doses SET completed_at = ? WHERE id = ? AND profile = ? AND cancelled = 0 AND claimed_at IS NOT NULL AND completed_at IS NULL AND (claimed_member = ? OR ? = 1)', now, id, profile, member.id, Number(owner)).run();
      return result.meta.changes ? json({ ok: true }) : error('This follow-up must be claimed, and only the caller or profile owner can complete it.', 409);
    }
    const result = await query(env, 'UPDATE doses SET claimed_member = ?, claimed_by = ?, claimed_at = ? WHERE id = ? AND profile = ? AND cancelled = 0 AND taken_at IS NULL AND claimed_at IS NULL AND due <= ?', member.id, member.name, now, id, profile, now - grace).run();
    return result.meta.changes ? json({ ok: true }) : error('This follow-up is already claimed, confirmed, or still in its grace period.', 409);
  }
  return error('Page not found.', 404);
}

export default {
  async fetch(request, env) {
    try { return await route(request, env); } catch (exception) {
      console.error('API failure', exception?.code || exception?.name);
      return error('Something went wrong. Try again.', 500);
    }
  }
};
