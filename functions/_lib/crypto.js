// Password hashing and random helpers. Uses only WebCrypto (globalThis.crypto),
// so it runs on Cloudflare Workers and on plain Node 20+.

/** Current PBKDF2 iteration count for new hashes. Deliberately low: Cloudflare's free plan allows
 *  only ~10 ms CPU per request (the Workers runtime also caps PBKDF2 at 100000).
 *  Each user row stores the count its hash was made with (users.password_iterations). */
export const PBKDF2_ITERATIONS = 10000;
/** Salt length in bytes. */
export const SALT_BYTES = 16;
/** Derived key length in bytes (SHA-256 output size). */
export const HASH_BYTES = 32;
/** Unambiguous password alphabet: no I, O, l, o, 0, 1. */
export const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

const encoder = new TextEncoder();

/**
 * Encode bytes as lower-case hex.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {string}
 */
export function toHex(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const b of view) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Decode a hex string to bytes. Throws on odd length or non-hex characters.
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error('invalid hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Cryptographically random bytes, hex encoded.
 * @param {number} n number of random bytes
 * @returns {string} 2*n hex characters
 */
export function randomHex(n) {
  return toHex(globalThis.crypto.getRandomValues(new Uint8Array(n)));
}

/**
 * Constant-time string comparison (time depends on length only, not content).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function constantTimeEqual(a, b) {
  const x = encoder.encode(String(a));
  const y = encoder.encode(String(b));
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function derive(password, saltBytes, iterations) {
  const key = await globalThis.crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    key, HASH_BYTES * 8,
  );
  return toHex(bits);
}

/**
 * Hash a password with PBKDF2-SHA256 and a fresh random 16-byte salt
 * (or the given hex salt).
 * @param {string} password
 * @param {string} [saltHex] existing salt (hex); omit to generate one
 * @param {number} [iterations] PBKDF2 iterations; defaults to PBKDF2_ITERATIONS
 * @returns {Promise<{hash: string, salt: string, iterations: number}>} hash and salt hex encoded;
 *   store `iterations` next to them
 */
export async function hashPassword(password, saltHex, iterations = PBKDF2_ITERATIONS) {
  if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error('invalid iteration count');
  const salt = saltHex ? fromHex(saltHex) : globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return { hash: await derive(password, salt, iterations), salt: toHex(salt), iterations };
}

/**
 * Verify a password against a stored hex salt and hash (constant-time compare).
 * @param {string} password
 * @param {string} saltHex
 * @param {string} hashHex
 * @param {number} [iterations] the count stored with the hash; defaults to PBKDF2_ITERATIONS
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, saltHex, hashHex, iterations = PBKDF2_ITERATIONS) {
  let computed;
  try {
    if (!Number.isSafeInteger(iterations) || iterations < 1) return false;
    computed = await derive(password, fromHex(saltHex), iterations);
  } catch {
    return false;
  }
  return constantTimeEqual(computed, hashHex);
}

/**
 * Generate a random password from PASSWORD_ALPHABET using
 * crypto.getRandomValues with rejection sampling (no modulo bias).
 * @param {number} [length=12]
 * @returns {string}
 */
export function generatePassword(length = 12) {
  const n = PASSWORD_ALPHABET.length;
  const limit = 256 - (256 % n); // bytes >= limit are rejected
  let out = '';
  while (out.length < length) {
    const buf = globalThis.crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of buf) {
      if (b >= limit) continue;
      out += PASSWORD_ALPHABET[b % n];
      if (out.length === length) break;
    }
  }
  return out;
}
