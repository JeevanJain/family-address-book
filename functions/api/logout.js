// POST /api/logout -> 200 {ok:true} + clearing Set-Cookie. Needs a session (401 otherwise;
// the 401 also carries the clearing cookie). Allowed while a password change is pending.
import { requireUser } from '../_lib/auth.js';
import { clearSessionCookie } from '../_lib/session.js';
import { json, handle, methodNotAllowed } from '../_lib/http.js';

export const onRequestPost = handle(async (context) => {
  const auth = await requireUser(context, { allowPasswordChange: true });
  if (auth.response) {
    if (auth.response.status === 401) auth.response.headers.set('Set-Cookie', clearSessionCookie());
    return auth.response;
  }
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
});

export const onRequest = methodNotAllowed;
