// GET  /api/users -> 200 {users:[...]}            (any logged-in user)
// POST /api/users {name,email} -> 201 {user, password}  (any logged-in user; password shown ONCE)
import { requireUser, publicUser, PUBLIC_USER_COLUMNS } from '../../_lib/auth.js';
import { generatePassword, hashPassword } from '../../_lib/crypto.js';
import { json, error, readJson, handle, methodNotAllowed } from '../../_lib/http.js';
import { validateNewUser } from '../../_lib/validate.js';

export const onRequestGet = handle(async (context) => {
  const auth = await requireUser(context);
  if (auth.response) return auth.response;
  const { results } = await context.env.DB.prepare(`SELECT ${PUBLIC_USER_COLUMNS} FROM users ORDER BY id`).all();
  return json({ users: results.map(publicUser) });
});

export const onRequestPost = handle(async (context) => {
  const auth = await requireUser(context);
  if (auth.response) return auth.response;
  const body = await readJson(context.request);
  if (!body.ok) return body.response;
  const v = validateNewUser(body.value);
  if (!v.ok) return json({ error: 'validation', message: 'Please fix the highlighted fields.', fields: v.errors }, 400);

  const { DB } = context.env;
  const existing = await DB.prepare('SELECT id FROM users WHERE email = ?').bind(v.value.email).first();
  if (existing) return error(409, 'email_exists', 'A user with this email already exists.');

  const password = generatePassword(12);
  const { hash, salt, iterations } = await hashPassword(password);
  let id;
  try {
    const res = await DB.prepare(
      `INSERT INTO users (email, name, password_hash, password_salt, password_iterations, role, disabled, must_change_password, created_by)
       VALUES (?, ?, ?, ?, ?, 'member', 0, 1, ?)`,
    ).bind(v.value.email, v.value.name, hash, salt, iterations, auth.user.id).run();
    id = res.meta.last_row_id;
  } catch (err) {
    if (/UNIQUE/i.test(String(err && err.message))) {
      return error(409, 'email_exists', 'A user with this email already exists.');
    }
    throw err;
  }
  const row = await DB.prepare(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ?`).bind(id).first();
  return json({ user: publicUser(row), password }, 201);
});

export const onRequest = methodNotAllowed;
