import { authenticate, setLogin } from '../auth/accounts.ts';
import { joinWithCode, respondToInboxInvite, updateContacts } from '../features/care-circle.ts';
import { updateCheckin, updateDose, updateHandoff } from '../features/followups.ts';
import { updateRefill } from '../features/refills.ts';
import { dashboardState, patientOverview } from '../features/dashboard.ts';
import { medications } from '../features/medications.ts';
import { hash, sessionCookie, sessionToken } from '../auth/sessions.ts';
import { remind } from '../features/reminders.ts';
import { appointments, appointmentRequests } from '../features/appointments.ts';
import { error, json, query, rows } from '../core.ts';
export { remind };

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.split('/').slice(2);
  const [resource, id, action] = path;
  const method = request.method;
  const now = Date.now();
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) {
    return json({ error: 'Method not allowed' }, 405, { allow: 'GET, POST, PATCH, DELETE' });
  }
  if (path.length > 3 || !resource || path.some(segment => !segment)) return error('Page not found.', 404);
  let body = {};
  if (method !== 'GET') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin && origin !== env.APP_URL) return error('Origin denied', 403);
    if (!request.headers.get('content-type')?.startsWith('application/json')) return error('JSON required', 415);
    const raw = await request.text();
    if (raw.length > (resource === 'medications' && action === 'photo' ? 172_000 : 8192)) return error('Request too large', 413);
    try { body = JSON.parse(raw); } catch { return error('Invalid JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return error('Invalid request');
  }
  if (method === 'POST' && !id && ['login', 'legacy-login', 'profiles', 'accounts'].includes(resource)) {
    return authenticate(env, request, { resource, body, now });
  }
  const session = sessionToken(request);
  const sessionHash = session && await hash(session);
  const account = sessionHash && await query(env, 'SELECT a.id, a.name, a.kind, a.email, a.workspace FROM account_sessions s JOIN accounts a ON a.id = s.account WHERE s.token = ? AND s.expires > ?', sessionHash, now).first();
  if (!account) return error('Sign in with your personal code.', 401);
  if (resource === 'logout' && method === 'POST') {
    await query(env, 'DELETE FROM account_sessions WHERE token = ?', sessionHash).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, '', 0) });
  }
  if (resource === 'set-login' && method === 'POST') return setLogin(env, account, body);
  if (!account.email && resource !== 'patients') return error('Set up email sign-in to continue.', 403);
  if (resource === 'join' && method === 'POST') return joinWithCode(env, { account, body, now });
  if (resource === 'invitations' && id && method === 'POST') return respondToInboxInvite(env, { id, account, body, now });
  if (resource === 'patients' && method === 'GET') return patientOverview(env, account, now);
  const patient = url.searchParams.get('patient');
  if (!patient) return error('Select a patient first.', 400);
  const member = await query(env, 'SELECT * FROM members WHERE account = ? AND profile = ? AND revoked = 0', account.id, patient).first();
  if (!member) return error('This patient is unavailable to your account.', 404);
  return routePatientRequest(env, member, { resource, id, action, method, now, body });
}

async function routePatientRequest(env, member, request) {
  const { resource, id, action, method, now, body } = request;
  const profile = member.profile;
  const owner = member.role === 'owner';
  const canRequestAppointment = owner || ['Family', 'Caregiver'].includes(member.relationship);
  const linkedMembers = () => rows(env, "SELECT m.id, m.name, m.relationship FROM members m JOIN accounts a ON a.id = m.account WHERE m.profile = ? AND m.role = 'caregiver' AND m.revoked = 0 AND a.email IS NOT NULL ORDER BY m.name", profile);
  if (resource === 'handoff' && ['POST', 'DELETE'].includes(method)) {
    return updateHandoff(env, { method, body, profile, owner, linkedMembers });
  }
  if (resource === 'refills' && id && ['POST', 'DELETE'].includes(method)) {
    return updateRefill(env, { id, method, body, now, profile, owner, linkedMembers });
  }
  if (resource === 'state' && method === 'GET') {
    return dashboardState(env, { now, profile, member, owner, canRequestAppointment, linkedMembers });
  }
  if (resource === 'appointment-requests' && method === 'POST') {
    return appointmentRequests(env, { id, action, body, now, profile, member, owner, canRequestAppointment });
  }
  if (resource === 'checkins' && method === 'POST') {
    const response = await updateCheckin(env, { id, action, now, profile, owner, member });
    if (response) return response;
  }
  if (resource === 'contacts' && !owner) return error('Owner access required.', 403);
  if (resource === 'contacts') {
    const response = await updateContacts(env, { id, action, method, body, now, profile });
    if (response) return response;
  }
  if (resource === 'medications') {
    const response = await medications(env, { id, action, method, body, now, profile, member });
    if (response) return response;
  }
  if (resource === 'appointments') {
    const response = await appointments(env, { id, action, method, body, now, profile, member, owner });
    if (response) return response;
  }
  if (resource === 'doses' && id && method === 'POST' && ['taken', 'claim', 'complete'].includes(action)) {
    return updateDose(env, { id, action, now, profile, owner, member });
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
