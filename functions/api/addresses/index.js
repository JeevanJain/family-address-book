// GET  /api/addresses?q=&group= -> 200 {addresses:[...], groups:[...]}   (any logged-in user)
// POST /api/addresses {address fields, confirm_duplicate?} -> 201 {address}
//   400 validation {fields}, 409 duplicate_phone {existing}
import { requireUser } from '../../_lib/auth.js';
import { json, readJson, handle, methodNotAllowed } from '../../_lib/http.js';
import { validateAddress } from '../../_lib/validate.js';

const SELECT = `SELECT a.*, u.name AS created_by_name
  FROM addresses a LEFT JOIN users u ON u.id = a.created_by`;

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const onRequestGet = handle(async (context) => {
  const auth = await requireUser(context);
  if (auth.response) return auth.response;
  const { DB } = context.env;
  const url = new URL(context.request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const group = url.searchParams.get('group') || '';

  const where = ['a.deleted_at IS NULL'];
  const params = [];
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push(`(a.first_name LIKE ? ESCAPE '\\' OR a.surname LIKE ? ESCAPE '\\' OR a.city LIKE ? ESCAPE '\\'
      OR a.pin LIKE ? ESCAPE '\\' OR a.phone LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like, like);
  }
  if (group) {
    where.push('a.group_name = ?');
    params.push(group);
  }
  const { results } = await DB.prepare(
    `${SELECT} WHERE ${where.join(' AND ')}
     ORDER BY a.first_name COLLATE NOCASE, a.surname COLLATE NOCASE, a.id`,
  ).bind(...params).all();
  const g = await DB.prepare(
    `SELECT DISTINCT group_name FROM addresses
     WHERE deleted_at IS NULL AND group_name IS NOT NULL AND group_name <> ''
     ORDER BY group_name COLLATE NOCASE`,
  ).all();
  return json({ addresses: results, groups: g.results.map((r) => r.group_name) });
});

export const onRequestPost = handle(async (context) => {
  const auth = await requireUser(context);
  if (auth.response) return auth.response;
  const body = await readJson(context.request);
  if (!body.ok) return body.response;
  const v = validateAddress(body.value);
  if (!v.ok) return json({ error: 'validation', message: 'Please fix the highlighted fields.', fields: v.errors }, 400);

  const { DB } = context.env;
  const a = v.value;
  if (body.value.confirm_duplicate !== true) {
    const existing = await DB.prepare(
      `SELECT id, first_name, surname, city, phone FROM addresses
       WHERE phone = ? AND deleted_at IS NULL LIMIT 1`,
    ).bind(a.phone).first();
    if (existing) {
      return json({ error: 'duplicate_phone', message: 'An address with this phone number already exists.', existing }, 409);
    }
  }
  const now = nowIso();
  const res = await DB.prepare(
    `INSERT INTO addresses (first_name, surname, address_line1, address_line2, landmark, city, state, pin,
       phone, email, group_name, notes, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(a.first_name, a.surname, a.address_line1, a.address_line2, a.landmark, a.city, a.state, a.pin,
    a.phone, a.email, a.group_name, a.notes, auth.user.id, auth.user.id, now, now).run();
  const row = await DB.prepare(`${SELECT} WHERE a.id = ?`).bind(res.meta.last_row_id).first();
  return json({ address: row }, 201);
});

export const onRequest = methodNotAllowed;
