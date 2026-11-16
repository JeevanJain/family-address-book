import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isSessionSecretUsable, MIN_SESSION_SECRET_LENGTH } from '../../functions/_lib/secret.js';

describe('SESSION_SECRET length check', () => {
  test('minimum is 32 characters', () => assert.equal(MIN_SESSION_SECRET_LENGTH, 32));
  test('missing or non-string secrets are unusable', () => {
    for (const bad of [undefined, null, '', 0, 12345678901234567890123456789012, {}, []]) {
      assert.equal(isSessionSecretUsable(bad), false, String(bad));
    }
  });
  test('31 characters is rejected, 32 is accepted', () => {
    assert.equal(isSessionSecretUsable('a'.repeat(31)), false);
    assert.equal(isSessionSecretUsable('a'.repeat(32)), true);
    assert.equal(isSessionSecretUsable('a'.repeat(64)), true);
  });
  test('the old 28-character throwaway secret is rejected', () => {
    assert.equal(isSessionSecretUsable('test-secret-0123456789abcdef'), false);
    assert.equal(isSessionSecretUsable('test-secret-0123456789abcdef-0123456789abcdef'), true);
  });
});
