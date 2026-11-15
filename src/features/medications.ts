import { IST, error, json, localDay, query, text, uuid } from '../core.ts';

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

function scheduleValues(body, now) {
  const name = text(body.name);
  const amount = text(body.amount);
  const time = text(body.time);
  const pattern = medicationPattern(body, now);
  if (!name || !amount || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !pattern) return null;
  return [name, amount, time, now, ...pattern];
}

export async function medications(env, { id, action, method, body, now, profile, member }) {
  if (id && action === 'photo') {
    const medication = await query(env, 'SELECT id FROM medications WHERE id = ? AND profile = ? AND active = 1', id, profile).first();
    if (!medication) return error('Medication not found.', 404);
    if (method === 'GET') {
      const photo = await query(env, 'SELECT jpeg FROM medication_photos WHERE medication = ?', id).first();
      if (!photo) return error('Photo not found.', 404);
      return new Response(Buffer.from(photo.jpeg, 'base64'), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
    }
    if (method === 'DELETE') {
      await query(env, 'DELETE FROM medication_photos WHERE medication = ?', id).run();
      return json({ ok: true });
    }
    if (method === 'POST') {
      const jpeg = body.jpeg;
      if (typeof jpeg !== 'string' || jpeg.length > 170_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(jpeg)) return error('Choose a JPEG under 125 KB.');
      const bytes = Buffer.from(jpeg, 'base64');
      if (bytes.length < 20 || bytes.length > 125_000 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return error('This photo is not a valid JPEG.');
      await query(env, 'INSERT INTO medication_photos VALUES (?, ?, ?) ON CONFLICT(medication) DO UPDATE SET jpeg = excluded.jpeg, revision = excluded.revision', id, jpeg, uuid()).run();
      return json({ ok: true });
    }
    return error('Photo action not found.', 404);
  }
  if (id && ['PATCH', 'DELETE'].includes(method)) {
    const previous = await query(env, 'SELECT * FROM medications WHERE id = ? AND profile = ? AND active = 1', id, profile).first();
    if (!previous) return error('Schedule not found.', 404);
    const values = method === 'PATCH' ? scheduleValues(body, now) : null;
    if (method === 'PATCH' && !values) return error('Check the medication, time, and schedule dates.');
    const update = values
      ? query(env, `UPDATE medications SET name = ?, amount = ?, time = ?, effective = ?, start_day = ?,
          end_day = ?, interval_days = ?, skip_dates = ?, updated_by = ? WHERE id = ? AND profile = ?`, ...values, member.name, id, profile)
      : query(env, 'UPDATE medications SET active = 0 WHERE id = ? AND profile = ?', id, profile);
    await env.DB.batch([update, query(env, 'UPDATE doses SET cancelled = 1 WHERE medication = ? AND profile = ? AND due > ? AND taken_at IS NULL', id, profile, now)]);
    return json({ ok: true });
  }
  if (!id && method === 'POST') {
    const values = scheduleValues(body, now);
    if (!values) return error('Check the medication, time, and schedule dates.');
    const medication = uuid();
    await query(env, `INSERT INTO medications (id, profile, name, amount, time, effective, start_day,
      end_day, interval_days, skip_dates, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, medication, profile, ...values, member.name).run();
    return json({ id: medication }, 201);
  }
}
