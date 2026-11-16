import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, verifyPassword, generatePassword, PASSWORD_ALPHABET, PBKDF2_ITERATIONS,
  SALT_BYTES, constantTimeEqual, toHex, fromHex, randomHex,
} from '../../functions/_lib/crypto.js';

describe('crypto', () => {
  test('PBKDF2 iteration count constant is 10000 (spec) and salt is 16 bytes', () => {
    assert.equal(PBKDF2_ITERATIONS, 10000);
    assert.equal(SALT_BYTES, 16);
  });
  test('hash/verify round trip', async () => {
    const { hash, salt } = await hashPassword('CorrectHorse1');
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(await verifyPassword('CorrectHorse1', salt, hash), true);
  });
  test('wrong password fails', async () => {
    const { hash, salt } = await hashPassword('CorrectHorse1');
    assert.equal(await verifyPassword('correcthorse1', salt, hash), false);
    assert.equal(await verifyPassword('', salt, hash), false);
  });
  test('salt is 16 bytes (32 hex chars) and random per call', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    assert.match(a.salt, /^[0-9a-f]{32}$/);
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.hash, b.hash);
  });
  test('same salt gives same hash (deterministic)', async () => {
    const a = await hashPassword('pw-12345678');
    const b = await hashPassword('pw-12345678', a.salt);
    assert.equal(a.hash, b.hash);
  });
  test('matches an independent PBKDF2-SHA256 / 10000 computation', async () => {
    const { pbkdf2Sync } = await import('node:crypto');
    const { hash, salt } = await hashPassword('independent-check');
    const ref = pbkdf2Sync('independent-check', Buffer.from(salt, 'hex'), 10000, 32, 'sha256').toString('hex');
    assert.equal(hash, ref);
  });
  test('hash is bound to its iteration count: verifies only with that count', async () => {
    const a = await hashPassword('IterCheck-1', undefined, 1000);
    assert.equal(a.iterations, 1000);
    assert.equal(await verifyPassword('IterCheck-1', a.salt, a.hash, 1000), true);
    assert.equal(await verifyPassword('IterCheck-1', a.salt, a.hash, 10000), false);
    assert.equal(await verifyPassword('IterCheck-1', a.salt, a.hash), false, 'default is 10000');
    const d = await hashPassword('IterCheck-1');
    assert.equal(d.iterations, PBKDF2_ITERATIONS);
    assert.equal(await verifyPassword('IterCheck-1', d.salt, d.hash, 1000), false);
    assert.equal(await verifyPassword('IterCheck-1', d.salt, d.hash, d.iterations), true);
    const { pbkdf2Sync } = await import('node:crypto');
    assert.equal(a.hash, pbkdf2Sync('IterCheck-1', Buffer.from(a.salt, 'hex'), 1000, 32, 'sha256').toString('hex'));
  });
  test('invalid iteration counts: hash throws, verify returns false', async () => {
    for (const bad of [0, -5, 1.5, NaN, null]) {
      await assert.rejects(() => hashPassword('x-password', undefined, bad), /iteration/);
      assert.equal(await verifyPassword('x-password', 'aa'.repeat(16), 'bb'.repeat(32), bad), false);
    }
  });
  test('verifyPassword returns false (not throws) for malformed salt/hash', async () => {
    assert.equal(await verifyPassword('x', 'zz', 'abcd'), false);
    assert.equal(await verifyPassword('x', 'abc', 'abcd'), false);
  });
  test('generatePassword: default length 12, alphabet only, no ambiguous chars', () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword();
      assert.equal(p.length, 12);
      for (const ch of p) assert.ok(PASSWORD_ALPHABET.includes(ch), `unexpected char ${ch}`);
      assert.doesNotMatch(p, /[IOlo01]/);
    }
  });
  test('generatePassword: custom length and uniqueness', () => {
    assert.equal(generatePassword(20).length, 20);
    assert.equal(generatePassword(1).length, 1);
    const set = new Set(Array.from({ length: 100 }, () => generatePassword()));
    assert.equal(set.size, 100);
  });
  test('alphabet has no duplicates and no ambiguous characters', () => {
    assert.equal(new Set(PASSWORD_ALPHABET).size, PASSWORD_ALPHABET.length);
    assert.doesNotMatch(PASSWORD_ALPHABET, /[IOlo01]/);
  });
  test('every alphabet character can occur (rough distribution check)', () => {
    const seen = new Set();
    for (let i = 0; i < 400; i++) for (const ch of generatePassword()) seen.add(ch);
    assert.equal(seen.size, PASSWORD_ALPHABET.length);
  });
  test('constantTimeEqual', () => {
    assert.equal(constantTimeEqual('abc', 'abc'), true);
    assert.equal(constantTimeEqual('abc', 'abd'), false);
    assert.equal(constantTimeEqual('abc', 'abcd'), false);
    assert.equal(constantTimeEqual('', ''), true);
  });
  test('hex helpers', () => {
    assert.equal(toHex(new Uint8Array([0, 15, 255])), '000fff');
    assert.deepEqual([...fromHex('000fff')], [0, 15, 255]);
    assert.throws(() => fromHex('abc'));
    assert.throws(() => fromHex('zz'));
    assert.match(randomHex(8), /^[0-9a-f]{16}$/);
  });
});
