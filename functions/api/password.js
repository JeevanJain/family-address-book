// POST /api/password {current_password, new_password} -> 200 {ok:true}
// Clears must_change_password and ends all other sessions of the user (sessions_valid_after = now);
// the response carries a fresh cookie so the caller stays logged in. New password: 8..200 chars and different from the current one.
import { requireUser } from '../_lib/auth.js';
import { hashPassword, verifyPassword } from '../_lib/crypto.js';
import { signSession, buildSessionCookie } from '../_lib/session.js';
import { json, error, readJson, handle, methodNotAllowed } from '../_lib/http.js';
import { validateNewPassword } from '../_lib/validate.js';

export const onRequestPost = handle(async (context) => {
  const auth = await requireUser(context, { allowPasswordChange: true });
  if (auth.response) return auth.response;
  const body = await readJson(context.request);
  if (!body.ok) return body.response;
  const { current_password: current, new_password: next } = body.value;

  const check = validateNewPassword(next);
  if (!check.ok) return error(400, 'validation', check.error);
  if (typeof current !== 'string' || !current || current.length > 200) {
    return error(400, 'invalid_current_password', 'Current password is incorrect.');
  }
  const row = await context.env.DB.prepare('SELECT password_hash, password_salt, password_iterations FROM users WHERE id = ?')
    .bind(auth.user.id).first();
  if (!(await verifyPassword(current, row.password_salt, row.password_hash, row.password_iterations))) {
    return error(400, 'invalid_current_password', 'Current password is incorrect.');
  }
  if (next === current) return error(400, 'validation', 'New password must be different from the current one.');

  const { hash, salt, iterations } = await hashPassword(next);
  const now = Math.floor(Date.now() / 1000);
  await context.env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?,
       must_change_password = 0, sessions_valid_after = ? WHERE id = ?`,
  ).bind(hash, salt, iterations, now, auth.user.id).run();
  // Same `now` for the bump and the new cookie: issued-at == sessions_valid_after is accepted.
  const token = await signSession(context.env.SESSION_SECRET, auth.user.id, now);
  return json({ ok: true }, 200, { 'Set-Cookie': buildSessionCookie(token) });
});

export const onRequest = methodNotAllowed;
