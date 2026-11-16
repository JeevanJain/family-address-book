// End-to-end API tests against `wrangler pages dev` with a throwaway local D1 database.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';
import { Client, allBodies, parseCsv } from '../helpers/client.js';

const PORT = 8791;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const MEMBER_PW = 'MemberPass-123';

let srv;
let phoneSeq = 0;
const nextPhone = () => String(9100000000 + ++phoneSeq);
const addr = (over = {}) => ({
  first_name: 'Test', surname: 'User', address_line1: '1 Example Road', city: 'Exampleville',
  state: 'Karnataka', pin: '560001', phone: nextPhone(), ...over,
});
const client = (label) => new Client(srv.baseUrl, label);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Sessions are second-granular and a cookie issued in the same second as an invalidation is
// accepted by design. So tests wait >1s after creating the "old" session before invalidating it.
const PAST_SECOND_BOUNDARY_MS = 1100;
/** A client that only carries the given cookie value ("fab_session=..."). */
const withCookie = (cookie, label = 'replay') => { const c = client(label); c.cookie = cookie; return c; };
const assertError = (r, status, code) => {
  assert.equal(r.status, status, `expected ${status} got ${r.status}: ${r.text}`);
  assert.equal(r.json?.error, code, `expected error=${code}: ${r.text}`);
  assert.equal(typeof r.json?.message, 'string', 'error has a message');
};

/** Owner creates a member; returns {id, email, name, generated, c} with c logged in after the forced password change. */
async function makeMember(owner, name, email, { changePassword = true } = {}) {
  const r = await owner.post('/api/users', { name, email });
  assert.equal(r.status, 201, r.text);
  const c = client(name);
  const generated = r.json.password;
  const l = await c.login(email, generated);
  assert.equal(l.status, 200, l.text);
  if (changePassword) {
    const p = await c.post('/api/password', { current_password: generated, new_password: MEMBER_PW });
    assert.equal(p.status, 200, p.text);
  }
  return { id: r.json.user.id, email: email.toLowerCase(), name, generated, c };
}

describe('Family Address Book API', { concurrency: false }, () => {
  let owner;       // logged-in owner client
  let member;      // {id,email,c}

  before(async () => { srv = await startServer({ port: PORT }); owner = client('owner'); });
  after(async () => { if (srv) await srv.stop(); });

  // ------------------------------------------------------------------ 401 everywhere
  describe('authentication required', () => {
    const anon = () => client('anon');
    const routes = [
      ['GET', '/api/me'], ['GET', '/api/users'], ['POST', '/api/users', { name: 'Test User', email: 'test@example.com' }],
      ['POST', '/api/users/1/disable'], ['POST', '/api/users/1/enable'], ['POST', '/api/users/1/reset-password'],
      ['POST', '/api/password', { current_password: 'a', new_password: 'bbbbbbbb' }], ['POST', '/api/logout'],
      ['GET', '/api/addresses'], ['POST', '/api/addresses', {}], ['GET', '/api/addresses/1'],
      ['PUT', '/api/addresses/1', {}], ['DELETE', '/api/addresses/1'], ['GET', '/api/export.csv'],
    ];
    for (const [method, path, body] of routes) {
      it(`${method} ${path} -> 401 without a session`, async () => {
        const r = await anon().req(method, path, body);
        assertError(r, 401, 'unauthorized');
      });
    }
    it('garbage and tampered cookies -> 401', async () => {
      for (const cookie of ['fab_session=garbage', 'fab_session=1.9999999999.' + '0'.repeat(64), 'fab_session=', 'other=1']) {
        const c = anon();
        const r = await c.get('/api/me', { headers: { Cookie: cookie } });
        assert.equal(r.status, 401, cookie);
      }
    });
    it('logout without a session -> 401 and still sends a clearing Set-Cookie', async () => {
      const r = await anon().post('/api/logout', {});
      assert.equal(r.status, 401);
      assert.match(r.setCookies.join('\n'), /fab_session=;.*Max-Age=0/);
    });
    it('login endpoint itself does not need a session (wrong creds -> 401 invalid_credentials, not unauthorized)', async () => {
      const r = await anon().login('nobody-at-all@example.com', 'whatever-123');
      assertError(r, 401, 'invalid_credentials');
    });
  });

  // ------------------------------------------------------------------ bootstrap
  describe('owner bootstrap', () => {
    it('wrong password for OWNER_EMAIL does not create an owner', async () => {
      const r = await client('x').login(srv.owner.email, 'not-the-owner-password');
      assertError(r, 401, 'invalid_credentials');
      assert.equal(srv.d1("SELECT COUNT(*) AS n FROM users").at(0).n, 0);
    });
    it('OWNER_PASSWORD with a different email does not create an owner', async () => {
      const r = await client('x').login('someone-else@example.com', srv.owner.password);
      assertError(r, 401, 'invalid_credentials');
      assert.equal(srv.d1("SELECT COUNT(*) AS n FROM users").at(0).n, 0);
    });
    it('correct OWNER_EMAIL/OWNER_PASSWORD creates the owner and logs in with the agreed cookie', async () => {
      const r = await owner.login(srv.owner.email, srv.owner.password);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.user.role, 'owner');
      assert.equal(r.json.user.email, srv.owner.email);
      assert.equal(r.json.user.must_change_password, false);
      assert.equal(r.json.user.disabled, false);
      assert.equal(r.setCookies.length, 1);
      assert.match(r.setCookies[0], /^fab_session=[^;]+; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
    });
    it('GET /api/me returns the owner', async () => {
      const r = await owner.get('/api/me');
      assert.equal(r.status, 200);
      assert.equal(r.json.user.role, 'owner');
    });
    it('logging in again as owner works and does not create a second owner', async () => {
      const r = await client('x').login(srv.owner.email, srv.owner.password);
      assert.equal(r.status, 200);
      const users = (await owner.get('/api/users')).json.users;
      assert.equal(users.filter((u) => u.role === 'owner').length, 1);
      assert.equal(users.length, 1);
    });
    it('login email is case-insensitive (owner)', async () => {
      const r = await client('x').login(srv.owner.email.toUpperCase(), srv.owner.password);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.user.email, srv.owner.email);
    });
    it('there is no way to make a second owner via the API', async () => {
      const r = await owner.post('/api/users', { name: 'Test Two', email: 'second-owner@example.com', role: 'owner' });
      assert.equal(r.status, 201);
      assert.equal(r.json.user.role, 'member');
      assert.equal(r.json.user.id > 0, true);
    });
  });

  // ------------------------------------------------------------------ login behaviour
  describe('login', () => {
    it('unknown email and wrong password give the identical response', async () => {
      const a = await client('x').login('no-such-user@example.com', 'WrongPass-1234');
      const b = await client('x').login(srv.owner.email, 'WrongPass-1234');
      assertError(a, 401, 'invalid_credentials');
      assertError(b, 401, 'invalid_credentials');
      assert.deepEqual(a.json, b.json);
      assert.equal(a.setCookies.length, 0);
      assert.equal(b.setCookies.length, 0);
    });
    it('missing / non-string / malformed input is rejected with 400', async () => {
      const c = client('x');
      assert.equal((await c.post('/api/login', { email: 'a@example.com' })).status, 400);
      assert.equal((await c.post('/api/login', { password: 'abc' })).status, 400);
      assert.equal((await c.post('/api/login', { email: 5, password: 'abc' })).status, 400);
      assert.equal((await c.post('/api/login', '{not json')).status, 400);
      assert.equal((await c.post('/api/login', '[]')).status, 400);
    });
    it('GET /api/login is 405', async () => {
      assert.equal((await client('x').get('/api/login')).status, 405);
    });
    it('email lookup is case-insensitive for members and stored lower-cased', async () => {
      const r = await owner.post('/api/users', { name: 'Test Mixed', email: 'Mixed.Case@Example.com' });
      assert.equal(r.status, 201);
      assert.equal(r.json.user.email, 'mixed.case@example.com');
      for (const e of ['MIXED.CASE@EXAMPLE.COM', 'mixed.case@example.com', '  Mixed.Case@example.com ']) {
        const l = await client('x').login(e, r.json.password);
        assert.equal(l.status, 200, `${e}: ${l.text}`);
        assert.equal(l.json.user.email, 'mixed.case@example.com');
      }
    });
    it('duplicate email (any case) is rejected with 409', async () => {
      const r = await owner.post('/api/users', { name: 'Test Dup', email: 'MIXED.case@example.com' });
      assertError(r, 409, 'email_exists');
    });
  });

  // ------------------------------------------------------------------ CSRF
  describe('CSRF defence', () => {
    const csrfCases = [
      ['no Origin header', { origin: null }],
      ['Origin of another host', { origin: 'http://evil.example.com' }],
      ['Origin with another port', { origin: 'http://127.0.0.1:9' }],
      ['Origin that is not a URL', { origin: 'not a url' }],
      ['Origin "null"', { origin: 'null' }],
      ['Content-Type text/plain', { contentType: 'text/plain' }],
      ['Content-Type form-urlencoded', { contentType: 'application/x-www-form-urlencoded' }],
      ['no Content-Type', { contentType: null }],
    ];
    const login = [['POST', '/api/login', { email: 'a@example.com', password: 'x' }]];
    const authed = [
      ['POST', '/api/logout'], ['POST', '/api/password', { current_password: 'a', new_password: 'bbbbbbbb' }],
      ['POST', '/api/users', { name: 'Test User', email: 'csrf@example.com' }],
      ['POST', '/api/users/2/disable'], ['POST', '/api/users/2/enable'], ['POST', '/api/users/2/reset-password'],
      ['POST', '/api/addresses', {}], ['PUT', '/api/addresses/1', {}], ['DELETE', '/api/addresses/1'],
    ];
    for (const [label, opts] of csrfCases) {
      it(`login: ${label} -> 403 csrf`, async () => {
        for (const [m, p, b] of login) assertError(await client('x').req(m, p, b, opts), 403, 'csrf');
      });
      it(`authenticated mutating routes: ${label} -> 403 csrf`, async () => {
        for (const [m, p, b] of authed) assertError(await owner.req(m, p, b, opts), 403, 'csrf');
      });
      it(`unauthenticated mutating routes: ${label} -> 403 csrf (CSRF check precedes auth)`, async () => {
        for (const [m, p, b] of authed) assertError(await client('x').req(m, p, b, opts), 403, 'csrf');
      });
    }
    it('Content-Type with charset parameter is accepted', async () => {
      const r = await owner.post('/api/addresses', addr({ first_name: 'CsrfCharset' }), { contentType: 'application/json; charset=utf-8' });
      assert.equal(r.status, 201, r.text);
    });
    it('GET requests need no Origin and no Content-Type', async () => {
      assert.equal((await owner.get('/api/me')).status, 200);
      assert.equal((await owner.get('/api/addresses')).status, 200);
    });
    it('a CSRF-rejected request has no side effects', async () => {
      const before = (await owner.get('/api/users')).json.users.length;
      await owner.post('/api/users', { name: 'Test Csrf', email: 'csrf-nope@example.com' }, { origin: 'http://evil.example.com' });
      assert.equal((await owner.get('/api/users')).json.users.length, before);
    });
  });

  // ------------------------------------------------------------------ users
  describe('users and permissions', () => {
    let m1; // member created by the owner
    let m2; // co-user created by a member

    it('owner creates a co-user: 12-char password from the unambiguous alphabet, shown once, must change', async () => {
      const r = await owner.post('/api/users', { name: 'Test Member One', email: 'member1@example.com' });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.json.password.length, 12);
      for (const ch of r.json.password) assert.ok(ALPHABET.includes(ch), `bad char ${ch}`);
      assert.equal(r.json.user.role, 'member');
      assert.equal(r.json.user.must_change_password, true);
      assert.equal(r.json.user.disabled, false);
      assert.equal(r.json.user.created_by, 1);
      assert.equal('password_hash' in r.json.user, false);
      // The password is not retrievable later.
      const list = await owner.get('/api/users');
      assert.ok(!list.text.includes(r.json.password));
      m1 = { id: r.json.user.id, email: 'member1@example.com', generated: r.json.password, c: client('member1') };
    });

    it('two generated passwords differ', async () => {
      const a = await owner.post('/api/users', { name: 'Test A', email: 'gen-a@example.com' });
      const b = await owner.post('/api/users', { name: 'Test B', email: 'gen-b@example.com' });
      assert.notEqual(a.json.password, b.json.password);
    });

    it('create-user validation: name and email required, email syntax', async () => {
      const bad = [{}, { name: 'Test' }, { email: 'a@example.com' }, { name: 'Test', email: 'nope' }, { name: '  ', email: 'a@example.com' }];
      for (const b of bad) {
        const r = await owner.post('/api/users', b);
        assertError(r, 400, 'validation');
        assert.ok(r.json.fields && Object.keys(r.json.fields).length, JSON.stringify(b));
      }
    });

    it('new user can log in with the generated password and is flagged must_change_password', async () => {
      const r = await m1.c.login(m1.email, m1.generated);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.user.must_change_password, true);
    });

    it('while must_change_password=1 every route except me/password/logout returns 403 password_change_required', async () => {
      const blocked = [
        ['GET', '/api/users'], ['POST', '/api/users', { name: 'Test X', email: 'x1@example.com' }],
        ['POST', '/api/users/1/disable'], ['POST', '/api/users/1/enable'], ['POST', '/api/users/1/reset-password'],
        ['GET', '/api/addresses'], ['POST', '/api/addresses', addr()], ['GET', '/api/addresses/1'],
        ['PUT', '/api/addresses/1', addr()], ['DELETE', '/api/addresses/1'], ['GET', '/api/export.csv'],
      ];
      for (const [m, p, b] of blocked) assertError(await m1.c.req(m, p, b), 403, 'password_change_required');
      const me = await m1.c.get('/api/me');
      assert.equal(me.status, 200);
      assert.equal(me.json.user.must_change_password, true);
    });

    it('password change: current password required and checked; minimum 8 characters', async () => {
      const c = m1.c;
      assertError(await c.post('/api/password', { new_password: 'LongEnough1' }), 400, 'invalid_current_password');
      assertError(await c.post('/api/password', { current_password: '', new_password: 'LongEnough1' }), 400, 'invalid_current_password');
      assertError(await c.post('/api/password', { current_password: 'wrong-current', new_password: 'LongEnough1' }), 400, 'invalid_current_password');
      assertError(await c.post('/api/password', { current_password: m1.generated, new_password: '1234567' }), 400, 'validation');
      assertError(await c.post('/api/password', { current_password: m1.generated, new_password: '' }), 400, 'validation');
      assertError(await c.post('/api/password', { current_password: m1.generated }), 400, 'validation');
      // still gated, nothing changed
      assert.equal((await c.get('/api/me')).json.user.must_change_password, true);
    });

    it('password change with an 8-character password succeeds, clears the flag, old password stops working', async () => {
      const r = await m1.c.post('/api/password', { current_password: m1.generated, new_password: '12345678' });
      assert.equal(r.status, 200, r.text);
      assert.equal((await m1.c.get('/api/me')).json.user.must_change_password, false);
      assert.equal((await m1.c.get('/api/addresses')).status, 200);
      assertError(await client('x').login(m1.email, m1.generated), 401, 'invalid_credentials');
      assert.equal((await client('x').login(m1.email, '12345678')).status, 200);
      // set a stronger one for later use
      assert.equal((await m1.c.post('/api/password', { current_password: '12345678', new_password: MEMBER_PW })).status, 200);
    });

    it('a MEMBER can create a co-user too, and the creator is recorded', async () => {
      const r = await m1.c.post('/api/users', { name: 'Test Member Two', email: 'member2@example.com' });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.json.password.length, 12);
      for (const ch of r.json.password) assert.ok(ALPHABET.includes(ch));
      assert.equal(r.json.user.created_by, m1.id);
      assert.equal(r.json.user.role, 'member');
      assert.equal(r.json.user.must_change_password, true);
      m2 = { id: r.json.user.id, email: 'member2@example.com', generated: r.json.password, c: client('member2') };
      const l = await m2.c.login(m2.email, m2.generated);
      assert.equal(l.status, 200);
      assert.equal(l.json.user.must_change_password, true);
      assert.equal((await m2.c.post('/api/password', { current_password: m2.generated, new_password: MEMBER_PW })).status, 200);
    });

    it('any logged-in user can list users; no response carries hash or salt', async () => {
      for (const c of [owner, m1.c]) {
        const r = await c.get('/api/users');
        assert.equal(r.status, 200);
        assert.ok(r.json.users.length >= 4);
        for (const u of r.json.users) {
          assert.deepEqual(Object.keys(u).sort(), ['created_at', 'created_by', 'disabled', 'email', 'id', 'must_change_password', 'name', 'role']);
        }
      }
    });

    it('member gets 403 on disable / enable / reset-password', async () => {
      for (const a of ['disable', 'enable', 'reset-password']) {
        assertError(await m1.c.post(`/api/users/${m2.id}/${a}`, {}), 403, 'forbidden');
      }
      // nothing happened to m2
      const u = (await owner.get('/api/users')).json.users.find((x) => x.id === m2.id);
      assert.equal(u.disabled, false);
      assert.equal(u.must_change_password, false);
      assert.equal((await client('x').login(m2.email, MEMBER_PW)).status, 200);
    });

    it('owner cannot be disabled (by the owner)', async () => {
      const r = await owner.post('/api/users/1/disable', {});
      assert.ok(r.status >= 400 && r.status < 500, `status ${r.status}`);
      assert.ok(r.json?.error);
      const me = await owner.get('/api/me');
      assert.equal(me.status, 200);
      assert.equal(me.json.user.disabled, false);
      assert.equal((await client('x').login(srv.owner.email, srv.owner.password)).status, 200);
    });

    it('disable/enable/reset on an unknown or malformed user id -> 404', async () => {
      for (const a of ['disable', 'enable', 'reset-password']) {
        assertError(await owner.post(`/api/users/99999/${a}`, {}), 404, 'not_found');
        assertError(await owner.post(`/api/users/abc/${a}`, {}), 404, 'not_found');
      }
    });

    it('disabling a user: existing session gets 401 immediately and login is refused (generic error)', async () => {
      assert.equal((await m2.c.get('/api/me')).status, 200);
      const d = await owner.post(`/api/users/${m2.id}/disable`, {});
      assert.equal(d.status, 200, d.text);
      assert.equal(d.json.user.disabled, true);
      // existing session
      for (const [m, p, b] of [['GET', '/api/me'], ['GET', '/api/addresses'], ['GET', '/api/users'], ['GET', '/api/export.csv'], ['POST', '/api/addresses', addr()], ['POST', '/api/password', { current_password: MEMBER_PW, new_password: 'AnotherPass-1' }]]) {
        assertError(await m2.c.req(m, p, b), 401, 'unauthorized');
      }
      // fresh login, correct password
      const l = await client('x').login(m2.email, MEMBER_PW);
      assertError(l, 401, 'invalid_credentials');
      const unknown = await client('x').login('never-existed@example.com', MEMBER_PW);
      assert.deepEqual(l.json, unknown.json, 'disabled looks the same as unknown');
      assert.equal(l.setCookies.length, 0);
      // shows as disabled in the list
      assert.equal((await owner.get('/api/users')).json.users.find((u) => u.id === m2.id).disabled, true);
    });

    it('re-enabling restores login (and the old password still works)', async () => {
      const e = await owner.post(`/api/users/${m2.id}/enable`, {});
      assert.equal(e.status, 200, e.text);
      assert.equal(e.json.user.disabled, false);
      assert.equal((await client('x').login(m2.email, MEMBER_PW)).status, 200);
      assert.equal((await m2.c.get('/api/me')).status, 200);
    });

    it('reset-password issues a new working password, invalidates the old one, forces a change', async () => {
      const r = await owner.post(`/api/users/${m2.id}/reset-password`, {});
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.password.length, 12);
      for (const ch of r.json.password) assert.ok(ALPHABET.includes(ch));
      assert.equal(r.json.user.must_change_password, true);
      assert.notEqual(r.json.password, MEMBER_PW);
      assertError(await client('x').login(m2.email, MEMBER_PW), 401, 'invalid_credentials');
      const c = client('m2-after-reset');
      const l = await c.login(m2.email, r.json.password);
      assert.equal(l.status, 200, l.text);
      assert.equal(l.json.user.must_change_password, true);
      assertError(await c.get('/api/addresses'), 403, 'password_change_required');
      assert.equal((await c.post('/api/password', { current_password: r.json.password, new_password: MEMBER_PW })).status, 200);
      assert.equal((await c.get('/api/addresses')).status, 200);
      m2.c = c;
    });

    it('there is no delete-user route (DELETE /api/users/:id -> 404 or 405) and the user still exists', async () => {
      for (const p of [`/api/users/${m2.id}`, '/api/users']) {
        const r = await owner.del(p);
        assert.ok([404, 405].includes(r.status), `${p} -> ${r.status}`);
      }
      for (const m of ['PUT', 'PATCH']) {
        const r = await owner.req(m, `/api/users/${m2.id}`, { name: 'Test Changed' });
        assert.ok([404, 405].includes(r.status), `${m} -> ${r.status}`);
      }
      const users = (await owner.get('/api/users')).json.users;
      assert.ok(users.some((u) => u.id === m2.id));
    });

    it('logout clears the cookie; the client then has no session', async () => {
      const c = client('logout-test');
      assert.equal((await c.login(m1.email, MEMBER_PW)).status, 200);
      const r = await c.post('/api/logout', {});
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
      assert.match(r.setCookies[0], /^fab_session=; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0$/);
      assert.equal(c.cookie, null);
      assert.equal((await c.get('/api/me')).status, 401);
    });

    it('logout is allowed while a password change is pending', async () => {
      const r = await owner.post('/api/users', { name: 'Test Pending', email: 'pending@example.com' });
      const c = client('pending');
      await c.login('pending@example.com', r.json.password);
      const out = await c.post('/api/logout', {});
      assert.equal(out.status, 200);
    });

    it('session cookie of one user cannot be used as another (user id is signed)', async () => {
      const tok = m1.c.cookie.split('=')[1];
      const [, exp, mac] = tok.split('.');
      const forged = client('forged');
      const r = await forged.get('/api/me', { headers: { Cookie: `fab_session=1.${exp}.${mac}` } });
      assert.equal(r.status, 401);
    });

    it('member shared state for later sections', async () => {
      member = { id: m1.id, email: m1.email, c: m1.c, m2 };
      assert.ok(member.c.cookie);
    });
  });

  // ------------------------------------------------------------------ lockout
  describe('brute-force lockout (per lower-cased email, failures only)', () => {
    it('unknown email: 5 failures then the 6th attempt gets 429', async () => {
      for (let i = 1; i <= 5; i++) {
        assertError(await client('x').login('lock-unknown@example.com', `wrong-${i}-password`), 401, 'invalid_credentials');
      }
      const r = await client('x').login('lock-unknown@example.com', 'wrong-6-password');
      assertError(r, 429, 'too_many_attempts');
      assert.ok(Number(r.headers.get('Retry-After')) > 0, 'Retry-After header');
      assert.equal(r.setCookies.length, 0);
    });

    it('existing user: after 5 failures even the CORRECT password is refused with 429', async () => {
      const u = await owner.post('/api/users', { name: 'Test Lock', email: 'lock-member@example.com' });
      for (let i = 1; i <= 5; i++) {
        assertError(await client('x').login('lock-member@example.com', `wrong-${i}-password`), 401, 'invalid_credentials');
      }
      const r = await client('x').login('lock-member@example.com', u.json.password);
      assertError(r, 429, 'too_many_attempts');
      // same response body shape whether or not the account exists
      const unknown = await client('x').login('lock-unknown@example.com', 'x-password');
      assert.deepEqual(r.json, unknown.json);
    });

    it('other emails are not affected by someone else being locked out', async () => {
      assert.equal((await client('x').login(srv.owner.email, srv.owner.password)).status, 200);
    });

    it('the key is the lower-cased email: mixed-case attempts share one counter', async () => {
      const mails = ['Lock-Case@Example.com', 'LOCK-CASE@EXAMPLE.COM', 'lock-case@example.com', 'lock-CASE@example.com', ' lock-case@example.com '];
      for (const m of mails) assertError(await client('x').login(m, 'wrong-password-1'), 401, 'invalid_credentials');
      assertError(await client('x').login('lock-case@EXAMPLE.com', 'wrong-password-1'), 429, 'too_many_attempts');
    });

    it('successful logins do not count: 4 failures, 1 success, 1 failure (5th) -> still 401, next -> 429', async () => {
      const u = await owner.post('/api/users', { name: 'Test Count', email: 'lock-count@example.com' });
      for (let i = 0; i < 4; i++) assertError(await client('x').login('lock-count@example.com', 'wrong-password-1'), 401, 'invalid_credentials');
      assert.equal((await client('x').login('lock-count@example.com', u.json.password)).status, 200);
      assertError(await client('x').login('lock-count@example.com', 'wrong-password-1'), 401, 'invalid_credentials');
      assertError(await client('x').login('lock-count@example.com', u.json.password), 429, 'too_many_attempts');
    });

    it('exactly 4 failures do not lock: the 5th attempt with the right password succeeds', async () => {
      const u = await owner.post('/api/users', { name: 'Test Four', email: 'lock-four@example.com' });
      for (let i = 0; i < 4; i++) assertError(await client('x').login('lock-four@example.com', 'wrong-password-1'), 401, 'invalid_credentials');
      assert.equal((await client('x').login('lock-four@example.com', u.json.password)).status, 200);
    });

    it('failed attempts are stored keyed by lower-cased email', () => {
      const rows = srv.d1("SELECT email, COUNT(*) AS n FROM login_attempts GROUP BY email");
      assert.ok(rows.every((r) => r.email === r.email.toLowerCase().trim()));
      assert.equal(rows.find((r) => r.email === 'lock-unknown@example.com').n, 5);
      assert.equal(rows.find((r) => r.email === 'lock-case@example.com').n, 5);
    });
  });

  // ------------------------------------------------------------------ addresses
  describe('addresses: validation', () => {
    for (const f of ['first_name', 'address_line1', 'city', 'state', 'pin', 'phone']) {
      it(`${f} is required (missing, empty, blank)`, async () => {
        for (const bad of [undefined, '', '   ']) {
          const body = addr({ [f]: bad });
          if (bad === undefined) delete body[f];
          const r = await owner.post('/api/addresses', body);
          assertError(r, 400, 'validation');
          assert.ok(r.json.fields[f], `fields.${f} present`);
        }
      });
    }
    it('optional fields may be omitted', async () => {
      const r = await owner.post('/api/addresses', addr({ first_name: 'OptionalOnly' }));
      assert.equal(r.status, 201, r.text);
      const a = r.json.address;
      for (const f of ['surname', 'address_line2', 'landmark', 'email', 'group_name', 'notes']) {
        if (f === 'surname') continue;
        assert.equal(a[f], null, f);
      }
    });
    it('surname is optional', async () => {
      const body = addr({ first_name: 'NoSurname' }); delete body.surname;
      const r = await owner.post('/api/addresses', body);
      assert.equal(r.status, 201, r.text);
      assert.equal(r.json.address.surname, null);
    });
    it('PIN must be exactly 6 digits', async () => {
      for (const pin of ['12345', '1234567', 'abcdef', '12 345', '12345a', '١٢٣٤٥٦']) {
        assertError(await owner.post('/api/addresses', addr({ pin })), 400, 'validation');
      }
      assert.equal((await owner.post('/api/addresses', addr({ pin: '000000' }))).status, 201);
    });
    it('phone format: wrong lengths and letters rejected', async () => {
      for (const phone of ['12345', '987654321', '98765432100', 'abcdefghij', '+91 12345', '+1 9876543210']) {
        const r = await owner.post('/api/addresses', addr({ phone }));
        assertError(r, 400, 'validation');
        assert.ok(r.json.fields.phone, phone);
      }
    });
    it('email optional; validated when present; stored lower-cased', async () => {
      for (const email of ['nope', 'a@b', 'a b@example.com', '@example.com']) {
        const r = await owner.post('/api/addresses', addr({ email }));
        assertError(r, 400, 'validation');
        assert.ok(r.json.fields.email, email);
      }
      const ok = await owner.post('/api/addresses', addr({ email: 'Test@Example.COM' }));
      assert.equal(ok.status, 201);
      assert.equal(ok.json.address.email, 'test@example.com');
      const blank = await owner.post('/api/addresses', addr({ email: '' }));
      assert.equal(blank.status, 201);
      assert.equal(blank.json.address.email, null);
    });
    it('length limits', async () => {
      assertError(await owner.post('/api/addresses', addr({ first_name: 'x'.repeat(101) })), 400, 'validation');
      assertError(await owner.post('/api/addresses', addr({ notes: 'x'.repeat(1001) })), 400, 'validation');
    });
    it('non-string values are rejected', async () => {
      assertError(await owner.post('/api/addresses', addr({ first_name: 123 })), 400, 'validation');
      assertError(await owner.post('/api/addresses', addr({ pin: 560001 })), 400, 'validation');
    });
    it('invalid JSON body -> 400 invalid_json; non-object body -> 400', async () => {
      assertError(await owner.post('/api/addresses', '{oops'), 400, 'invalid_json');
      assertError(await owner.post('/api/addresses', '[1]'), 400, 'invalid_json');
      assertError(await owner.post('/api/addresses', 'null'), 400, 'invalid_json');
    });
    it('validation failures create nothing', async () => {
      const before = (await owner.get('/api/addresses?q=NeverSaved')).json.addresses.length;
      await owner.post('/api/addresses', addr({ first_name: 'NeverSaved', pin: '1' }));
      assert.equal((await owner.get('/api/addresses?q=NeverSaved')).json.addresses.length, before);
    });
    it('unknown fields cannot override server-controlled columns', async () => {
      const r = await owner.post('/api/addresses', addr({ first_name: 'Mass', created_by: 999, id: 424242, deleted_at: '2020-01-01T00:00:00Z', created_at: '2001-01-01T00:00:00Z' }));
      assert.equal(r.status, 201);
      assert.equal(r.json.address.created_by, 1);
      assert.notEqual(r.json.address.id, 424242);
      assert.equal(r.json.address.deleted_at, null);
      assert.notEqual(r.json.address.created_at, '2001-01-01T00:00:00Z');
    });
  });

  describe('addresses: phone normalisation and duplicates', () => {
    it('+91, leading 0, spaces and dashes are normalised to 10 digits on save', async () => {
      const cases = [['+91 98765 43211', '9876543211'], ['09876543212', '9876543212'], ['+919876543213', '9876543213'], [' 98765-43214 ', '9876543214'], ['(98765) 43215', '9876543215'], ['0 98765 43216', '9876543216']];
      for (const [input, want] of cases) {
        const r = await owner.post('/api/addresses', addr({ first_name: 'Norm', phone: input }));
        assert.equal(r.status, 201, `${input}: ${r.text}`);
        assert.equal(r.json.address.phone, want, input);
      }
    });

    let first;
    it('duplicate phone -> 409 duplicate_phone with the existing entry', async () => {
      const phone = nextPhone();
      const a = await owner.post('/api/addresses', addr({ first_name: 'DupOriginal', city: 'Dupcity', phone }));
      first = a.json.address;
      const r = await owner.post('/api/addresses', addr({ first_name: 'DupSecond', phone }));
      assertError(r, 409, 'duplicate_phone');
      assert.equal(r.json.existing.id, first.id);
      assert.equal(r.json.existing.first_name, 'DupOriginal');
      assert.equal(r.json.existing.phone, phone);
      assert.equal(r.json.existing.city, 'Dupcity');
      assert.equal((await owner.get('/api/addresses?q=DupSecond')).json.addresses.length, 0, 'not saved');
    });
    it('duplicate is detected after normalisation (+91 / 0 / spaces)', async () => {
      for (const fmt of [`+91 ${first.phone.slice(0, 5)} ${first.phone.slice(5)}`, `0${first.phone}`, `+91${first.phone}`]) {
        assertError(await owner.post('/api/addresses', addr({ first_name: 'DupFmt', phone: fmt })), 409, 'duplicate_phone');
      }
    });
    it('confirm_duplicate: true saves anyway; the string "true" does not', async () => {
      assertError(await owner.post('/api/addresses', addr({ first_name: 'DupStr', phone: first.phone, confirm_duplicate: 'true' })), 409, 'duplicate_phone');
      const r = await owner.post('/api/addresses', addr({ first_name: 'DupConfirmed', phone: first.phone, confirm_duplicate: true }));
      assert.equal(r.status, 201, r.text);
      assert.equal(r.json.address.phone, first.phone);
      assert.equal('confirm_duplicate' in r.json.address, false);
    });
    it('duplicate check applies to a MEMBER too', async () => {
      assertError(await member.c.post('/api/addresses', addr({ first_name: 'DupMember', phone: first.phone })), 409, 'duplicate_phone');
    });
    it('editing an entry without changing its phone is not a duplicate of itself', async () => {
      const phone = nextPhone();
      const a = (await owner.post('/api/addresses', addr({ first_name: 'SelfEdit', phone }))).json.address;
      const r = await owner.put(`/api/addresses/${a.id}`, addr({ first_name: 'SelfEdited', phone }));
      assert.equal(r.status, 200, r.text);
    });
    it('PUT to another entry\'s phone -> 409; with confirm_duplicate -> 200', async () => {
      const a = (await owner.post('/api/addresses', addr({ first_name: 'PutDupA' }))).json.address;
      const b = (await owner.post('/api/addresses', addr({ first_name: 'PutDupB' }))).json.address;
      const r = await owner.put(`/api/addresses/${b.id}`, addr({ first_name: 'PutDupB', phone: a.phone }));
      assertError(r, 409, 'duplicate_phone');
      assert.equal(r.json.existing.id, a.id);
      assert.equal((await owner.get(`/api/addresses/${b.id}`)).json.address.phone, b.phone, 'unchanged');
      const ok = await owner.put(`/api/addresses/${b.id}`, addr({ first_name: 'PutDupB', phone: a.phone, confirm_duplicate: true }));
      assert.equal(ok.status, 200, ok.text);
      assert.equal(ok.json.address.phone, a.phone);
    });
    it('the phone of a soft-deleted entry is not reported as a duplicate', async () => {
      const phone = nextPhone();
      const a = (await owner.post('/api/addresses', addr({ first_name: 'GoneDup', phone }))).json.address;
      assert.equal((await owner.del(`/api/addresses/${a.id}`)).status, 200);
      assert.equal((await owner.post('/api/addresses', addr({ first_name: 'GoneDup2', phone }))).status, 201);
    });
  });

  describe('addresses: search and filter', () => {
    let A, B, C;
    before(async () => {
      const mk = async (o) => (await owner.post('/api/addresses', addr(o))).json.address;
      A = await mk({ first_name: 'Alphaxq', surname: 'Searchsurxq', city: 'Testopolisxq', pin: '560101', phone: '9000000001', group_name: 'Family' });
      B = await mk({ first_name: 'Betaxq', surname: 'Othersonxq', city: 'Examplepurxq', pin: '560202', phone: '9000000002', group_name: 'Friends' });
      C = await mk({ first_name: 'Gammaxq', city: 'Testopolisxq', pin: '560303', phone: '9000000003', group_name: 'Family' });
    });
    const ids = async (qs, c = owner) => (await c.get(`/api/addresses?${qs}`)).json.addresses.map((a) => a.id).sort((x, y) => x - y);
    const sorted = (...a) => a.map((x) => x.id).sort((x, y) => x - y);

    it('by first name (case-insensitive, partial)', async () => {
      assert.deepEqual(await ids('q=alphaxq'), sorted(A));
      assert.deepEqual(await ids('q=ALPHAX'), sorted(A));
    });
    it('by surname', async () => assert.deepEqual(await ids('q=searchsurxq'), sorted(A)));
    it('by city', async () => assert.deepEqual(await ids('q=Testopolisxq'), sorted(A, C)));
    it('by PIN', async () => assert.deepEqual(await ids('q=560202'), sorted(B)));
    it('by phone (full and partial)', async () => {
      assert.deepEqual(await ids('q=9000000003'), sorted(C));
      assert.deepEqual(await ids('q=000000002'), sorted(B));
    });
    it('no match -> empty list', async () => assert.deepEqual(await ids('q=zzzznomatchzzzz'), []));
    it('LIKE wildcards in the query are treated literally', async () => {
      assert.deepEqual(await ids('q=%25'), []);
      assert.deepEqual(await ids('q=_'), []);
      assert.deepEqual(await ids('q=Alph_xq'), []);
    });
    it('SQL metacharacters in q do not break the query', async () => {
      const r = await owner.get(`/api/addresses?q=${encodeURIComponent("' OR 1=1 --")}`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.addresses, []);
    });
    it('group filter', async () => {
      const fam = await ids('group=Family');
      assert.ok(fam.includes(A.id) && fam.includes(C.id) && !fam.includes(B.id));
      assert.deepEqual(await ids('group=Friends&q=xq'), sorted(B));
    });
    it('q and group combine', async () => assert.deepEqual(await ids('q=Testopolisxq&group=Family'), sorted(A, C)));
    it('the response lists the available groups', async () => {
      const r = await owner.get('/api/addresses');
      assert.ok(r.json.groups.includes('Family') && r.json.groups.includes('Friends'));
    });
    it('a member sees the same entries', async () => {
      assert.deepEqual(await ids('q=Testopolisxq', member.c), sorted(A, C));
    });
    it('results are ordered by first name (case-insensitive)', async () => {
      const names = (await owner.get('/api/addresses?q=xq')).json.addresses.map((a) => a.first_name);
      assert.deepEqual(names, [...names].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase())));
    });
  });

  describe('addresses: members, edit, delete', () => {
    it('created_by_name is the creating user\'s name (list and single GET)', async () => {
      const mine = (await member.c.post('/api/addresses', addr({ first_name: 'ByMember' }))).json.address;
      const theirs = (await owner.post('/api/addresses', addr({ first_name: 'ByOwner' }))).json.address;
      assert.equal(mine.created_by, member.id);
      assert.equal(mine.created_by_name, 'Test Member One');
      assert.equal(theirs.created_by_name, 'Owner');
      const list = (await owner.get('/api/addresses?q=By')).json.addresses;
      assert.equal(list.find((a) => a.id === mine.id).created_by_name, 'Test Member One');
      assert.equal((await member.c.get(`/api/addresses/${theirs.id}`)).json.address.created_by_name, 'Owner');
    });

    it('a member can edit an address created by the owner; updated_by changes, created_by does not', async () => {
      const a = (await owner.post('/api/addresses', addr({ first_name: 'EditMe', city: 'Before' }))).json.address;
      assert.equal(a.updated_by, 1);
      const r = await member.c.put(`/api/addresses/${a.id}`, addr({ first_name: 'EditMe', city: 'After', phone: a.phone }));
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.address.city, 'After');
      assert.equal(r.json.address.updated_by, member.id);
      assert.equal(r.json.address.created_by, 1);
      assert.equal(r.json.address.created_by_name, 'Owner');
      const again = (await owner.get(`/api/addresses/${a.id}`)).json.address;
      assert.equal(again.updated_by, member.id);
      assert.equal(again.city, 'After');
      assert.ok(again.updated_at >= again.created_at);
    });

    it('PUT validates too (and applies normalisation)', async () => {
      const a = (await owner.post('/api/addresses', addr({ first_name: 'PutVal' }))).json.address;
      const bad = await owner.put(`/api/addresses/${a.id}`, addr({ first_name: 'PutVal', pin: '12' }));
      assertError(bad, 400, 'validation');
      assert.ok(bad.json.fields.pin);
      const ok = await owner.put(`/api/addresses/${a.id}`, addr({ first_name: 'PutVal', phone: '+91 98765 40000' }));
      assert.equal(ok.status, 200, ok.text);
      assert.equal(ok.json.address.phone, '9876540000');
    });

    it('PUT/GET on unknown or malformed ids -> 404', async () => {
      assertError(await owner.get('/api/addresses/99999999'), 404, 'not_found');
      assertError(await owner.get('/api/addresses/abc'), 404, 'not_found');
      assertError(await owner.put('/api/addresses/99999999', addr()), 404, 'not_found');
      assertError(await owner.del('/api/addresses/99999999'), 404, 'not_found');
    });

    it('a member gets 403 on address DELETE and the address survives', async () => {
      const a = (await owner.post('/api/addresses', addr({ first_name: 'KeepMe' }))).json.address;
      assertError(await member.c.del(`/api/addresses/${a.id}`), 403, 'forbidden');
      assert.equal((await owner.get(`/api/addresses/${a.id}`)).status, 200);
    });

    it('owner soft-deletes: hidden from list, GET, CSV and search; row remains with deleted_at', async () => {
      const a = (await owner.post('/api/addresses', addr({ first_name: 'SoftDelXq', surname: 'Zed', city: 'Vanishcity' }))).json.address;
      assert.equal((await owner.get('/api/addresses?q=SoftDelXq')).json.addresses.length, 1);
      const d = await owner.del(`/api/addresses/${a.id}`);
      assert.equal(d.status, 200, d.text);
      assert.equal(d.json.ok, true);
      assert.equal((await owner.get('/api/addresses?q=SoftDelXq')).json.addresses.length, 0);
      assert.ok(!(await owner.get('/api/addresses')).json.addresses.some((x) => x.id === a.id));
      assertError(await owner.get(`/api/addresses/${a.id}`), 404, 'not_found');
      assertError(await member.c.get(`/api/addresses/${a.id}`), 404, 'not_found');
      assertError(await owner.put(`/api/addresses/${a.id}`, addr({ phone: a.phone })), 404, 'not_found');
      assertError(await owner.del(`/api/addresses/${a.id}`), 404, 'not_found');
      const csv = await owner.get('/api/export.csv');
      assert.ok(!csv.text.includes('SoftDelXq'));
      const rows = srv.d1(`SELECT id, deleted_at, first_name FROM addresses WHERE id = ${a.id}`);
      assert.equal(rows.length, 1, 'row still exists');
      assert.match(rows[0].deleted_at, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(!(await owner.get('/api/addresses')).json.groups.includes('Vanishgroup'));
    });

    it('groups of deleted entries are not listed', async () => {
      const a = (await owner.post('/api/addresses', addr({ first_name: 'GroupGone', group_name: 'Vanishgroup' }))).json.address;
      assert.ok((await owner.get('/api/addresses')).json.groups.includes('Vanishgroup'));
      await owner.del(`/api/addresses/${a.id}`);
      assert.ok(!(await owner.get('/api/addresses')).json.groups.includes('Vanishgroup'));
    });

    it('POST /api/addresses/:id and other odd methods are not accepted', async () => {
      const r = await owner.post('/api/addresses/1', addr());
      assert.ok([404, 405].includes(r.status), String(r.status));
    });
  });

  // ------------------------------------------------------------------ CSV
  describe('CSV export', () => {
    const HEADERS = ['id', 'first_name', 'surname', 'address_line1', 'address_line2', 'landmark', 'city', 'state', 'pin', 'phone', 'email', 'group_name', 'notes', 'created_by_name', 'created_at', 'updated_at'];
    let csvRows;
    const col = (row, name) => row[HEADERS.indexOf(name)];

    before(async () => {
      const mk = (o) => member.c.post('/api/addresses', addr(o));
      await mk({ first_name: 'CsvPlain', surname: 'Row', notes: 'Line one\nLine two, with comma and "quotes"' });
      await mk({ first_name: '=SUM(1,2)', surname: 'Formula' });
      await mk({ first_name: 'CsvPlus', surname: '+cmd|calc', address_line1: '-1+1 Example Road' });
      await mk({ first_name: 'CsvAt', surname: '@SUM(A1)', });
      await mk({ first_name: 'CsvComma', surname: 'Smith, Jr', address_line1: '1 "Quoted" Road' });
      await mk({ first_name: 'CsvEmail', email: 'Csv@Example.com', group_name: 'Family' });
      const r = await owner.get('/api/export.csv');
      csvRows = parseCsv(r.text);
    });

    it('requires a session; a member can export too', async () => {
      assertError(await client('x').get('/api/export.csv'), 401, 'unauthorized');
      assert.equal((await member.c.get('/api/export.csv')).status, 200);
    });
    it('response headers: text/csv attachment, no-store', async () => {
      const r = await owner.get('/api/export.csv');
      assert.match(r.headers.get('content-type'), /^text\/csv/);
      assert.match(r.headers.get('content-disposition'), /^attachment;.*\.csv/);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    });
    it('body starts with a UTF-8 BOM (checked on raw bytes; fetch().text() strips it)', async () => {
      const res = await fetch(`${srv.baseUrl}/api/export.csv`, { headers: { Cookie: owner.cookie } });
      const bytes = new Uint8Array(await res.arrayBuffer());
      assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
      assert.equal(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).charCodeAt(0), 0xfeff);
      assert.equal(new TextDecoder().decode(bytes.slice(3)).split(/\r?\n/)[0], HEADERS.join(','), 'header row follows the BOM');
      assert.equal(bytes[3], 'i'.charCodeAt(0), 'exactly one BOM');
    });
    it('non-ASCII text survives the export as UTF-8', async () => {
      await member.c.post('/api/addresses', addr({ first_name: 'Zoë', surname: 'Müller', city: 'Mysūru' }));
      const res = await fetch(`${srv.baseUrl}/api/export.csv`, { headers: { Cookie: owner.cookie } });
      const text = new TextDecoder().decode(await res.arrayBuffer());
      const row = parseCsv(text).find((r) => r[HEADERS.indexOf('first_name')] === 'Zoë');
      assert.ok(row);
      assert.equal(row[HEADERS.indexOf('surname')], 'Müller');
      assert.equal(row[HEADERS.indexOf('city')], 'Mysūru');
    });
    it('exact header row', async () => {
      const r = await owner.get('/api/export.csv');
      assert.equal(r.text.split(/\r?\n/)[0], HEADERS.join(','));
      assert.deepEqual(csvRows[0], HEADERS);
    });
    it('every row has the same number of cells as the header (quoting round-trips)', () => {
      for (const row of csvRows.filter((r) => r.length > 1 || r[0] !== '')) assert.equal(row.length, HEADERS.length, JSON.stringify(row));
    });
    it('commas, quotes and newlines are quoted and round-trip', () => {
      const row = csvRows.find((r) => col(r, 'first_name') === 'CsvPlain');
      assert.equal(col(row, 'notes'), 'Line one\nLine two, with comma and "quotes"');
      const row2 = csvRows.find((r) => col(r, 'first_name') === 'CsvComma');
      assert.equal(col(row2, 'surname'), 'Smith, Jr');
      assert.equal(col(row2, 'address_line1'), '1 "Quoted" Road');
    });
    it('raw text contains correctly escaped quotes', async () => {
      const r = await owner.get('/api/export.csv');
      assert.ok(r.text.includes('"1 ""Quoted"" Road"'));
      assert.ok(r.text.includes('"Smith, Jr"'));
    });
    it('formula neutralisation: cells starting with = + - @ get a leading apostrophe', () => {
      assert.equal(col(csvRows.find((r) => col(r, 'surname') === 'Formula'), 'first_name'), "'=SUM(1,2)");
      const plus = csvRows.find((r) => col(r, 'first_name') === 'CsvPlus');
      assert.equal(col(plus, 'surname'), "'+cmd|calc");
      assert.equal(col(plus, 'address_line1'), "'-1+1 Example Road");
      const at = csvRows.find((r) => col(r, 'first_name') === 'CsvAt');
      assert.equal(col(at, 'surname'), "'@SUM(A1)");
    });
    it('no cell in the whole file starts with a dangerous character (except plain id/pin/phone digits)', () => {
      for (const row of csvRows.slice(1)) {
        row.forEach((cell, i) => {
          if (['id', 'pin', 'phone'].includes(HEADERS[i])) return;
          assert.doesNotMatch(cell, /^[=+\-@\t\r]/, `${HEADERS[i]}: ${JSON.stringify(cell)}`);
        });
      }
    });
    it('plain digits in id/pin/phone are not prefixed; email lower-cased', () => {
      const row = csvRows.find((r) => col(r, 'first_name') === 'CsvEmail');
      assert.match(col(row, 'id'), /^\d+$/);
      assert.match(col(row, 'pin'), /^\d{6}$/);
      assert.match(col(row, 'phone'), /^\d{10}$/);
      assert.equal(col(row, 'email'), 'csv@example.com');
      assert.equal(col(row, 'group_name'), 'Family');
    });
    it('created_by_name column filled; timestamps present', () => {
      const row = csvRows.find((r) => col(r, 'first_name') === 'CsvPlain');
      assert.equal(col(row, 'created_by_name'), 'Test Member One');
      assert.match(col(row, 'created_at'), /^\d{4}-\d{2}-\d{2}T/);
      assert.match(col(row, 'updated_at'), /^\d{4}-\d{2}-\d{2}T/);
    });
    it('POST to export.csv is not allowed', async () => {
      const r = await owner.post('/api/export.csv', {});
      assert.ok([404, 405].includes(r.status));
    });
  });


  // ------------------------------------------------------------------ session invalidation
  describe('session invalidation (sessions_valid_after)', () => {
    it('migrations 0002 applied: columns exist with the agreed defaults', () => {
      const cols = srv.d1("SELECT name, type, \"notnull\" AS nn, dflt_value FROM pragma_table_info('users')");
      const sva = cols.find((c) => c.name === 'sessions_valid_after');
      const pit = cols.find((c) => c.name === 'password_iterations');
      assert.ok(sva && pit, JSON.stringify(cols));
      assert.equal(sva.type, 'INTEGER'); assert.equal(sva.nn, 1); assert.equal(String(sva.dflt_value), '0');
      assert.equal(pit.type, 'INTEGER'); assert.equal(pit.nn, 1); assert.equal(String(pit.dflt_value), '10000');
    });

    it('every stored hash records 10000 iterations (bootstrap, create, reset, change)', () => {
      const rows = srv.d1('SELECT email, password_iterations FROM users');
      assert.ok(rows.length >= 3);
      for (const r of rows) assert.equal(r.password_iterations, 10000, r.email);
    });

    it('stored iteration count is used when verifying (lowering it for one user locks only that hash)', async () => {
      const u = await makeMember(owner, 'Test Iter', 'iter-user@example.com');
      // Same password, but claim a different iteration count: the stored hash no longer matches.
      srv.d1(`UPDATE users SET password_iterations = 5000 WHERE id = ${u.id}`);
      assertError(await client('x').login(u.email, MEMBER_PW), 401, 'invalid_credentials');
      srv.d1(`UPDATE users SET password_iterations = 10000 WHERE id = ${u.id}`);
      assert.equal((await client('x').login(u.email, MEMBER_PW)).status, 200);
    });

    it('disable -> enable: the OLD cookie stays dead, a new login works', async () => {
      const u = await makeMember(owner, 'Test Revive', 'revive-user@example.com');
      const oldCookie = u.c.cookie;
      assert.equal((await withCookie(oldCookie).get('/api/me')).status, 200);
      await sleep(PAST_SECOND_BOUNDARY_MS);
      assert.equal((await owner.post(`/api/users/${u.id}/disable`, {})).status, 200);
      assertError(await withCookie(oldCookie).get('/api/me'), 401, 'unauthorized');
      assert.equal((await owner.post(`/api/users/${u.id}/enable`, {})).status, 200);
      assertError(await withCookie(oldCookie).get('/api/me'), 401, 'unauthorized');
      assertError(await withCookie(oldCookie).get('/api/addresses'), 401, 'unauthorized');
      const fresh = client('revive-new');
      assert.equal((await fresh.login(u.email, MEMBER_PW)).status, 200);
      assert.equal((await fresh.get('/api/me')).status, 200, 'cookie issued right after the bump is accepted');
      assert.ok(srv.d1(`SELECT sessions_valid_after AS v FROM users WHERE id = ${u.id}`)[0].v > 0);
    });

    it('password change: other sessions of the user die, the changing session continues on the new cookie', async () => {
      const u = await makeMember(owner, 'Test Change', 'change-user@example.com');
      const second = client('change-second');
      assert.equal((await second.login(u.email, MEMBER_PW)).status, 200);
      const before = u.c.cookie;
      await sleep(PAST_SECOND_BOUNDARY_MS);
      const NEW = 'ChangedMember-789';
      const r = await u.c.post('/api/password', { current_password: MEMBER_PW, new_password: NEW });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.setCookies.length, 1, 'response carries a fresh cookie');
      assert.match(r.setCookies[0], /^fab_session=[^;]+; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
      assert.notEqual(u.c.cookie, before, 'cookie jar updated');
      // The changing session keeps working via the new cookie (issued in the same second as the bump).
      assert.equal((await u.c.get('/api/me')).status, 200);
      assert.equal((await u.c.get('/api/addresses')).status, 200);
      // Old cookies of the same user are dead, including the changing session's previous cookie.
      assertError(await second.get('/api/me'), 401, 'unauthorized');
      assertError(await withCookie(before).get('/api/me'), 401, 'unauthorized');
      // New password logs in.
      assert.equal((await client('x').login(u.email, NEW)).status, 200);
    });

    it('failed password change does not touch sessions or cookies', async () => {
      const u = await makeMember(owner, 'Test NoChange', 'nochange-user@example.com');
      const other = client('nochange-second');
      assert.equal((await other.login(u.email, MEMBER_PW)).status, 200);
      await sleep(PAST_SECOND_BOUNDARY_MS);
      const r = await u.c.post('/api/password', { current_password: 'wrong-current-1', new_password: 'SomethingNew-12' });
      assertError(r, 400, 'invalid_current_password');
      assert.equal(r.setCookies.length, 0);
      assert.equal((await other.get('/api/me')).status, 200);
      assert.equal((await u.c.get('/api/me')).status, 200);
    });

    it('forced first-login password change also issues a working cookie', async () => {
      const r = await owner.post('/api/users', { name: 'Test First', email: 'first-change@example.com' });
      const c = client('first');
      assert.equal((await c.login('first-change@example.com', r.json.password)).status, 200);
      const p = await c.post('/api/password', { current_password: r.json.password, new_password: MEMBER_PW });
      assert.equal(p.status, 200);
      assert.equal(p.setCookies.length, 1);
      assert.equal((await c.get('/api/addresses')).status, 200);
    });

    it('owner reset-password: the user\'s existing session gets 401; their new login works', async () => {
      const u = await makeMember(owner, 'Test Reset', 'reset-session-user@example.com');
      const oldCookie = u.c.cookie;
      assert.equal((await u.c.get('/api/me')).status, 200);
      await sleep(PAST_SECOND_BOUNDARY_MS);
      const r = await owner.post(`/api/users/${u.id}/reset-password`, {});
      assert.equal(r.status, 200, r.text);
      assertError(await withCookie(oldCookie).get('/api/me'), 401, 'unauthorized');
      const fresh = client('reset-new');
      assert.equal((await fresh.login(u.email, r.json.password)).status, 200);
      assertError(await fresh.get('/api/addresses'), 403, 'password_change_required'); // authenticated, not 401
    });

    it('other users\' sessions are unaffected by someone else\'s change', async () => {
      const a = await makeMember(owner, 'Test Bystander A', 'bystander-a@example.com');
      const b = await makeMember(owner, 'Test Bystander B', 'bystander-b@example.com');
      await sleep(PAST_SECOND_BOUNDARY_MS);
      assert.equal((await owner.post(`/api/users/${b.id}/reset-password`, {})).status, 200);
      assert.equal((await a.c.get('/api/me')).status, 200);
      assert.equal((await owner.get('/api/me')).status, 200, 'owner session unaffected');
    });
  });

  // ------------------------------------------------------------------ unknown API paths
  describe('unknown /api paths', () => {
    const notFound = (r) => assertError(r, 404, 'not_found');
    it('unknown paths and methods return a JSON 404 {error:not_found,message}', async () => {
      for (const c of [owner, client('anon')]) {
        notFound(await c.get('/api/does-not-exist'));
        notFound(await c.get('/api/a/b/c/d'));
        notFound(await c.post('/api/nope', {}));
        notFound(await c.put('/api/nope', {}));
        notFound(await c.del('/api/nope'));
        notFound(await c.req('PATCH', '/api/users/1/whatever', {}));
        notFound(await c.get('/api/users/1/not-an-action'));
      }
      const r = await owner.get('/api/missing');
      assert.match(r.headers.get('content-type'), /^application\/json/);
    });
    it('DELETE /api/users/:id (no such route by design) now has a JSON error body', async () => {
      const users = (await owner.get('/api/users')).json.users;
      const target = users.find((u) => u.role !== 'owner');
      for (const p of [`/api/users/${target.id}`, '/api/users/99999']) {
        const r = await owner.del(p);
        assert.ok([404, 405].includes(r.status), `${p} -> ${r.status}`);
        assert.ok(r.json && typeof r.json.error === 'string' && typeof r.json.message === 'string', `${p}: ${r.text}`);
      }
      assert.ok((await owner.get('/api/users')).json.users.some((u) => u.id === target.id), 'user still exists');
    });
    it('the catch-all does not shadow real routes', async () => {
      assert.equal((await owner.get('/api/me')).status, 200);
      assert.equal((await owner.get('/api/users')).status, 200);
      assert.equal((await owner.get('/api/addresses')).status, 200);
      assert.equal((await owner.get('/api/addresses/99999999')).status, 404);
      assert.equal((await owner.get('/api/addresses/99999999')).json.error, 'not_found');
      assert.equal((await owner.get('/api/export.csv')).status, 200);
      assertError(await client('anon').get('/api/me'), 401, 'unauthorized');
      assertError(await client('anon').login('nobody-here@example.com', 'whatever-123'), 401, 'invalid_credentials');
      assertError(await owner.post('/api/users/99999/disable', {}), 404, 'not_found');
      assertError(await owner.post('/api/users/99999/enable', {}), 404, 'not_found');
      assertError(await owner.post('/api/users/99999/reset-password', {}), 404, 'not_found');
      // method handling of real routes is unchanged
      assert.equal((await owner.put('/api/me', {})).status, 405);
    });
    it('static files are still served and carry the security headers', async () => {
      for (const path of ['/', '/app.js', '/styles.css']) {
        const res = await fetch(srv.baseUrl + path);
        assert.equal(res.status, 200, path);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
        assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
        assert.equal(res.headers.get('content-security-policy'),
          "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", path);
        await res.arrayBuffer();
      }
    });
  });

  // ------------------------------------------------------------------ storage + leakage
  describe('storage and secrets', () => {
    it('passwords are stored as 64-hex PBKDF2 hashes with unique 32-hex (16-byte) salts, never plaintext', () => {
      const rows = srv.d1('SELECT email, password_hash, password_salt FROM users');
      assert.ok(rows.length >= 5);
      for (const r of rows) {
        assert.match(r.password_hash, /^[0-9a-f]{64}$/);
        assert.match(r.password_salt, /^[0-9a-f]{32}$/);
        assert.notEqual(r.password_hash, srv.owner.password);
      }
      assert.equal(new Set(rows.map((r) => r.password_salt)).size, rows.length, 'salts unique');
      assert.equal(new Set(rows.map((r) => r.password_hash)).size, rows.length, 'hashes unique');
    });
    it('exactly one owner row; emails stored lower-cased', () => {
      const rows = srv.d1('SELECT email, role FROM users');
      assert.equal(rows.filter((r) => r.role === 'owner').length, 1);
      assert.ok(rows.every((r) => r.email === r.email.toLowerCase()));
    });
    it('the database enforces a single owner', () => {
      assert.throws(() => srv.d1("INSERT INTO users (email,name,password_hash,password_salt,role) VALUES ('second-owner-direct@example.com','T','h','s','owner')"));
    });
    it('no response from any endpoint ever contained password_hash or password_salt', () => {
      assert.ok(allBodies.length > 200);
      const offenders = allBodies.filter((b) => /password_hash|password_salt/i.test(b.text));
      assert.deepEqual(offenders.map((b) => `${b.method} ${b.path}`), []);
    });
    it('all 5xx responses: there were none', () => {
      const bad = allBodies.filter((b) => b.status >= 500);
      assert.deepEqual(bad.map((b) => `${b.method} ${b.path} ${b.status} ${b.text}`), []);
    });
    it('every JSON error response has the shape {error, message}', () => {
      for (const b of allBodies) {
        if (b.status < 400 || !b.text.startsWith('{')) continue;
        const j = JSON.parse(b.text);
        assert.equal(typeof j.error, 'string', `${b.method} ${b.path}`);
        assert.equal(typeof j.message, 'string', `${b.method} ${b.path}`);
      }
    });
    it('every JSON API response is no-store', async () => {
      for (const p of ['/api/me', '/api/users', '/api/addresses']) {
        assert.equal((await owner.get(p)).headers.get('cache-control'), 'no-store', p);
      }
    });
  });

  // ------------------------------------------------------------------ last: bootstrap stays once
  describe('owner bootstrap cannot be repeated', () => {
    it('after the owner changes their password, OWNER_PASSWORD no longer logs in and creates nothing', async () => {
      const before = (await owner.get('/api/users')).json.users.length;
      const NEW = 'ChangedOwner-456';
      assert.equal((await owner.post('/api/password', { current_password: srv.owner.password, new_password: NEW })).status, 200);
      assertError(await client('x').login(srv.owner.email, srv.owner.password), 401, 'invalid_credentials');
      assert.equal((await client('x').login(srv.owner.email, NEW)).status, 200);
      assert.equal((await owner.get('/api/users')).json.users.length, before);
      assert.equal(srv.d1("SELECT COUNT(*) AS n FROM users WHERE role='owner'")[0].n, 1);
    });
  });
});
