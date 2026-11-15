import { DAY, error, json, query, text, uuid } from '../core.ts';

const linkedDoctor = (env, profile, doctor) => query(env, "SELECT id FROM members WHERE id = ? AND profile = ? AND relationship = 'Doctor' AND account IS NOT NULL AND revoked = 0", text(doctor), profile).first();

const futureVisit = (due, now) => Number.isSafeInteger(due) && due > now && due <= now + 366 * DAY;

export async function appointmentRequests(env, { id, action, body, now, profile, member, owner, canRequestAppointment }) {
  if (!id) {
    if (!canRequestAppointment) return error('Only the patient or linked family and caregivers can request an appointment.', 403);
    const name = text(body.name);
    const doctor = await linkedDoctor(env, profile, body.doctor);
    if (!name || !doctor) return error('Choose a linked doctor and enter an appointment title.');
    const requestId = uuid();
    const result = await query(env, 'INSERT INTO appointment_requests (id, profile, doctor, name, requested_at, questions) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', requestId, profile, doctor.id, name, now, text(body.questions, 1000)).run();
    return result.meta.changes ? json({ id: requestId }, 201) : error('This doctor already has a pending request with that title.', 409);
  }
  if (action === 'cancel' && owner) {
    const result = await query(env, "UPDATE appointment_requests SET status = 'cancelled' WHERE id = ? AND profile = ? AND status = 'pending'", id, profile).run();
    return result.meta.changes ? json({ ok: true }) : error('This request is no longer pending.', 409);
  }
  if (['propose', 'questions'].includes(action)) {
    if (!owner) return error('Only the patient can update these visit details.', 403);
    let result;
    if (action === 'questions') {
      result = await query(env, "UPDATE appointment_requests SET questions = ? WHERE id = ? AND profile = ? AND (status = 'pending' OR (status = 'scheduled' AND due > ?))", text(body.questions, 1000), id, profile, now).run();
    } else {
      const proposed = Number(body.due);
      const reason = text(body.reason, 800);
      if (!futureVisit(proposed, now) || !reason) return error('Enter a reason and choose when you are next available.');
      result = await query(env, "UPDATE appointment_requests SET proposed_due = ?, proposed_at = ?, proposal_reason = ?, proposal_state = 'pending' WHERE id = ? AND profile = ? AND status = 'scheduled' AND due > ? AND due <> ?", proposed, now, reason, id, profile, now, proposed).run();
    }
    return result.meta.changes ? json({ ok: true }) : error('The visit is unavailable or that time is already scheduled.', 409);
  }
  if (member.relationship !== 'Doctor') return error('Only the assigned doctor can respond.', 403);
  if (['accept-proposal', 'decline-proposal'].includes(action)) {
    const accepted = action === 'accept-proposal';
    const proposed = Number(body.proposed);
    const result = await query(env, `UPDATE appointment_requests SET proposal_state = ?${accepted ? ', due = proposed_due' : ''}
      WHERE id = ? AND profile = ? AND doctor = ? AND status = 'scheduled' AND proposal_state = 'pending'
      AND due > ? AND proposed_due = ? AND (? = 0 OR proposed_due > ?)`, accepted ? 'accepted' : 'declined', id, profile, member.id, now, proposed, Number(accepted), now).run();
    return result.meta.changes ? json({ ok: true }) : error('This proposed time changed, expired, or already received a response.', 409);
  }
  if (action === 'summary') {
    const summary = text(body.summary, 1500);
    if (!summary) return error('Enter a short visit summary.');
    const result = await query(env, "UPDATE appointment_requests SET visit_summary = ?, summarized_at = ? WHERE id = ? AND profile = ? AND doctor = ? AND status = 'scheduled' AND due <= ?", summary, now, id, profile, member.id, now).run();
    return result.meta.changes ? json({ ok: true }) : error('A summary can be added after the scheduled visit time.', 409);
  }
  if (!['accept', 'decline'].includes(action)) return error('Appointment action not found.', 404);
  const due = Number(body.due);
  if (action === 'accept' && !futureVisit(due, now)) return error('Choose a future appointment time.');
  const result = await query(env, "UPDATE appointment_requests SET status = ?, due = ?, location = ? WHERE id = ? AND profile = ? AND doctor = ? AND status = 'pending'",
    action === 'accept' ? 'scheduled' : 'declined', action === 'accept' ? due : null, action === 'accept' ? text(body.location) : '', id, profile, member.id).run();
  return result.meta.changes ? json({ ok: true }) : error('No pending request for this doctor.', 409);
}

export async function appointments(env, { id, action, method, body, now, profile, member, owner }) {
  if (id && action === 'request-change' && method === 'POST') {
    if (!owner) return error('Only the patient can request a time change.', 403);
    const next = Number(body.due);
    const reason = text(body.reason, 800);
    if (!futureVisit(next, now) || !reason) return error('Enter a reason and choose when you are next available.');
    const doctor = await linkedDoctor(env, profile, body.doctor);
    if (!doctor) return error('Choose a linked doctor.');
    const visit = await query(env, 'SELECT id FROM appointments WHERE id = ? AND profile = ? AND due > ? AND due <> ?', id, profile, now, next).first();
    if (!visit) return error('That appointment or alternate time is unavailable.', 409);
    await env.DB.batch([
      query(env, `INSERT INTO appointment_requests (id, profile, doctor, name, requested_at, status, due, location, proposed_due, proposed_at, proposal_state, proposal_reason)
        SELECT id, profile, ?, name, ?, 'scheduled', due, location, ?, ?, 'pending', ? FROM appointments
        WHERE id = ? AND profile = ? AND due > ? AND due <> ? ON CONFLICT DO NOTHING`, doctor.id, now, next, now, reason, id, profile, now, next),
      query(env, 'DELETE FROM appointments WHERE id = ? AND profile = ? AND EXISTS (SELECT 1 FROM appointment_requests WHERE id = ? AND profile = ?)', id, profile, id, profile)
    ]);
    return json({ ok: true });
  }
  if (member.relationship !== 'Doctor') return error('Send a request to the patient’s linked doctor.', 403);
  if (id && method === 'DELETE') {
    const result = await query(env, 'DELETE FROM appointments WHERE id = ? AND profile = ? AND (doctor = ? OR doctor IS NULL)', id, profile, member.id).run();
    return result.meta.changes ? json({ ok: true }) : error('Appointment not found.', 404);
  }
  if ((!id && method === 'POST') || (id && method === 'PATCH')) {
    const name = text(body.name);
    const location = text(body.location);
    const due = Number(body.due);
    if (!name || !futureVisit(due, now)) return error('Enter a title and a future appointment within one year.');
    if (id) {
      const result = await query(env, 'UPDATE appointments SET name = ?, location = ?, due = ? WHERE id = ? AND profile = ? AND (doctor = ? OR doctor IS NULL)', name, location, due, id, profile, member.id).run();
      return result.meta.changes ? json({ ok: true }) : error('Appointment not found.', 404);
    }
    const appointment = uuid();
    await query(env, 'INSERT INTO appointments (id, profile, name, location, due, doctor) VALUES (?, ?, ?, ?, ?, ?)', appointment, profile, name, location, due, member.id).run();
    return json({ id: appointment }, 201);
  }
}
