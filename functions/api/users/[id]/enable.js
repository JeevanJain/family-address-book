// POST /api/users/:id/enable -> 200 {user}   (owner only)
import { requireOwner, publicUser, PUBLIC_USER_COLUMNS } from '../../../_lib/auth.js';
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
  await DB.prepare('UPDATE users SET disabled = 0 WHERE id = ?').bind(id).run();
  return json({ user: publicUser({ ...target, disabled: 0 }) });
});

export const onRequest = methodNotAllowed;
