// POST /api/users/:id/reset-password -> 200 {user, password}   (owner only; password shown ONCE)
// Sets a new generated password and must_change_password=1, and ends the user's existing
// sessions (sessions_valid_after = now).
import { requireOwner, publicUser, PUBLIC_USER_COLUMNS } from '../../../_lib/auth.js';
import { generatePassword, hashPassword } from '../../../_lib/crypto.js';
import { json, error, handle, methodNotAllowed } from '../../../_lib/http.js';

export const onRequestPost = handle(async (context) => {
  const auth = await requireOwner(context);
  if (auth.response) return auth.response;
  const id = /^\d+$/.test(context.params.id) ? Number(context.params.id) : NaN;
  const { DB } = context.env;
  const target = Number.isSafeInteger(id)
    ? await DB.prepare(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first()
    : null;
  if (!target) return error(404, 'not_found', 'User not found.');
  const password = generatePassword(12);
  const { hash, salt, iterations } = await hashPassword(password);
  const now = Math.floor(Date.now() / 1000);
  await DB.prepare(
    `UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?,
       must_change_password = 1, sessions_valid_after = ? WHERE id = ?`,
  ).bind(hash, salt, iterations, now, id).run();
  return json({ user: publicUser({ ...target, must_change_password: 1 }), password });
});

export const onRequest = methodNotAllowed;
