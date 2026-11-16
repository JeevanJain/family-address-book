// GET    /api/addresses/:id -> 200 {address}
// PUT    /api/addresses/:id {address fields, confirm_duplicate?} -> 200 {address}
//        400 validation {fields}, 409 duplicate_phone {existing}
// DELETE /api/addresses/:id -> 200 {ok:true}   (owner only, soft delete)
// Unknown or deleted id -> 404 not_found.
import { requireUser, requireOwner } from '../../_lib/auth.js';
import { json, error, readJson, handle, methodNotAllowed } from '../../_lib/http.js';
import { validateAddress } from '../../_lib/validate.js';

const SELECT = `SELECT a.*, u.name AS created_by_name
  FROM addresses a LEFT JOIN users u ON u.id = a.created_by`;

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const notFound = () => error(404, 'not_found', 'Address not found.');

function parseId(context) {
  const raw = String(context.params.id ?? '');
  if (!/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

async function load(DB, id) {
  return DB.prepare(`${SELECT} WHERE a.id = ? AND a.deleted_at IS NULL`).bind(id).first();
}

export const onRequestGet = handle(async (context) => {
  const auth = await requireUser(context);
  if (auth.response) return auth.response;
  const id = parseId(context);
  if (id === null) return notFound();
  const row = await load(context.env.DB, id);
  return row ? json({ address: row }) : notFound();
});

export const onRequestPut = handle(async (context) => {
  const auth = await requireUser(context);
  if (auth.response) return auth.response;
  const id = parseId(context);
  if (id === null) return notFound();
  const { DB } = context.env;
  if (!(await load(DB, id))) return notFound();
  const body = await readJson(context.request);
  if (!body.ok) return body.response;
  const v = validateAddress(body.value);
  if (!v.ok) return json({ error: 'validation', message: 'Please fix the highlighted fields.', fields: v.errors }, 400);
  const a = v.value;
  if (body.value.confirm_duplicate !== true) {
    const existing = await DB.prepare(
      `SELECT id, first_name, surname, city, phone FROM addresses
       WHERE phone = ? AND deleted_at IS NULL AND id <> ? LIMIT 1`,
    ).bind(a.phone, id).first();
    if (existing) {
      return json({ error: 'duplicate_phone', message: 'An address with this phone number already exists.', existing }, 409);
    }
  }
  await DB.prepare(
    `UPDATE addresses SET first_name = ?, surname = ?, address_line1 = ?, address_line2 = ?, landmark = ?,
       city = ?, state = ?, pin = ?, phone = ?, email = ?, group_name = ?, notes = ?,
       updated_by = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
  ).bind(a.first_name, a.surname, a.address_line1, a.address_line2, a.landmark, a.city, a.state, a.pin,
    a.phone, a.email, a.group_name, a.notes, auth.user.id, nowIso(), id).run();
  const row = await load(DB, id);
  return row ? json({ address: row }) : notFound();
});

export const onRequestDelete = handle(async (context) => {
  const auth = await requireOwner(context);
  if (auth.response) return auth.response;
  const id = parseId(context);
  if (id === null) return notFound();
  const now = nowIso();
  const res = await context.env.DB.prepare(
    'UPDATE addresses SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
  ).bind(now, auth.user.id, now, id).run();
  if (!res.meta.changes) return notFound();
  return json({ ok: true });
});

export const onRequest = methodNotAllowed;
