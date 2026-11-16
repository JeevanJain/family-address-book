// GET /api/me -> 200 {user}. Allowed while a password change is pending.
import { requireUser } from '../_lib/auth.js';
import { json, handle, methodNotAllowed } from '../_lib/http.js';

export const onRequestGet = handle(async (context) => {
  const auth = await requireUser(context, { allowPasswordChange: true });
  if (auth.response) return auth.response;
  return json({ user: auth.user });
});

export const onRequest = methodNotAllowed;
