import { DAY, MINUTE, json, query, token } from '../core.ts';

export const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
const cookieName = request => {
  const slot = request.headers.get('x-care-slot');
  return /^[a-f0-9]{24}$/.test(slot || '') ? 'care_session_' + slot : 'care_session';
};
export const sessionCookie = (request, value, age) => cookieName(request) + '=' + value + '; Path=/api; HttpOnly; SameSite=Lax; Max-Age=' + age + (new URL(request.url).protocol === 'https:' ? '; Secure' : '');
export const sessionToken = request => request.headers.get('cookie')?.match(new RegExp('(?:^|;\\s*)' + cookieName(request) + '=([a-f0-9]{32})(?:;|$)'))?.[1];

export async function signIn(request, env, account, body, status = 200) {
  const session = token();
  const prior = sessionToken(request);
  const changes = [query(env, 'INSERT INTO account_sessions VALUES (?, ?, ?)', await hash(session), account, Date.now() + 7 * DAY)];
  if (prior) changes.push(query(env, 'DELETE FROM account_sessions WHERE token = ?', await hash(prior)));
  await env.DB.batch(changes);
  return json(body, status, { 'set-cookie': sessionCookie(request, session, 604800) });
}

export async function rateExceeded(env, address, now, limit) {
  const bucket = Math.floor(now / (15 * MINUTE));
  const attempt = await query(env, 'INSERT INTO attempts VALUES (?, ?, 1) ON CONFLICT(address) DO UPDATE SET count = CASE WHEN attempts.bucket = excluded.bucket THEN attempts.count + 1 ELSE 1 END, bucket = excluded.bucket RETURNING count', address, bucket).first();
  return attempt.count > limit;
}

