import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  signSession, verifySession, verifySessionDetailed, getCookie, buildSessionCookie, clearSessionCookie,
  SESSION_MAX_AGE, COOKIE_NAME,
} from '../../functions/_lib/session.js';

const SECRET = 'test-secret-0123456789abcdef';
const NOW = 1_800_000_000;

describe('session', () => {
  test('max age is 30 days', () => assert.equal(SESSION_MAX_AGE, 2592000));
  test('sign then verify returns the user id', async () => {
    const t = await signSession(SECRET, 42, NOW);
    assert.match(t, /^42\.\d+\.[0-9a-f]{64}$/);
    assert.equal(await verifySession(SECRET, t, NOW + 10), 42);
  });
  test('expiry is exactly now + 30 days', async () => {
    const t = await signSession(SECRET, 1, NOW);
    assert.equal(Number(t.split('.')[1]), NOW + SESSION_MAX_AGE);
    assert.equal(await verifySession(SECRET, t, NOW + SESSION_MAX_AGE - 1), 1);
    assert.equal(await verifySession(SECRET, t, NOW + SESSION_MAX_AGE), null);
    assert.equal(await verifySession(SECRET, t, NOW + SESSION_MAX_AGE + 1), null);
  });
  test('wrong secret fails', async () => {
    const t = await signSession(SECRET, 7, NOW);
    assert.equal(await verifySession('another-secret', t, NOW), null);
  });
  test('tampered user id fails', async () => {
    const t = await signSession(SECRET, 7, NOW);
    const [, exp, mac] = t.split('.');
    assert.equal(await verifySession(SECRET, `1.${exp}.${mac}`, NOW), null);
  });
  test('tampered expiry fails', async () => {
    const t = await signSession(SECRET, 7, NOW);
    const [id, exp, mac] = t.split('.');
    assert.equal(await verifySession(SECRET, `${id}.${Number(exp) + 99999}.${mac}`, NOW), null);
  });
  test('tampered / truncated signature fails', async () => {
    const t = await signSession(SECRET, 7, NOW);
    const flipped = t.slice(0, -1) + (t.endsWith('0') ? '1' : '0');
    assert.equal(await verifySession(SECRET, flipped, NOW), null);
    assert.equal(await verifySession(SECRET, t.slice(0, -2), NOW), null);
  });
  test('garbage / missing tokens fail', async () => {
    for (const bad of [null, undefined, '', 'abc', '1.2.3', '..', 'a.b.c', 123]) {
      assert.equal(await verifySession(SECRET, bad, NOW), null, String(bad));
    }
  });
  test('empty secret fails', async () => {
    const t = await signSession(SECRET, 7, NOW);
    assert.equal(await verifySession('', t, NOW), null);
    assert.equal(await verifySession(undefined, t, NOW), null);
  });
  test('negative / signed ids are not accepted', async () => {
    assert.equal(await verifySession(SECRET, `-1.${NOW + 100}.${'0'.repeat(64)}`, NOW), null);
  });
  test('verifySessionDetailed returns userId and expiry (issue time = expiry - max age)', async () => {
    const t = await signSession(SECRET, 42, NOW);
    const v = await verifySessionDetailed(SECRET, t, NOW + 5);
    assert.deepEqual(v, { userId: 42, expiry: NOW + SESSION_MAX_AGE });
    assert.equal(v.expiry - SESSION_MAX_AGE, NOW);
    assert.equal(await verifySessionDetailed(SECRET, t, NOW + SESSION_MAX_AGE), null);
    assert.equal(await verifySessionDetailed('wrong-secret', t, NOW), null);
    assert.equal(await verifySessionDetailed(SECRET, 'junk', NOW), null);
  });
  test('getCookie parses a Cookie header', () => {
    const req = new Request('https://x.test/', { headers: { Cookie: `a=1; ${COOKIE_NAME}=tok.en.val; b=2` } });
    assert.equal(getCookie(req), 'tok.en.val');
    assert.equal(getCookie(new Request('https://x.test/')), null);
    assert.equal(getCookie(new Request('https://x.test/', { headers: { Cookie: 'a=1' } })), null);
  });
  test('cookie attributes are exactly as agreed', () => {
    assert.equal(buildSessionCookie('T'), `${COOKIE_NAME}=T; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
    assert.match(clearSessionCookie(), /^fab_session=; .*Max-Age=0/);
    assert.match(clearSessionCookie(), /Secure; HttpOnly; SameSite=Lax; Path=\//);
  });
});
