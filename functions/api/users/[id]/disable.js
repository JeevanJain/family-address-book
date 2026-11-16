// POST /api/users/:id/disable -> 200 {user}   (owner only; the owner cannot be disabled)
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
  if (target.role === 'owner') return error(400, 'cannot_disable_owner', 'The owner cannot be disabled.');
  // Also bump sessions_valid_after so re-enabling later does not revive old sessions.
  const now = Math.floor(Date.now() / 1000);
  await DB.prepare('UPDATE users SET disabled = 1, sessions_valid_after = ? WHERE id = ?').bind(now, id).run();
  return json({ user: publicUser({ ...target, disabled: 1 }) });
});

export const onRequest = methodNotAllowed;
