// POST /api/login  {email, password}  -> 200 {user} + Set-Cookie
// Failures: 401 invalid_credentials (generic), 429 too_many_attempts.
import { hashPassword, verifyPassword, constantTimeEqual } from '../_lib/crypto.js';
import { signSession, buildSessionCookie } from '../_lib/session.js';
import { publicUser } from '../_lib/auth.js';
import { json, error, checkCsrf, readJson, handle, methodNotAllowed } from '../_lib/http.js';
import { normaliseEmail } from '../_lib/validate.js';
import { isSessionSecretUsable } from '../_lib/secret.js';

const MAX_FAILED = 5;
const WINDOW_SECONDS = 15 * 60;

const invalid = () => error(401, 'invalid_credentials', 'Incorrect email or password.');

export const onRequestPost = handle(async ({ request, env }) => {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;
  if (!isSessionSecretUsable(env.SESSION_SECRET)) return error(500, 'server_misconfigured', 'Server is not configured.');

  const body = await readJson(request);
  if (!body.ok) return body.response;
  const { email: rawEmail, password } = body.value;
  if (typeof rawEmail !== 'string' || typeof password !== 'string' || !rawEmail.trim() || !password) {
    return error(400, 'bad_request', 'Email and password are required.');
  }
  const email = normaliseEmail(rawEmail);
  if (email.length > 254 || password.length > 200) return invalid();

  const now = Math.floor(Date.now() / 1000);
  const since = now - WINDOW_SECONDS;

  // Lockout: failed attempts only, keyed by lower-cased email (exists or not).
  await env.DB.prepare('DELETE FROM login_attempts WHERE attempted_at <= ?').bind(since).run();
  const stats = await env.DB.prepare(
    'SELECT COUNT(*) AS n, MIN(attempted_at) AS oldest FROM login_attempts WHERE email = ? AND attempted_at > ?',
  ).bind(email, since).first();
  if (stats.n >= MAX_FAILED) {
    const retry = Math.max(1, stats.oldest + WINDOW_SECONDS - now);
    return error(429, 'too_many_attempts', 'Too many failed attempts. Try again later.', {
      'Retry-After': String(retry),
    });
  }

  const fail = async () => {
    await env.DB.prepare('INSERT INTO login_attempts (email, attempted_at) VALUES (?, ?)').bind(email, now).run();
    return invalid();
  };

  let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  let alreadyVerified = false; // true when this request created the owner from the matching env credentials

  // Owner bootstrap: only while no owner exists and the credentials match the env vars.
  if (!user && env.OWNER_EMAIL && env.OWNER_PASSWORD) {
    const hasOwner = await env.DB.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").first();
    const emailMatches = constantTimeEqual(email, normaliseEmail(env.OWNER_EMAIL));
    const passwordMatches = constantTimeEqual(password, env.OWNER_PASSWORD);
    if (!hasOwner && emailMatches && passwordMatches) {
      const { hash, salt, iterations } = await hashPassword(password);
      const ins = await env.DB.prepare(
        `INSERT OR IGNORE INTO users (email, name, password_hash, password_salt, password_iterations, role, disabled, must_change_password)
         VALUES (?, 'Owner', ?, ?, ?, 'owner', 0, 0)`,
      ).bind(email, hash, salt, iterations).run();
      user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
      // The password was just compared with OWNER_PASSWORD and hashed: no second derivation needed.
      alreadyVerified = ins.meta.changes > 0;
    }
  }

  if (!user) {
    await hashPassword(password); // one derive, same cost as the existing-user path
    return fail();
  }
  const ok = alreadyVerified
    || await verifyPassword(password, user.password_salt, user.password_hash, user.password_iterations);
  if (!ok || user.disabled) return fail();

  const token = await signSession(env.SESSION_SECRET, user.id, now);
  return json({ user: publicUser(user) }, 200, { 'Set-Cookie': buildSessionCookie(token) });
});

export const onRequest = methodNotAllowed;
