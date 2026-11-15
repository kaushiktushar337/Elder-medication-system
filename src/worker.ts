import { materialize, remind } from './reminders.ts';
export { remind };

export const MINUTE = 60_000;
export const DAY = 86_400_000;
export const IST = 330 * MINUTE;
export const localDay = (now: number) => Math.floor((now + IST) / DAY) * DAY - IST;
export const grace = (env, demo) => demo ? Math.max(1, Number(env.DEMO_MINUTES) || 1) * MINUTE : 30 * MINUTE;
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

async function signIn(request, env, member, body, status = 200) {
  const session = token();
  await query(env, 'INSERT INTO sessions VALUES (?, ?, ?)', await hash(session), member, Date.now() + 7 * DAY).run();
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
  if (method === 'POST' && !id && ['login', 'profiles'].includes(resource)) {
    const address = (env.clientAddress || 'local') + ':' + resource;
    const bucket = Math.floor(now / (15 * MINUTE));
    const attempt = await query(env, 'INSERT INTO attempts VALUES (?, ?, 1) ON CONFLICT(address) DO UPDATE SET count = CASE WHEN attempts.bucket = excluded.bucket THEN attempts.count + 1 ELSE 1 END, bucket = excluded.bucket RETURNING count', address, bucket).first();
    if (attempt.count > (resource === 'login' ? 15 : 8)) return error('Too many attempts. Try again later.', 429);
    if (resource === 'login') {
      const passcode = text(body.passcode, 80).replaceAll('-', '').toLowerCase();
      const member = /^[a-f0-9]{32}$/.test(passcode) && await query(env, 'SELECT id FROM members WHERE pass = ? AND revoked = 0', await hash(passcode)).first();
      if (!member) return error('That passcode is invalid or revoked.', 401);
      return signIn(request, env, member.id, { ok: true });
    }
    const name = text(body.name);
    const email = emailOf(body.email);
    if (!name || (email && !validEmail(email))) return error('Enter a name and a valid optional email.');
    if (env.PROFILE_SETUP_KEY && body.setupKey !== env.PROFILE_SETUP_KEY) return error('Enter the profile setup key.', 403);
    const profile = uuid();
    const member = uuid();
    const passcode = token();
    await env.DB.batch([
      query(env, 'INSERT INTO profiles (id, name, email) VALUES (?, ?, ?)', profile, name, email),
      query(env, "INSERT INTO members (id, profile, name, role, pass) VALUES (?, ?, ?, 'owner', ?)", member, profile, name, await hash(passcode))
    ]);
    return signIn(request, env, member, { passcode }, 201);
  }

  const session = sessionToken(request);
  const sessionHash = session && await hash(session);
  const member = sessionHash && await query(env, 'SELECT m.* FROM sessions s JOIN members m ON m.id = s.member WHERE s.token = ? AND s.expires > ? AND m.revoked = 0', sessionHash, now).first();
  if (!member) return error('Sign in with your passcode.', 401);
  const profile = member.profile;
  const owner = member.role === 'owner';
  if (resource === 'logout' && method === 'POST') {
    await query(env, 'DELETE FROM sessions WHERE token = ?', sessionHash).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, '', 0) });
  }
  if (resource === 'state' && method === 'GET') {
    await materialize(env, now, profile);
    const start = localDay(now);
    const [person, medications, appointments, doses, checkins, contacts, deliveries] = await Promise.all([
      query(env, 'SELECT name, email, demo FROM profiles WHERE id = ?', profile).first(),
      rows(env, 'SELECT * FROM medications WHERE profile = ? AND active = 1 ORDER BY time', profile),
      rows(env, 'SELECT * FROM appointments WHERE profile = ? ORDER BY due', profile),
      rows(env, 'SELECT * FROM doses WHERE profile = ? AND cancelled = 0 AND due >= ? AND (demo = 1 OR due < ?) ORDER BY due', profile, start - 6 * DAY, start + DAY),
      rows(env, 'SELECT * FROM checkins WHERE profile = ? AND (completed_at IS NULL OR completed_at >= ?) ORDER BY CASE WHEN completed_at IS NULL THEN 0 ELSE 1 END, requested_at DESC LIMIT 20', profile, start - 6 * DAY),
      owner ? rows(env, 'SELECT c.*, m.revoked FROM contacts c LEFT JOIN members m ON m.id = c.member WHERE c.profile = ? ORDER BY c.name', profile) : [],
      owner ? rows(env, 'SELECT * FROM deliveries WHERE profile = ? ORDER BY attempted DESC LIMIT 20', profile) : []
    ]);
    return json({ person, me: { id: member.id, name: member.name, owner }, medications, appointments, doses, checkins, contacts, deliveries, now, start, demoEnabled: Boolean(env.DEMO_MINUTES), demoGrace: grace(env, true) });
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
  if (['contacts', 'demo'].includes(resource) && !owner) return error('Owner access required.', 403);
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
        if (contact.member) changes.push(query(env, 'UPDATE members SET name = ? WHERE id = ?', name, contact.member));
        await env.DB.batch(changes);
        return json({ ok: true });
      }
      if (!email && !phone && !body.invite) return error('Enter an email or international phone number, or enable an invite.');
      const contact = uuid();
      const invited = body.invite ? uuid() : null;
      const passcode = invited ? token() : null;
      const changes = invited ? [query(env, "INSERT INTO members (id, profile, name, role, pass) VALUES (?, ?, ?, 'caregiver', ?)", invited, profile, name, await hash(passcode))] : [];
      changes.push(query(env, 'INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?)', contact, profile, name, email, phone, body.alerts ? 1 : 0, invited));
      await env.DB.batch(changes);
      return json({ id: contact, passcode }, 201);
    }
  }
  if (resource === 'medications') {
    if (id && ['PATCH', 'DELETE'].includes(method)) {
      const previous = await query(env, 'SELECT * FROM medications WHERE id = ? AND profile = ? AND active = 1', id, profile).first();
      if (!previous) return error('Schedule not found.', 404);
      const name = text(body.name);
      const amount = text(body.amount);
      const time = text(body.time);
      if (method === 'PATCH' && (!name || !amount || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) return error('Enter the medication, amount, and daily time.');
      const update = method === 'DELETE' ? query(env, 'UPDATE medications SET active = 0 WHERE id = ? AND profile = ?', id, profile) : query(env, 'UPDATE medications SET name = ?, amount = ?, time = ?, effective = ? WHERE id = ? AND profile = ?', name, amount, time, now, id, profile);
      await env.DB.batch([update, query(env, 'UPDATE doses SET cancelled = 1 WHERE medication = ? AND profile = ? AND due > ? AND taken_at IS NULL', id, profile, now)]);
      return json({ ok: true });
    }
    if (!id && method === 'POST') {
      const name = text(body.name);
      const amount = text(body.amount);
      const time = text(body.time);
      if (!name || !amount || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return error('Enter the medication, amount, and daily time.');
      const medication = uuid();
      await query(env, 'INSERT INTO medications (id, profile, name, amount, time, effective) VALUES (?, ?, ?, ?, ?, ?)', medication, profile, name, amount, time, now).run();
      return json({ id: medication }, 201);
    }
  }
  if (resource === 'appointments') {
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
  if (resource === 'demo' && method === 'POST') {
    if (!env.DEMO_MINUTES) return error('Demo scheduling is disabled.', 404);
    const due = Number(body.due ?? now + 20_000);
    if (!Number.isSafeInteger(due) || due < now || due > now + MINUTE) return error('Choose a demo time in the next minute.');
    const demo = uuid();
    await env.DB.batch([
      query(env, 'UPDATE profiles SET demo = 1 WHERE id = ?', profile),
      query(env, 'INSERT INTO doses (id, profile, name, amount, due, demo) VALUES (?, ?, ?, ?, ?, 1)', demo, profile, 'Demo tablet', 'Synthetic example', due)
    ]);
    return json({ id: demo, due }, 201);
  }
  if (resource === 'doses' && id && method === 'POST' && ['taken', 'claim', 'complete'].includes(action)) {
    const dose = await query(env, 'SELECT * FROM doses WHERE id = ? AND profile = ? AND cancelled = 0', id, profile).first();
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
    const result = await query(env, 'UPDATE doses SET claimed_member = ?, claimed_by = ?, claimed_at = ? WHERE id = ? AND profile = ? AND cancelled = 0 AND taken_at IS NULL AND claimed_at IS NULL AND due <= ?', member.id, member.name, now, id, profile, now - grace(env, dose.demo)).run();
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
