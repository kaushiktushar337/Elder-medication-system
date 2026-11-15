import { error, grace, json, query, uuid } from '../core.ts';

export async function updateHandoff(env, { method, body, profile, owner, linkedMembers }) {
  if (!owner) return error('Only the patient can change handoff contacts.', 403);
  if (method === 'DELETE') {
    await query(env, 'DELETE FROM handoff_rules WHERE profile = ?', profile).run();
    return json({ ok: true });
  }
  const { primary, backup } = body;
  const wait = Number(body.wait);
  const contacts = await linkedMembers();
  if (primary === backup || !contacts.some(item => item.id === primary) || !contacts.some(item => item.id === backup) ||
      !Number.isInteger(wait) || wait < 5 || wait > 120) return error('Choose two different linked people and a delay of 5 to 120 minutes.');
  await query(env, `INSERT INTO handoff_rules VALUES (?, ?, ?, ?) ON CONFLICT(profile) DO UPDATE SET
    primary_member = excluded.primary_member, backup_member = excluded.backup_member, wait_minutes = excluded.wait_minutes`, profile, primary, backup, wait).run();
  return json({ ok: true });
}

export async function updateCheckin(env, { id, action, now, profile, owner, member }) {
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

export async function updateDose(env, { id, action, now, profile, owner, member }) {
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
