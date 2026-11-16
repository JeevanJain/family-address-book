// Any /api/* path (or method) not matched by a more specific route -> JSON 404.
// Pages Functions prefers the most specific route, so real routes are not shadowed.
import { error } from '../_lib/http.js';

export const onRequest = () => error(404, 'not_found', 'No such API endpoint.');
