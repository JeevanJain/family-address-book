// GET /api/export.csv -> text/csv attachment of all non-deleted addresses (any logged-in user).
import { requireUser } from '../_lib/auth.js';
import { handle, methodNotAllowed } from '../_lib/http.js';

const COLUMNS = [
  'id', 'first_name', 'surname', 'address_line1', 'address_line2', 'landmark', 'city', 'state',
  'pin', 'phone', 'email', 'group_name', 'notes', 'created_by_name', 'created_at', 'updated_at',
];
// Plain digits: never prefixed.
const RAW = new Set(['id', 'pin', 'phone']);

function cell(name, value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (!RAW.has(name) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const onRequestGet = handle(async (context) => {
  const auth = await requireUser(context);
  if (auth.response) return auth.response;
  const { results } = await context.env.DB.prepare(
    `SELECT a.*, u.name AS created_by_name
     FROM addresses a LEFT JOIN users u ON u.id = a.created_by
     WHERE a.deleted_at IS NULL
     ORDER BY a.first_name COLLATE NOCASE, a.surname COLLATE NOCASE, a.id`,
  ).all();
  const lines = [COLUMNS.join(',')];
  for (const r of results) lines.push(COLUMNS.map((c) => cell(c, r[c])).join(','));
  // UTF-8 BOM so Excel detects the encoding and shows non-ASCII text correctly.
  return new Response('\uFEFF' + lines.join('\r\n') + '\r\n', {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="addresses.csv"',
      'Cache-Control': 'no-store',
    },
  });
});

export const onRequest = methodNotAllowed;
