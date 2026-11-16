// HTTP helpers shared by all API routes.
// Error shape everywhere: {"error":"<code>","message":"<text>"}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_BODY_BYTES = 65536;

/**
 * JSON response (Cache-Control: no-store).
 * @param {unknown} data
 * @param {number} [status=200]
 * @param {Object<string,string>} [headers] extra headers (e.g. Set-Cookie)
 * @returns {Response}
 */
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

/**
 * JSON error response `{error, message}`.
 * @param {number} status
 * @param {string} code machine-readable code, e.g. "invalid_credentials"
 * @param {string} message human-readable text
 * @param {Object<string,string>} [headers]
 * @returns {Response}
 */
export function error(status, code, message, headers = {}) {
  return json({ error: code, message }, status, headers);
}

/**
 * CSRF defence for POST/PUT/PATCH/DELETE: requires `Content-Type: application/json`
 * and an `Origin` header whose host equals the request Host.
 * Safe methods always pass.
 * @param {Request} request
 * @returns {Response|null} a 403 `{"error":"csrf"}` response, or null if OK
 */
export function checkCsrf(request) {
  if (!MUTATING.has(request.method)) return null;
  const fail = () => error(403, 'csrf', 'Cross-site request rejected.');
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return fail();
  const origin = request.headers.get('Origin');
  if (!origin) return fail();
  let originHost;
  try { originHost = new URL(origin).host; } catch { return fail(); }
  const host = request.headers.get('Host') || new URL(request.url).host;
  return originHost.toLowerCase() === host.toLowerCase() ? null : fail();
}

/**
 * Read the request body as a JSON object (max 64 KB).
 * Usage: `const b = await readJson(request); if (!b.ok) return b.response; use(b.value);`
 * @param {Request} request
 * @returns {Promise<{ok: true, value: object} | {ok: false, response: Response}>}
 */
export async function readJson(request) {
  const bad = (status, code, msg) => ({ ok: false, response: error(status, code, msg) });
  let text;
  try { text = await request.text(); } catch { return bad(400, 'invalid_json', 'Could not read request body.'); }
  if (text.length > MAX_BODY_BYTES) return bad(413, 'too_large', 'Request body too large.');
  let value;
  try { value = JSON.parse(text); } catch { return bad(400, 'invalid_json', 'Request body must be valid JSON.'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return bad(400, 'invalid_json', 'Request body must be a JSON object.');
  }
  return { ok: true, value };
}

/**
 * 405 response for unsupported methods (export as `onRequest` in a route file).
 * @returns {Response}
 */
export function methodNotAllowed() {
  return error(405, 'method_not_allowed', 'Method not allowed.');
}

/**
 * Wrap a route handler so unexpected exceptions become a JSON 500
 * `{"error":"server_error"}` (details are logged, never returned).
 * @param {(context: object) => Promise<Response>|Response} fn
 * @returns {(context: object) => Promise<Response>}
 */
export function handle(fn) {
  return async (context) => {
    try {
      return await fn(context);
    } catch (err) {
      console.error('unhandled error:', err && err.message);
      return error(500, 'server_error', 'Something went wrong.');
    }
  };
}
