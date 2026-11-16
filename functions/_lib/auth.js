// Authentication / authorisation for API routes.
import { getCookie, verifySessionDetailed, SESSION_MAX_AGE } from './session.js';
import { isSessionSecretUsable } from './secret.js';
import { checkCsrf, error } from './http.js';

const USER_COLUMNS = 'id, email, name, role, disabled, must_change_password, created_by, created_at';

/**
 * Convert a DB user row to the public shape (never includes password_hash/salt).
 * @param {object} row
 * @returns {{id: number, email: string, name: string, role: 'owner'|'member',
 *   disabled: boolean, must_change_password: boolean, created_by: ?number, created_at: string}}
 */
export function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    disabled: !!row.disabled,
    must_change_password: !!row.must_change_password,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

/** SQL column list for selecting a public user row (no hash/salt). */
export const PUBLIC_USER_COLUMNS = USER_COLUMNS;

/**
 * Authenticate a request. Order: CSRF check (mutating methods) -> cookie
 * signature/expiry -> load the user row from D1 on every request -> 401 if the
 * user is missing, disabled, or the session was issued before sessions_valid_after -> 403 `password_change_required` when
 * must_change_password=1 (unless `allowPasswordChange`).
 *
 * Usage:
 *   const auth = await requireUser(context);
 *   if (auth.response) return auth.response;
 *   const { user } = auth;   // publicUser shape
 *
 * @param {{request: Request, env: object}} context Pages Functions context
 * @param {{allowPasswordChange?: boolean}} [opts] set true only for
 *   GET /api/me, POST /api/password and POST /api/logout
 * @returns {Promise<{user: ReturnType<typeof publicUser>} | {response: Response}>}
 */
export async function requireUser(context, { allowPasswordChange = false } = {}) {
  const { request, env } = context;
  const csrf = checkCsrf(request);
  if (csrf) return { response: csrf };
  if (!isSessionSecretUsable(env.SESSION_SECRET)) {
    return { response: error(500, 'server_misconfigured', 'Server is not configured.') };
  }
  const unauth = () => ({ response: error(401, 'unauthorized', 'Please log in.') });
  const session = await verifySessionDetailed(env.SESSION_SECRET, getCookie(request));
  if (session === null) return unauth();
  const row = await env.DB.prepare(`SELECT ${USER_COLUMNS}, sessions_valid_after FROM users WHERE id = ?`)
    .bind(session.userId).first();
  if (!row || row.disabled) return unauth();
  // Sessions issued before the last disable / password change / reset are dead.
  // Same-second issue is valid (issuedAt >= sessions_valid_after).
  const issuedAt = session.expiry - SESSION_MAX_AGE;
  if (issuedAt < (row.sessions_valid_after ?? 0)) return unauth();
  const user = publicUser(row);
  if (user.must_change_password && !allowPasswordChange) {
    return { response: error(403, 'password_change_required', 'You must change your password first.') };
  }
  return { user };
}

/**
 * Like requireUser, but members get 403 `forbidden`.
 * @param {{request: Request, env: object}} context
 * @param {{allowPasswordChange?: boolean}} [opts]
 * @returns {Promise<{user: ReturnType<typeof publicUser>} | {response: Response}>}
 */
export async function requireOwner(context, opts) {
  const auth = await requireUser(context, opts);
  if (auth.response) return auth;
  if (auth.user.role !== 'owner') {
    return { response: error(403, 'forbidden', 'Only the owner can do this.') };
  }
  return auth;
}
