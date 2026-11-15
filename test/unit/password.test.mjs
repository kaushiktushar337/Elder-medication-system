import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, validPassword } from '../../src/auth/password.ts';

test('password hashes use unique salts and reject wrong, missing and malformed credentials', async () => {
  const password = 'synthetic-password-123';
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('different-password', first), false);
  for (const stored of [null, '', 'broken', 'a:b', first + ':extra']) {
    assert.equal(await verifyPassword(password, stored), false);
  }
  for (const invalid of [null, {}, 'short', 'x'.repeat(129)]) assert.equal(validPassword(invalid), false);
});

