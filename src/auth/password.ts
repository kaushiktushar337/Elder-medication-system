import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const digest = (password, salt) => derive(password, salt, 32, options);

export const validPassword = value => typeof value === 'string' && value.length >= 12 && value.length <= 128;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await digest(password, salt);
  return salt + ':' + key.toString('hex');
}

export async function verifyPassword(password, stored) {
  const validHash = typeof stored === 'string' && /^[a-f0-9]{32}:[a-f0-9]{64}$/.test(stored);
  const [salt, expected] = (validHash ? stored : '0'.repeat(32) + ':' + '0'.repeat(64)).split(':');
  const match = timingSafeEqual(await digest(password, salt), Buffer.from(expected, 'hex'));
  return validHash && match;
}
