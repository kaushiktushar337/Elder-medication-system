import { randomInt } from 'node:crypto';
import { DAY, error, json, query, text, token, uniqueViolation, uuid } from '../core.ts';
import { emailOf, validEmail } from '../auth/email.ts';
import { hash, rateExceeded } from '../auth/sessions.ts';

const inviteAlphabet = '23456789abcdefghjkmnpqrstuvwxyz';
const shortCode = () => Array.from({ length: 6 }, () => inviteAlphabet[randomInt(inviteAlphabet.length)]).join('');
const validRelationship = value => ['Family', 'Caregiver', 'Doctor', 'Other'].includes(value);
async function respondToInvite(env, account, invite, decision, relationship, now) {
  try {
    const result = decision === 'decline'
      ? await query(env, 'UPDATE members SET revoked = 1, declined_at = ? WHERE id = ? AND account IS NULL AND revoked = 0', now, invite.id).run()
      : await query(env, 'UPDATE members SET account = ?, name = ?, relationship = ? WHERE id = ? AND account IS NULL AND revoked = 0 AND NOT EXISTS (SELECT 1 FROM members WHERE profile = ? AND account = ? AND revoked = 0)', account.id, account.name, relationship, invite.id, invite.profile, account.id).run();
    if (result.meta.changes) return decision === 'decline' ? json({ ok: true }) : json({ patient: invite.profile }, 201);
  } catch (exception) {
    if (!uniqueViolation(exception)) throw exception;
  }
  return error('This patient is already linked or the invitation is unavailable.', 409);
}

export async function joinWithCode(env, { account, body, now }) {
  if (account.kind !== 'care-team') return error('Only care team accounts can link patients.', 403);
  const passcode = text(body.key, 80).replaceAll('-', '').toLowerCase();
  const relationship = text(body.relationship);
  const decision = text(body.decision) || 'accept';
  if (await rateExceeded(env, 'join:account:' + account.id, now, 12)) return error('Too many invite attempts. Try again later.', 429);
  if (!/^(?:[a-f0-9]{32}|[a-z0-9]{6})$/.test(passcode) || !['preview', 'accept', 'decline'].includes(decision)) return error('Enter a valid patient invite code.');
  if (decision === 'accept' && !validRelationship(relationship)) return error('Choose your relationship to the patient.');
  const invite = await query(env, `SELECT m.id, m.profile, p.name FROM members m JOIN profiles p ON p.id = m.profile
    WHERE m.pass = ? AND m.role = 'caregiver' AND m.revoked = 0 AND m.account IS NULL
    AND m.invited_account IS NULL AND (m.invite_expires IS NULL OR m.invite_expires > ?) AND (m.invite_email IS NULL OR m.invite_email = ?)`, await hash(passcode), now, account.email).first();
  if (!invite) return error('This invitation is expired, already used, or belongs to a different email.', 404);
  if (decision === 'preview') return json({ name: invite.name });
  return respondToInvite(env, account, invite, decision, relationship, now);
}

export async function respondToInboxInvite(env, { id, account, body, now }) {
  if (account.kind !== 'care-team') return error('Only care team accounts can respond to invitations.', 403);
  const invite = await query(env, 'SELECT id, profile FROM members WHERE id = ? AND invited_account = ? AND account IS NULL AND revoked = 0 AND invite_expires > ?', id, account.id, now).first();
  if (!invite) return error('This invitation is no longer available.', 404);
  const { decision, relationship } = body;
  if (decision !== 'decline' && (decision !== 'accept' || !validRelationship(relationship))) return error('Choose your relationship to the patient.');
  return respondToInvite(env, account, invite, decision, relationship, now);
}

export async function updateContacts(env, { id, action, method, body, now, profile }) {
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
    const emailInvite = !id && body.emailInvite === true;
    if ((!name && !emailInvite) || (email && !validEmail(email)) || (phone && !/^\+[1-9]\d{6,14}$/.test(phone))) return error('Enter a name and valid contact details.');
    if (id) {
      const contact = await query(env, 'SELECT member FROM contacts WHERE id = ? AND profile = ?', id, profile).first();
      if (!contact) return error('Contact not found.', 404);
      if (!email && !phone && !contact.member) return error('Enter an email or international phone number.');
      const changes = [query(env, 'UPDATE contacts SET name = ?, email = ?, phone = ?, alerts = ? WHERE id = ? AND profile = ?', name, email, phone, body.alerts ? 1 : 0, id, profile)];
      await env.DB.batch(changes);
      return json({ ok: true });
    }
    const makeInvite = body.invite === true || emailInvite;
    if (emailInvite && !email) return error('Enter the email address for this invitation.');
    if (!email && !phone && !makeInvite) return error('Enter an email or international phone number, or enable an invite.');
    if (makeInvite && email && await query(env, `SELECT 1 FROM accounts WHERE email = ? AND kind = 'patient'
      UNION ALL SELECT 1 FROM profiles WHERE lower(trim(email)) = ? LIMIT 1`, email, email).first()) {
      return error('Patient accounts cannot receive care-team invitations.', 409);
    }
    const target = emailInvite ? await query(env, "SELECT id, name FROM accounts WHERE email = ? AND kind = 'care-team'", email).first() : null;
    if (emailInvite && !target) return error('No care-team account uses that email. Ask them to sign up, then try again.', 404);
    if (target && await query(env, 'SELECT 1 FROM members WHERE profile = ? AND account = ? AND revoked = 0', profile, target.id).first()) {
      return error('This person already has access to your profile.', 409);
    }
    const contact = uuid();
    const invited = makeInvite ? uuid() : null;
    let passcode = invited && !emailInvite ? shortCode() : null;
    if (emailInvite) await query(env, 'UPDATE members SET revoked = 1 WHERE profile = ? AND invite_email = ? AND account IS NULL AND invite_expires <= ?', profile, email, now).run();
    for (let attempt = 0; attempt < 4; attempt++) {
      const changes = invited ? [query(env, "INSERT INTO members (id, profile, name, role, pass, invite_email, invite_expires, invited_account) VALUES (?, ?, ?, 'caregiver', ?, ?, ?, ?)", invited, profile, target?.name || name, await hash(passcode || token()), emailInvite ? email : null, now + (emailInvite ? 7 : 1) * DAY, target?.id || null)] : [];
      changes.push(query(env, 'INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?)', contact, profile, target?.name || name, email, phone, body.alerts ? 1 : 0, invited));
      try {
        await env.DB.batch(changes);
        return json({ id: contact, passcode: passcode?.toUpperCase() || null, inApp: emailInvite }, 201);
      } catch (exception) {
        if (!uniqueViolation(exception)) throw exception;
        if (emailInvite) return error('An invitation is already pending for that email.', 409);
        passcode = shortCode();
      }
    }
    return error('Could not generate an invite code. Try again.', 503);
  }
}
