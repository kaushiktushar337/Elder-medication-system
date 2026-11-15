import { DAY, grace, json, localDay, query, rows } from '../core.ts';
import { materialize } from './reminders.ts';
import { refillForecast, refillLevels, remaining } from './refills.ts';

export async function dashboardState(env, { now, profile, member, owner, canRequestAppointment, linkedMembers }) {
  await materialize(env, now, profile);
  const start = localDay(now);
  const [person, medications, appointments, requests, doctors, doses, checkins, contacts, deliveries] = await Promise.all([
    query(env, 'SELECT name, email, demo FROM profiles WHERE id = ?', profile).first(),
    rows(env, 'SELECT m.*, p.revision AS photo_revision FROM medications m LEFT JOIN medication_photos p ON p.medication = m.id WHERE m.profile = ? AND m.active = 1 ORDER BY m.time', profile),
    rows(env, `SELECT id, profile, name, location, due, doctor, CAST(NULL AS TEXT) AS status FROM appointments WHERE profile = ?
      UNION ALL SELECT id, profile, name, location, due, doctor, status FROM appointment_requests WHERE profile = ? AND status = 'scheduled'
      ORDER BY due`, profile, profile),
    rows(env, `SELECT r.*, m.name AS doctor_name FROM appointment_requests r JOIN members m ON m.id = r.doctor
      WHERE r.profile = ? AND (? = 1 OR r.doctor = ?) ORDER BY r.requested_at DESC LIMIT 30`, profile, Number(owner), member.id),
    canRequestAppointment ? rows(env, "SELECT id, name FROM members WHERE profile = ? AND relationship = 'Doctor' AND account IS NOT NULL AND revoked = 0 ORDER BY name", profile) : [],
    rows(env, 'SELECT * FROM doses WHERE profile = ? AND cancelled = 0 AND demo = 0 AND due >= ? AND due < ? ORDER BY due', profile, start - 6 * DAY, start + DAY),
    rows(env, 'SELECT * FROM checkins WHERE profile = ? AND (completed_at IS NULL OR completed_at >= ?) ORDER BY CASE WHEN completed_at IS NULL THEN 0 ELSE 1 END, requested_at DESC LIMIT 20', profile, start - 6 * DAY),
    owner ? rows(env, 'SELECT c.*, m.revoked, m.relationship, m.account, m.name AS access_name, m.invite_expires, m.declined_at FROM contacts c LEFT JOIN members m ON m.id = c.member WHERE c.profile = ? ORDER BY c.name', profile) : [],
    owner ? rows(env, 'SELECT * FROM deliveries WHERE profile = ? ORDER BY attempted DESC LIMIT 20', profile) : []
  ]);
  const [refills, handoff, people, handoffNotices] = await Promise.all([
    refillLevels(env, profile),
    query(env, 'SELECT * FROM handoff_rules WHERE profile = ?', profile).first(),
    owner ? linkedMembers() : [],
    rows(env, `SELECT d.event, d.kind, d.attempted, a.name FROM deliveries d JOIN accounts a ON a.email = d.recipient
      WHERE d.profile = ? AND d.state = 'accepted' AND d.kind IN ('checkin', 'unconfirmed', 'checkin_backup', 'dose_backup')
      ORDER BY attempted DESC LIMIT 80`, profile)
  ]);
  const delegatedRequests = !owner && canRequestAppointment ? await rows(env, `SELECT r.id, r.name, r.status, r.due, r.location, m.name AS doctor_name
    FROM appointment_requests r JOIN members m ON m.id = r.doctor WHERE r.profile = ? AND r.status = 'pending' ORDER BY r.requested_at DESC LIMIT 30`, profile) : [];
  return json({ person, me: { id: member.id, name: member.name, owner, relationship: member.relationship, canRequestAppointment }, medications, appointments, requests: [...requests, ...delegatedRequests], doctors, doses, checkins, contacts, deliveries,
    refills: refills.map(item => ({ medication: item.medication, name: item.name, remaining: remaining(item), threshold: item.threshold, contact: item.contact, runout: refillForecast(item, now) })),
    handoff, people, handoffNotices, now, start, doseGrace: grace });
}

export async function patientOverview(env, account, now) {
  const patients = await rows(env, `SELECT p.id, p.name, m.relationship, m.role,
    (SELECT COUNT(*) FROM doses d WHERE d.profile = p.id AND d.demo = 0 AND d.cancelled = 0 AND d.taken_at IS NULL AND d.due BETWEEN ? AND ?) AS overdue,
    (SELECT COUNT(*) FROM appointment_requests ar WHERE ar.profile = p.id AND (ar.status = 'pending' OR (ar.proposal_state = 'pending' AND ar.due > ?))) AS pending
    FROM members m JOIN profiles p ON p.id = m.profile WHERE m.account = ? AND m.revoked = 0
    ORDER BY overdue DESC, pending DESC, p.name, p.id`, localDay(now) - DAY, now - grace, now, account.id);
  const workspace = account.kind === 'patient' ? 'patient' : account.workspace === 'doctor' || patients.some(item => item.relationship === 'Doctor') ? 'doctor' : 'family';
  const inbox = account.kind === 'care-team' && account.email ? await rows(env, `SELECT m.id, p.name FROM members m JOIN profiles p ON p.id = m.profile
    WHERE m.invited_account = ? AND m.account IS NULL AND m.revoked = 0 AND m.invite_expires > ? ORDER BY m.invite_expires DESC`, account.id, now) : [];
  const visits = workspace === 'doctor' ? await rows(env, `SELECT * FROM (
    SELECT r.id, r.profile AS patient, p.name AS patient_name, r.name, r.due, r.status, r.requested_at AS sort_date
    FROM appointment_requests r JOIN members m ON m.id = r.doctor JOIN profiles p ON p.id = r.profile
    WHERE m.account = ? AND m.revoked = 0 AND (r.status = 'pending' OR (r.status = 'scheduled' AND r.due > ?))
    UNION ALL
    SELECT a.id, a.profile, p.name, a.name, a.due, 'scheduled', a.due
    FROM appointments a JOIN members m ON m.profile = a.profile JOIN profiles p ON p.id = a.profile
    WHERE m.account = ? AND m.relationship = 'Doctor' AND m.revoked = 0 AND a.due > ?
    ) AS upcoming ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, due, sort_date LIMIT 25`, account.id, now, account.id, now) : [];
  return json({ account: { name: account.name, kind: account.kind, workspace, needsSetup: !account.email }, patients, inbox, visits });
}
