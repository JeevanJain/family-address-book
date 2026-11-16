// Signed session cookies. Token format: `<userId>.<expiryEpochSeconds>.<hmacHex>`
// where hmac = HMAC-SHA256(secret, "<userId>.<expiryEpochSeconds>").
import { toHex, constantTimeEqual } from './crypto.js';

/** Cookie name. */
export const COOKIE_NAME = 'fab_session';
/** Session lifetime in seconds (30 days). */
export const SESSION_MAX_AGE = 2592000;

const encoder = new TextEncoder();

async function hmacHex(secret, message) {
  const key = await globalThis.crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return toHex(await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/**
 * Create a signed session token.
 * @param {string} secret SESSION_SECRET
 * @param {number} userId
 * @param {number} [nowSec] current time in epoch seconds (for tests)
 * @returns {Promise<string>}
 */
export async function signSession(secret, userId, nowSec = Math.floor(Date.now() / 1000)) {
  const payload = `${userId}.${nowSec + SESSION_MAX_AGE}`;
  return `${payload}.${await hmacHex(secret, payload)}`;
}

/**
 * Verify a session token's signature and expiry, and expose the expiry so the
 * caller can derive the issue time (expiry - SESSION_MAX_AGE).
 * @param {string} secret SESSION_SECRET
 * @param {string|null|undefined} token
 * @param {number} [nowSec] current time in epoch seconds (for tests)
 * @returns {Promise<{userId: number, expiry: number}|null>} null if invalid/expired
 */
export async function verifySessionDetailed(secret, token, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || typeof token !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.([0-9a-f]{64})$/.exec(token);
  if (!m) return null;
  const expected = await hmacHex(secret, `${m[1]}.${m[2]}`);
  if (!constantTimeEqual(expected, m[3])) return null;
  if (Number(m[2]) <= nowSec) return null;
  const id = Number(m[1]);
  const expiry = Number(m[2]);
  return Number.isSafeInteger(id) && Number.isSafeInteger(expiry) ? { userId: id, expiry } : null;
}

/**
 * Verify a session token's signature and expiry.
 * @param {string} secret SESSION_SECRET
 * @param {string|null|undefined} token
 * @param {number} [nowSec] current time in epoch seconds (for tests)
 * @returns {Promise<number|null>} the user id, or null if invalid/expired
 */
export async function verifySession(secret, token, nowSec = Math.floor(Date.now() / 1000)) {
  const v = await verifySessionDetailed(secret, token, nowSec);
  return v ? v.userId : null;
}

/**
 * Read one cookie value from a Request.
 * @param {Request} request
 * @param {string} [name]
 * @returns {string|null}
 */
export function getCookie(request, name = COOKIE_NAME) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * Build the Set-Cookie header value for a session token.
 * Always `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`.
 * @param {string} token
 * @returns {string}
 */
export function buildSessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

/**
 * Build a Set-Cookie header value that clears the session cookie.
 * @returns {string}
 */
export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
