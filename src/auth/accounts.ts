import { error, json, query, text, token, uniqueViolation, uuid } from '../core.ts';
import { emailOf, validEmail } from './email.ts';
import { hashPassword, validPassword, verifyPassword } from './password.ts';
import { hash, rateExceeded, signIn } from './sessions.ts';

export async function authenticate(env, request, { resource, body, now }) {
  const address = (env.clientAddress || 'local') + ':' + resource;
  if (await rateExceeded(env, address, now, resource.includes('login') ? 15 : 8)) return error('Too many attempts. Try again later.', 429);
  if (resource === 'login') return signInWithPassword(env, request, body);
  if (resource === 'legacy-login') return signInWithLegacyCode(env, request, body.passcode);
  return createAccount(env, request, body, resource === 'profiles' ? 'patient' : 'care-team');
}

async function signInWithPassword(env, request, body) {
  const email = emailOf(body.email);
  if (!validEmail(email) || !validPassword(body.password)) return error('Email or password is incorrect.', 401);
  const found = await query(env, 'SELECT id, password_hash FROM accounts WHERE email = ?', email).first();
  if (!await verifyPassword(body.password, found?.password_hash)) return error('Email or password is incorrect.', 401);
  return signIn(request, env, found.id, { ok: true });
}

async function signInWithLegacyCode(env, request, code) {
  const passcode = text(code, 80).replaceAll('-', '').toLowerCase();
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

async function createAccount(env, request, body, kind) {
  const name = text(body.name);
  const email = emailOf(body.email);
  if (!name || !validEmail(email) || !validPassword(body.password)) return error('Enter your name, email and a password of 12 to 128 characters.');
  const profile = uuid();
  const member = uuid();
  if (await query(env, 'SELECT 1 FROM accounts WHERE email = ? UNION ALL SELECT 1 FROM profiles WHERE lower(trim(email)) = ? LIMIT 1', email, email).first()) {
    return error('This email is already in use. Sign in or use an existing personal code.', 409);
  }
  const digest = await hash(token());
  const passwordHash = await hashPassword(body.password);
  const workspace = kind === 'care-team' && body.workspace === 'doctor' ? 'doctor' : 'family';
  const changes = [query(env, 'INSERT INTO accounts (id, name, pass, email, password_hash, kind, workspace) VALUES (?, ?, ?, ?, ?, ?, ?)', member, name, digest, email, passwordHash, kind, workspace)];
  if (kind === 'patient') changes.push(
    query(env, 'INSERT INTO profiles (id, name, email) VALUES (?, ?, ?)', profile, name, email),
    query(env, "INSERT INTO members (id, profile, name, role, pass, account, relationship) VALUES (?, ?, ?, 'owner', ?, ?, 'Patient')", member, profile, name, digest, member)
  );
  try { await env.DB.batch(changes); }
  catch (exception) {
    if (uniqueViolation(exception)) return error('This email is already in use. Sign in to continue.', 409);
    throw exception;
  }
  return signIn(request, env, member, { ok: true }, 201);
}

export async function setLogin(env, account, body) {
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
    if (uniqueViolation(exception)) return error('This email is already used by another account.', 409);
    throw exception;
  }
  return json({ ok: true });
}
