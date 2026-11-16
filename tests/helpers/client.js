// Minimal HTTP client with a cookie jar. Records every response body so tests can scan them.
export const allBodies = [];

export class Client {
  constructor(baseUrl, label = 'client') {
    this.baseUrl = baseUrl;
    this.label = label;
    this.cookie = null; // "fab_session=..."
    this.lastSetCookie = null;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {object|string|undefined} body object => JSON-encoded
   * @param {{origin?:string|null, contentType?:string|null, headers?:object, noCookie?:boolean, raw?:boolean}} [o]
   */
  async req(method, path, body, o = {}) {
    const headers = { ...(o.headers || {}) };
    if (method !== 'GET' && method !== 'HEAD') {
      const ct = o.contentType === undefined ? 'application/json' : o.contentType;
      if (ct !== null) headers['Content-Type'] = ct;
      const origin = o.origin === undefined ? this.baseUrl : o.origin;
      if (origin !== null) headers.Origin = origin;
    }
    if (this.cookie && !o.noCookie) headers.Cookie = this.cookie;
    let payload;
    if (body !== undefined) payload = typeof body === 'string' ? body : JSON.stringify(body);
    else if (method !== 'GET' && method !== 'HEAD') payload = '{}';
    const res = await fetch(this.baseUrl + path, { method, headers, body: payload, redirect: 'manual' });
    const text = await res.text();
    allBodies.push({ who: this.label, method, path, status: res.status, text });
    const setCookies = res.headers.getSetCookie();
    this.lastSetCookie = setCookies.length ? setCookies.join('\n') : null;
    for (const sc of setCookies) {
      const first = sc.split(';')[0];
      const eq = first.indexOf('=');
      if (first.slice(0, eq) === 'fab_session') {
        this.cookie = first.slice(eq + 1) ? first : null; // empty value = cleared
      }
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers, setCookies };
  }

  get(path, o) { return this.req('GET', path, undefined, o); }
  post(path, body, o) { return this.req('POST', path, body, o); }
  put(path, body, o) { return this.req('PUT', path, body, o); }
  del(path, o) { return this.req('DELETE', path, undefined, o); }

  async login(email, password) {
    const r = await this.post('/api/login', { email, password });
    return r;
  }
}

/** RFC 4180 CSV parser. Returns array of rows (arrays of strings). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
