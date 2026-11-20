// UI smoke tests: drive the real front end (public/index.html + app.js) in headless Chrome
// via puppeteer-core, against a live `wrangler pages dev` server with a throwaway D1 database.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { startServer } from '../helpers/server.js';
import { Client } from '../helpers/client.js';

const PORT = 8792;
const CHROME = process.env.CHROME_PATH
  || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/pw-browsers/chromium'].find(existsSync);
const MEMBER_NEW_PW = 'UiMemberPass-1';

describe('UI smoke (headless Chrome)', { concurrency: false }, () => {
  let srv, browser, page, api, dlDir, cdp;
  const consoleErrors = [];
  const pageErrors = [];
  const cspViolations = [];
  const EXPECTED_CSP = "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  const requests = [];
  let memberPw; // generated password for the UI-created member
  let firstAddressId;

  // ---------- helpers ----------
  const snapshot = async () => page.evaluate(() => `hash=${location.hash} h1=${document.querySelector('h1')?.textContent} body=${document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)}`).catch(() => '(page gone)');
  const until = async (fn, arg, timeout = 10000) => {
    try { return await page.waitForFunction(fn, { timeout }, arg); } catch (e) {
      throw new Error(`${e.message}\n  waiting for: ${String(fn).slice(0, 160)}\n  page: ${await snapshot()}`);
    }
  };
  const hashIs = (h) => until((x) => location.hash === x, h);
  const text = () => page.evaluate(() => document.body.innerText);
  const h1 = () => page.$eval('h1', (e) => e.textContent).catch(() => null);
  const waitH1 = (t) => until((x) => document.querySelector('h1')?.textContent === x, t);
  async function clickText(selector, label, exact = true) {
    let handle;
    try {
      handle = await page.waitForFunction((s, l, ex) => [...document.querySelectorAll(s)].find((e) => {
        const t = e.textContent.trim();
        return ex ? t === l : t.includes(l);
      }), { timeout: 10000 }, selector, label, exact);
    } catch (e) {
      throw new Error(`${e.message}\n  clickText(${selector}, ${label})\n  page: ${await snapshot()}`);
    }
    await handle.asElement().click();
  }
  async function fill(sel, value) {
    await page.$eval(sel, (e) => { e.value = ''; });
    if (value !== '') await page.type(sel, value);
  }
  async function fillForm(map) { for (const [id, v] of Object.entries(map)) await fill(`#${id}`, v); }
  const goHash = async (h) => { await page.evaluate((x) => { location.hash = x; }, h); };
  async function login(email, password) {
    await waitH1('Family Address Book');
    await fill('#email', email);
    await fill('#password', password);
    await page.click('button[type=submit]');
  }
  const entries = () => page.$$eval('ul.list li', (lis) => lis.map((li) => li.innerText.replace(/\s+/g, ' ').trim()));
  const status = () => page.$eval('p[role=status]', (e) => e.textContent).catch(() => '');
  async function listIs(n) {
    await until((x) => document.querySelector('p[role=status]') && document.querySelector('ul.list') && document.querySelectorAll('ul.list li').length === x, n);
  }
  /** Open the header's More menu (Users, Change password, Export CSV, Log out live there). */
  async function openMore() {
    await page.waitForSelector('#more-btn');
    if (await page.$eval('#more-btn', (b) => b.getAttribute('aria-expanded')) !== 'true') await page.click('#more-btn');
    await until(() => document.getElementById('more-menu') && !document.getElementById('more-menu').hidden);
  }
  async function menuGo(label) { await openMore(); await clickText('#more-menu a, #more-menu button', label); }
  const ADDR = { first_name: 'Test', surname: 'User', address_line1: '1 Example Road', city: 'Exampleville', state: 'Karnataka', pin: '560001', phone: '9876543210' };

  before(async () => {
    assert.ok(CHROME, 'no Chrome/Chromium found (set CHROME_PATH)');
    srv = await startServer({ port: PORT });
    api = new Client(srv.baseUrl, 'seed');
    dlDir = mkdtempSync(join(tmpdir(), 'fab-dl-'));
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    const ctx = browser.defaultBrowserContext();
    await ctx.overridePermissions(srv.baseUrl, ['clipboard-read', 'clipboard-write']);
    cdp = await browser.target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
    page = await browser.newPage();
    await page.setViewport({ width: 390, height: 800 });
    // Record CSP violations from both the console (any level) and the DOM event.
    await page.evaluateOnNewDocument(() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    page.on('console', (m) => { if (/Content[- ]Security[- ]Policy|Refused to/i.test(m.text())) cspViolations.push(m.text()); });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
    });
    page.on('request', (r) => requests.push(`${r.method()} ${new URL(r.url()).pathname}`));
  });

  after(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    if (srv) await srv.stop();
    if (dlDir) rmSync(dlDir, { recursive: true, force: true });
  });

  // ---------- login ----------
  it('loads the app and shows the login view when logged out (no nav)', async () => {
    const resp = await page.goto(`${srv.baseUrl}/`);
    assert.equal(resp.headers()['content-security-policy'], EXPECTED_CSP);
    assert.equal(resp.headers()['x-content-type-options'], 'nosniff');
    assert.equal(resp.headers()['referrer-policy'], 'no-referrer');
    await waitH1('Family Address Book');
    assert.ok(await page.$('#email'));
    assert.ok(await page.$('#password'));
    assert.equal(await page.$eval('#top', (e) => e.hidden), true);
    assert.equal(await page.evaluate(() => typeof window.jspdf?.jsPDF), 'function', 'jsPDF loaded');
    assert.equal(await page.evaluate(() => location.hash), '#/login');
  });

  it('wrong password shows a generic error and stays on login', async () => {
    await login(srv.owner.email, 'definitely-wrong');
    await until(() => document.querySelector('p.error')?.textContent === 'Incorrect email or password.');
    assert.equal(await h1(), 'Family Address Book');
  });

  it('empty fields show a client-side message without calling the API', async () => {
    const before = requests.filter((r) => r === 'POST /api/login').length;
    await fill('#email', ''); await fill('#password', '');
    await page.click('button[type=submit]');
    await until(() => document.querySelector('p.error')?.textContent === 'Enter your email and password.');
    assert.equal(requests.filter((r) => r === 'POST /api/login').length, before);
  });

  it('owner logs in (bootstrap) and sees the empty address list and nav', async () => {
    await login(srv.owner.email, srv.owner.password);
    await waitH1('Addresses');
    assert.equal(await page.$eval('#top', (e) => e.hidden), false);
    await until(() => document.querySelector('p[role=status]')?.textContent === 'No addresses yet.');
    // empty state invites the first entry
    assert.match(await page.$eval('.empty', (e) => e.innerText), /Add the first address/);
    assert.equal(await page.$eval('.empty a', (a) => a.getAttribute('href')), '#/new');
    // primary navigation is always visible; the rest is under "More"
    const primary = await page.$$eval('#top nav[aria-label=Main] a', (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(primary, ['Addresses', 'Add', 'Labels']);
    assert.equal(await page.$eval('#top a.tab.current', (a) => a.getAttribute('aria-current')), 'page');
    assert.equal(await page.$eval('#more-menu', (e) => e.hidden), true, 'More menu starts closed');
    await openMore();
    assert.match(await text(), /Signed in as Owner \(owner\)/);
    const more = await page.$$eval('#more-menu a, #more-menu button', (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(more, ['Users', 'Change password', 'Export CSV', 'Export to Excel (.xlsx)', 'Log out']);
    assert.equal(await page.$eval('#more-menu a[download]', (a) => a.getAttribute('href')), '/api/export.csv');
    await page.keyboard.press('Escape');
    await until(() => document.getElementById('more-menu').hidden);
  });

  it('reloading the page keeps the session (cookie accepted by the browser)', async () => {
    await page.reload();
    await waitH1('Addresses');
    await openMore();
    assert.match(await text(), /Signed in as Owner/);
    await page.keyboard.press('Escape');
  });

  it('More menu opens and closes by click and by keyboard (no hover needed)', async () => {
    const st = () => page.evaluate(() => ({
      expanded: document.getElementById('more-btn').getAttribute('aria-expanded'),
      hidden: document.getElementById('more-menu').hidden,
      focus: document.activeElement?.id || document.activeElement?.textContent.trim(),
    }));
    assert.equal(await page.$eval('#more-btn', (b) => b.getAttribute('aria-controls')), 'more-menu');
    assert.deepEqual(await st().then((s) => [s.expanded, s.hidden]), ['false', true]);
    // click toggles
    await page.click('#more-btn');
    assert.deepEqual(await st().then((s) => [s.expanded, s.hidden]), ['true', false]);
    await page.click('#more-btn');
    assert.deepEqual(await st().then((s) => [s.expanded, s.hidden]), ['false', true]);
    // click outside closes
    await page.click('#more-btn');
    await page.click('h1');
    assert.deepEqual(await st().then((s) => [s.expanded, s.hidden]), ['false', true]);
    // keyboard: Enter opens, Escape closes and returns focus to the button
    await page.focus('#more-btn');
    await page.keyboard.press('Enter');
    assert.deepEqual(await st().then((s) => [s.expanded, s.hidden]), ['true', false]);
    await page.keyboard.press('Escape');
    assert.deepEqual(await st(), { expanded: 'false', hidden: true, focus: 'more-btn' });
    // ArrowDown opens and focuses the first item; Tab moves through the items; tabbing out closes
    await page.keyboard.press('ArrowDown');
    assert.deepEqual(await st(), { expanded: 'true', hidden: false, focus: 'Users' });
    for (const next of ['Change password', 'Export CSV', 'Export to Excel (.xlsx)', 'Log out']) {
      await page.keyboard.press('Tab');
      assert.equal((await st()).focus, next);
    }
    await page.keyboard.press('Tab');
    await until(() => document.getElementById('more-menu').hidden);
    assert.equal((await st()).expanded, 'false');
    // Enter on an item follows it
    await page.focus('#more-btn');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await waitH1('Change password');
    assert.equal(await page.$eval('#more-menu', (e) => e.hidden), true);
    assert.equal(await page.$eval('#more-btn', (b) => b.classList.contains('current')), true, 'More marks itself as the current section');
    await clickText('#top a', 'Addresses');
    await waitH1('Addresses');
  });

  // ---------- add ----------
  it('client-side validation: bad PIN (and other fields) show errors and nothing is sent', async () => {
    await clickText('a', 'Add address');
    await waitH1('Add address');
    await fillForm({ ...ADDR, pin: '12345', phone: '12345' });
    const before = requests.filter((r) => r === 'POST /api/addresses').length;
    await page.click('#save-btn');
    await until(() => document.getElementById('pin-err')?.textContent.length > 0);
    assert.equal(await page.$eval('#pin-err', (e) => e.textContent), 'PIN must be exactly 6 digits.');
    assert.match(await page.$eval('#phone-err', (e) => e.textContent), /Phone must be 10 digits/);
    assert.equal(await page.$eval('#pin', (e) => e.getAttribute('aria-invalid')), 'true');
    assert.equal(await page.$eval('#pin', (e) => e === document.activeElement), true, 'focus moves to the first invalid field (PIN)');
    assert.equal(requests.filter((r) => r === 'POST /api/addresses').length, before, 'no request was sent');
    assert.equal(await page.evaluate(() => location.hash), '#/new');
  });

  it('client-side validation: required fields reported when empty', async () => {
    await fillForm({ first_name: '', address_line1: '', city: '', state: '', pin: '', phone: '' });
    await page.click('#save-btn');
    await until(() => document.getElementById('first_name-err')?.textContent.length > 0);
    for (const f of ['first_name', 'address_line1', 'city', 'state', 'pin', 'phone']) {
      assert.match(await page.$eval(`#${f}-err`, (e) => e.textContent), /required|must be/, f);
    }
  });

  it('adding a valid address through the form returns to the list and shows it', async () => {
    await fillForm({ ...ADDR, phone: '+91 98765 43210', group_name: 'Family' });
    await page.click('#save-btn');
    await waitH1('Addresses');
    await listIs(1);
    const [row] = await entries();
    assert.match(row, /Test User/);
    assert.match(row, /9876543210/, 'phone shown normalised');
    assert.match(row, /Exampleville 560001/);
    assert.match(row, /Family/);
    assert.match(row, /Added by Owner/);
    assert.equal(await status(), '1 address');
    firstAddressId = await page.$eval('ul.list li a.entry', (a) => a.getAttribute('href').split('/').pop());
  });

  it('duplicate phone: warning with the existing entry, then "Save anyway" saves', async () => {
    await clickText('a', 'Add address');
    await waitH1('Add address');
    await fillForm({ ...ADDR, first_name: 'Second', surname: 'Person', phone: '09876543210' });
    await page.click('#save-btn');
    await until(() => document.querySelector('.warn'));
    const warn = await page.$eval('.warn', (e) => e.innerText);
    assert.match(warn, /This phone number is already in the address book\./);
    assert.match(warn, /Test User, Exampleville \(9876543210\)/);
    assert.equal(await page.evaluate(() => location.hash), '#/new', 'did not save yet');
    const viewLink = await page.$eval('.warn a', (a) => a.getAttribute('href'));
    assert.equal(viewLink, `#/edit/${firstAddressId}`);
    assert.equal(await page.$eval('#save-btn', (b) => b.disabled), false, 'form usable again');
    await clickText('.warn button', 'Save anyway');
    await waitH1('Addresses');
    await listIs(2);
    assert.match((await entries()).join('|'), /Second Person/);
  });

  it('"Go back and edit" dismisses the duplicate warning', async () => {
    await clickText('a', 'Add address');
    await waitH1('Add address');
    await fillForm({ ...ADDR, first_name: 'Third', phone: '9876543210' });
    await page.click('#save-btn');
    await until(() => document.querySelector('.warn'));
    await clickText('.warn button', 'Go back and edit');
    await until(() => !document.querySelector('.warn'));
    assert.equal(await page.$eval('#first_name', (e) => e.value), 'Third');
    await clickText('a', 'Cancel');
    await waitH1('Addresses');
    await listIs(2);
  });

  // ---------- search / edit ----------
  it('search filters the list as you type (name, city, PIN, phone) and clears again', async () => {
    await api.login(srv.owner.email, srv.owner.password);
    const r = await api.post('/api/addresses', { ...ADDR, first_name: 'Zetaxq', surname: 'Findable', city: 'Searchtown', pin: '560777', phone: '9300000003' });
    assert.equal(r.status, 201, r.text);
    await page.reload();
    await waitH1('Addresses');
    await listIs(3);
    await page.type('#q', 'zetaxq');
    await listIs(1);
    assert.match((await entries())[0], /Zetaxq Findable/);
    await fill('#q', ''); await page.type('#q', 'searchtown');
    await listIs(1);
    await fill('#q', ''); await page.type('#q', '560777');
    await listIs(1);
    await fill('#q', ''); await page.type('#q', '9300000');
    await listIs(1);
    await fill('#q', ''); await page.type('#q', 'nothingmatchesthis');
    await listIs(0);
    assert.equal(await status(), 'No addresses match your search.');
    assert.ok(await page.$eval('.empty', (e) => !e.hidden && e.innerText.includes('Clear search')), 'no-results state offers Clear search');
    await fill('#q', ''); await page.type('#q', 'Example');
    await listIs(2);
    await fill('#q', '');
    await page.type('#q', ' ');
    await listIs(3);
    await fill('#q', '');
  });

  it('group filter lists groups and filters', async () => {
    const opts = await page.$$eval('#group option', (o) => o.map((x) => x.textContent));
    assert.deepEqual(opts, ['All groups', 'Family']);
    await page.select('#group', 'Family');
    await listIs(1);
    await page.select('#group', '');
    await listIs(3);
  });

  it('clicking an entry opens the edit form prefilled; saving shows the change in the list', async () => {
    await clickText('ul.list a.entry', 'Test User', false);
    await waitH1('Edit address');
    assert.equal(await page.$eval('#first_name', (e) => e.value), 'Test');
    assert.equal(await page.$eval('#phone', (e) => e.value), '9876543210');
    assert.equal(await page.$eval('#group_name', (e) => e.value), 'Family');
    assert.match(await text(), /Added by Owner/);
    await fill('#city', 'Changedville');
    await fill('#notes', 'Some note');
    await page.click('#save-btn');
    // "Second Person" was knowingly saved with the same phone, so editing Test User re-triggers the duplicate warning.
    await until(() => document.querySelector('.warn'));
    assert.match(await page.$eval('.warn', (e) => e.innerText), /Second Person, Exampleville \(9876543210\)/);
    await clickText('.warn button', 'Save anyway');
    await waitH1('Addresses');
    await listIs(3);
    assert.match((await entries()).join('|'), /Changedville 560001/);
    // and persisted on the server
    const one = await api.get(`/api/addresses/${firstAddressId}`);
    assert.equal(one.json.address.city, 'Changedville');
    assert.equal(one.json.address.notes, 'Some note');
  });

  // ---------- delete ----------
  it('owner delete uses an in-page confirmation; cancel keeps the entry, confirm removes it', async () => {
    await clickText('ul.list a.entry', 'Second Person', false);
    await waitH1('Edit address');
    assert.match(await text(), /Owner actions/);
    await clickText('button', 'Delete this address...');
    await until(() => document.body.innerText.includes('Delete this address? It will be removed from the list.'));
    await clickText('button', 'Cancel');
    await until(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Delete this address...'));
    assert.equal(await page.evaluate(() => location.hash).then((h) => h.startsWith('#/edit/')), true);
    await clickText('button', 'Delete this address...');
    await clickText('button', 'Yes, delete');
    await waitH1('Addresses');
    await listIs(2);
    assert.doesNotMatch((await entries()).join('|'), /Second Person/);
  });

  // ---------- users ----------
  it('users view lists the owner; adding a co-user shows the one-time password', async () => {
    await menuGo('Users');
    await waitH1('Users');
    await until(() => document.querySelectorAll('li.user').length === 1);
    assert.match(await page.$eval('li.user', (e) => e.innerText), /Owner[\s\S]*owner/);
    // client-side validation
    await fill('#name', 'Test Member'); await fill('#new_email', 'not-an-email');
    await clickText('button', 'Add user');
    await until(() => document.getElementById('new_email-err')?.textContent.length > 0);
    assert.equal(await page.$eval('#new_email-err', (e) => e.textContent), 'A valid email is required.');
    // real add
    await fill('#new_email', 'UI-Member@Example.com');
    await clickText('button', 'Add user');
    await until(() => document.getElementById('secret-pw'));
    memberPw = await page.$eval('#secret-pw', (e) => e.value);
    assert.match(memberPw, /^[A-HJ-NP-Za-km-np-z2-9]{12}$/);
    assert.match(await page.$eval('.secret', (e) => e.innerText), /This will not be shown again\./);
    assert.match(await page.$eval('.secret', (e) => e.innerText), /ui-member@example\.com/);
    await until(() => document.querySelectorAll('li.user').length === 2);
    const rows = await page.$$eval('li.user', (l) => l.map((e) => e.innerText.replace(/\s+/g, ' ')));
    assert.match(rows[1], /Test Member/);
    assert.match(rows[1], /password change pending/);
  });

  it('copy password button copies to the clipboard (headless Chrome with clipboard permission)', async () => {
    await clickText('.secret button', 'Copy password');
    await until(() => document.querySelector('.secret [role=status]')?.textContent.length > 0);
    const msg = await page.$eval('.secret [role=status]', (e) => e.textContent);
    assert.equal(msg, 'Copied.');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(clip, memberPw);
  });

  it('"I have saved it" hides the password', async () => {
    await clickText('.secret button', 'I have saved it');
    await until(() => !document.getElementById('secret-pw'));
  });

  it('disable and enable a user from the UI; owner row has no disable button', async () => {
    const ownerBtns = await page.$eval('li.user:nth-child(1)', (li) => [...li.querySelectorAll('button')].map((b) => b.textContent));
    assert.deepEqual(ownerBtns, ['Reset password...']);
    await clickText('li.user:nth-child(2) button', 'Disable');
    await until(() => document.querySelector('li.user:nth-child(2) .tag.off'));
    assert.ok(await page.$eval('li.user:nth-child(2)', (li) => [...li.querySelectorAll('button')].some((b) => b.textContent === 'Enable')));
    // the server agrees: login is refused
    const c = new Client(srv.baseUrl, 'disabled-check');
    assert.equal((await c.login('ui-member@example.com', memberPw)).status, 401);
    await clickText('li.user:nth-child(2) button', 'Enable');
    await until(() => !document.querySelector('li.user:nth-child(2) .tag.off'));
    assert.equal((await c.login('ui-member@example.com', memberPw)).status, 200);
  });

  it('reset password asks for confirmation, then shows a new one-time password that works', async () => {
    await clickText('li.user:nth-child(2) button', 'Reset password...');
    await until(() => document.body.innerText.includes('Their current password stops working.'));
    await clickText('li.user:nth-child(2) button', 'Cancel');
    await until(() => !document.body.innerText.includes('Their current password stops working.'));
    await clickText('li.user:nth-child(2) button', 'Reset password...');
    await clickText('li.user:nth-child(2) button', 'Yes, reset');
    await until(() => document.getElementById('secret-pw'));
    const fresh = await page.$eval('#secret-pw', (e) => e.value);
    assert.notEqual(fresh, memberPw);
    assert.match(await page.$eval('.secret h2', (e) => e.textContent), /New password/);
    const c = new Client(srv.baseUrl, 'reset-check');
    assert.equal((await c.login('ui-member@example.com', memberPw)).status, 401);
    assert.equal((await c.login('ui-member@example.com', fresh)).status, 200);
    memberPw = fresh;
  });

  // ---------- logout / member ----------
  it('logout returns to the login view and hides the nav', async () => {
    await menuGo('Log out');
    await waitH1('Family Address Book');
    assert.equal(await page.$eval('#top', (e) => e.hidden), true);
    // going to a protected route now bounces to login
    await goHash('#/users');
    await waitH1('Family Address Book');
    assert.equal((await page.cookies()).find((c) => c.name === 'fab_session'), undefined, 'cookie cleared');
  });

  it('member logs in and is forced to the change-password view (no nav, cannot navigate away)', async () => {
    await login('ui-member@example.com', memberPw);
    await waitH1('Change password');
    assert.match(await text(), /Please choose your own password before continuing\./);
    assert.equal(await page.$eval('#top', (e) => e.hidden), true);
    await goHash('#/');
    await waitH1('Change password');
    await goHash('#/users');
    await waitH1('Change password');
  });

  it('change-password validation: mismatch, too short, same as current', async () => {
    await fillForm({ current_password: memberPw, new_password: 'short', confirm_password: 'short' });
    await page.click('button[type=submit]');
    await until(() => document.getElementById('new_password-err')?.textContent.length > 0);
    assert.equal(await page.$eval('#new_password-err', (e) => e.textContent), 'Password must be at least 8 characters.');
    await fillForm({ new_password: MEMBER_NEW_PW, confirm_password: 'different-1' });
    await page.click('button[type=submit]');
    await until(() => document.getElementById('confirm_password-err')?.textContent === 'Passwords do not match.');
    await fillForm({ current_password: 'wrong-current-pw', new_password: MEMBER_NEW_PW, confirm_password: MEMBER_NEW_PW });
    await page.click('button[type=submit]');
    await until(() => document.querySelector('p.error')?.textContent === 'Current password is incorrect.');
  });

  it('after a valid change the member lands on the list with the nav; the new password works', async () => {
    await fillForm({ current_password: memberPw, new_password: MEMBER_NEW_PW, confirm_password: MEMBER_NEW_PW });
    await page.click('button[type=submit]');
    await waitH1('Addresses');
    assert.equal(await page.$eval('#top', (e) => e.hidden), false);
    await openMore();
    assert.match(await text(), /Signed in as Test Member/);
    assert.doesNotMatch(await text(), /\(owner\)/);
    await page.keyboard.press('Escape');
    assert.equal((await new Client(srv.baseUrl, 'x').login('ui-member@example.com', MEMBER_NEW_PW)).status, 200);
  });

  it('member sees no delete button on the edit page, but can edit', async () => {
    await listIs(2);
    await clickText('ul.list a.entry', 'Zetaxq', false);
    await waitH1('Edit address');
    const buttons = await page.$$eval('button', (b) => b.map((x) => x.textContent));
    assert.ok(!buttons.some((t) => /delete/i.test(t)), `buttons: ${buttons}`);
    assert.doesNotMatch(await text(), /Owner actions/);
    await fill('#landmark', 'Edited by member');
    await page.click('#save-btn');
    await waitH1('Addresses');
    const got = await api.get('/api/addresses?q=Zetaxq');
    assert.equal(got.json.addresses[0].landmark, 'Edited by member');
    assert.equal(got.json.addresses[0].updated_by_name ?? 'n/a', 'n/a');
    assert.equal(got.json.addresses[0].updated_by, 2);
  });

  it('member sees the users list without disable/reset buttons, and can add a co-user', async () => {
    await menuGo('Users');
    await waitH1('Users');
    await until(() => document.querySelectorAll('li.user').length === 2);
    assert.equal(await page.$$eval('li.user button', (b) => b.length), 0);
    assert.equal(await page.$$eval('li.user .owner-actions', (b) => b.length), 0, 'no owner-actions area for members');
    await fill('#name', 'Test Added By Member'); await fill('#new_email', 'by-member@example.com');
    await clickText('button', 'Add user');
    await until(() => document.getElementById('secret-pw'));
    assert.match(await page.$eval('#secret-pw', (e) => e.value), /^.{12}$/);
    await until(() => document.querySelectorAll('li.user').length === 3);
  });

  // ---------- labels / PDF ----------
  describe('labels', () => {
    const MM = 25.4 / 72;
    const pdfFiles = () => readdirSync(dlDir).filter((f) => f.endsWith('.pdf')).sort();
    /** Parse a downloaded jsPDF file (uncompressed): page count and, per page, the text runs with x in mm and raw y in pt. */
    function parsePdf(file) {
      const raw = readFileSync(join(dlDir, file), 'latin1');
      const pages = (raw.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
      const streams = [...raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)].map((m) => m[1]).filter((x) => x.includes(' Td'));
      const texts = streams.map((st) => [...st.matchAll(/([\d.\-]+) ([\d.\-]+) Td\s*\(((?:\\.|[^\\)])*)\) Tj/g)]
        .map((m) => ({ xmm: Number(m[1]) * MM, ypt: Number(m[2]), t: m[3].replace(/\\([()\\])/g, '$1') })));
      return { bytes: raw, pages, texts };
    }
    // Where jsPDF itself puts an 11 pt bold line drawn with baseline:'top' at (x mm, y mm) - independent of app code.
    async function expectedYpt(ymm, size = 11) {
      const { jsPDF } = await import('jspdf');
      const d = new jsPDF({ unit: 'mm', format: 'a4' });
      d.setFont('helvetica', 'bold'); d.setFontSize(size);
      d.text('X', 0, ymm, { baseline: 'top' });
      return Number(/([\d.\-]+) ([\d.\-]+) Td/.exec(d.output())[2]);
    }
    /** Click "Download PDF", wait for the success notice and for the real download to land. Returns the parsed PDF. */
    async function generate() {
      for (const f of pdfFiles()) rmSync(join(dlDir, f));
      await page.click('form button[type=submit]');
      await until(() => document.querySelector('.notice[role=status]') || document.querySelector('p.error'));
      const err = await page.$eval('p.error', (e) => e.textContent).catch(() => null);
      if (err) throw new Error(`label generation showed an error: ${err}`);
      for (let i = 0; i < 100; i++) {
        const f = pdfFiles();
        if (f.length) {
          await new Promise((r) => setTimeout(r, 300)); // let the download finish writing
          return parsePdf(f[0]);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`no PDF arrived in the download folder; files: ${readdirSync(dlDir)}`);
    }
    const notice = () => page.$eval('.notice[role=status]', (e) => e.textContent);
    // The screen's default layout is now 12-up; the older tests below were written for L7160, so they pick it explicitly.
    const openLabels = async (layout = 'l7160') => {
      await clickText('#top a', 'Labels'); await waitH1('Print labels');
      if (layout && await page.$eval('#layout', (e) => e.value) !== layout) await page.select('#layout', layout);
    };
    const backToList = async () => { await clickText('#top a', 'Addresses'); await waitH1('Addresses'); };
    const near = (a, b, tol = 0.01) => Math.abs(a - b) < tol;
    const allTexts = (pdf) => pdf.texts.flat();

    before(async () => {
      // 24 bulk addresses in group "Bulk" -> 24 labels = 2 sheets
      for (let i = 1; i <= 24; i++) {
        const r = await api.post('/api/addresses', { ...ADDR, first_name: `Bulk${String(i).padStart(2, '0')}`, surname: 'Label', group_name: 'Bulk', phone: String(9400000000 + i) });
        assert.equal(r.status, 201, r.text);
      }
      await goHash('#/');
      await page.reload();
      await waitH1('Addresses');
      await until(() => document.querySelector('#group option[value=Bulk]'));
    });

    it('with nothing remembered the Labels view starts on 12 per sheet, 2 x 6, 99.1 x 42.3 mm (listed first); 21-up stays available', async () => {
      await clickText('#top a', 'Labels');
      await waitH1('Print labels');
      assert.equal(await page.evaluate(() => localStorage.getItem('fab.labelLayout')), null, 'nothing stored yet');
      assert.equal(await page.$eval('#layout', (e) => e.value), 'l7177');
      const opts = await page.$$eval('#layout option', (o) => o.map((x) => [x.value, x.textContent]));
      assert.deepEqual(opts[0], ['l7177', '12 per sheet, 2 \u00d7 6, 99.1 \u00d7 42.3 mm (L7177)']);
      assert.deepEqual(opts.map((o) => o[0]), ['l7177', 'l7160', 'l7164', 'w105x48', 'w105x49', 'w100x44', 'custom']);
      assert.ok(opts.some(([v, t]) => v === 'l7160' && t === '21 per sheet, 3 \u00d7 7, 63.5 \u00d7 38.1 mm (L7160)'));
      assert.equal(await page.$$eval('.sheet .slot', (s) => s.length), 12);
      assert.equal(await page.$eval('#start_at', (e) => e.max), '12');
      assert.equal(await page.$eval('label[for=layout]', (e) => e.textContent), 'Sheet layout');
      await backToList();
      await until(() => document.querySelector('#group option[value=Bulk]'));
    });

    it('a 9-entry search: real PDF downloaded, 1 page, labels on the L7160 grid, PIN on its own line', async () => {
      await page.select('#group', 'Bulk');
      await listIs(24);
      await fill('#q', '');
      await page.type('#q', 'Bulk0');
      await listIs(9);
      await openLabels();
      assert.match(await text(), /Current search\/filter \(9\)/);
      const pdf = await generate();
      assert.equal(await notice(), 'Created address-labels.pdf: 9 labels on 1 sheet.');
      assert.equal(pdf.bytes.slice(0, 5), '%PDF-');
      assert.equal(pdf.pages, 1);
      const names = pdf.texts[0].filter((x) => /^Bulk0\d Label$/.test(x.t));
      assert.equal(names.length, 9);
      assert.deepEqual(names.map((n) => n.t), Array.from({ length: 9 }, (_, i) => `Bulk0${i + 1} Label`));
      const y0 = await expectedYpt(15.15 + 3);
      assert.ok(near(names[0].xmm, 7.25 + 3), `x of first label ${names[0].xmm}`);
      assert.ok(near(names[0].ypt, y0, 0.001), `y of first label ${names[0].ypt} vs ${y0}`);
      assert.ok(near(names[1].xmm, 7.25 + 66 + 3) && near(names[2].xmm, 7.25 + 132 + 3), 'columns 66 mm apart');
      assert.ok(near(names[3].xmm, 7.25 + 3), 'label 4 starts row 2');
      assert.ok(near(names[0].ypt - names[3].ypt, 38.1 / MM, 0.001), 'rows 38.1 mm apart');
      assert.equal(pdf.texts[0].filter((x) => x.t === 'PIN: 560001').length, 9);
      assert.ok(!allTexts(pdf).some((x) => x.t.startsWith('Ph:')), 'phone not included by default');
    });

    it('include phone adds a phone line', async () => {
      await page.click('#include_phone');
      const pdf = await generate();
      assert.equal(allTexts(pdf).filter((x) => /^Ph: 94000000\d\d$/.test(x.t)).length, 9);
      await page.click('#include_phone');
    });

    it('start at 20 with 9 labels: labels 1-2 fill slots 20-21 of sheet 1, the other 7 go to sheet 2 (2-page PDF)', async () => {
      await fill('#start_at', '20');
      const pdf = await generate();
      assert.match(await notice(), /9 labels on 2 sheets\./);
      assert.equal(pdf.pages, 2);
      const p1 = pdf.texts[0].filter((x) => /^Bulk0\d Label$/.test(x.t));
      const p2 = pdf.texts[1].filter((x) => /^Bulk0\d Label$/.test(x.t));
      // slots 20 and 21 remain on sheet 1; the other 7 labels go to sheet 2
      assert.deepEqual(p1.map((x) => x.t), ['Bulk01 Label', 'Bulk02 Label']);
      assert.deepEqual(p2.map((x) => x.t), Array.from({ length: 7 }, (_, i) => `Bulk0${i + 3} Label`));
      assert.ok(near(p1[0].xmm, 7.25 + 66 + 3), `slot 20 is column 2: x=${p1[0].xmm}`);
      assert.ok(near(p1[0].ypt, await expectedYpt(15.15 + 6 * 38.1 + 3), 0.001), 'slot 20 is row 7');
      assert.ok(near(p1[1].xmm, 7.25 + 132 + 3) && near(p1[1].ypt, p1[0].ypt, 0.001), 'slot 21 is column 3, same row');
      assert.ok(near(p2[0].xmm, 7.25 + 3) && near(p2[0].ypt, await expectedYpt(15.15 + 3), 0.001), 'sheet 2 starts at slot 1');
    });

    it('start-at validation: 0, 22, text and decimals are rejected with a message; no PDF is produced', async () => {
      for (const f of pdfFiles()) rmSync(join(dlDir, f));
      for (const bad of ['0', '22', 'abc', '1.5']) {
        await fill('#start_at', bad);
        await page.evaluate(() => { document.querySelector('form').querySelector('p.error')?.remove(); });
        await page.click('form button[type=submit]');
        await until(() => document.querySelector('p.error')?.textContent.includes('Start label must be a whole number from 1 to 21.'));
      }
      await new Promise((r) => setTimeout(r, 500));
      assert.deepEqual(pdfFiles(), []);
      await fill('#start_at', '1');
    });

    it('the on-screen sheet preview marks the slots that will be filled for a given start position', async () => {
      // u = left blank (already used), F = will be printed, . = stays empty
      const marks = () => page.$$eval('.sheet .slot', (s) => s.map((e) => (e.classList.contains('is-filled') ? 'F' : e.classList.contains('is-used') ? 'u' : '.')).join(''));
      const note = () => page.$eval('#sheet-note', (e) => e.textContent);
      assert.equal(await page.$$eval('.sheet .slot', (s) => s.length), 21);
      assert.equal(await page.$eval('.sheet', (e) => e.getAttribute('aria-hidden')), 'true', 'picture is decorative; the note carries the information');
      assert.equal(await marks(), `${'F'.repeat(9)}${'.'.repeat(12)}`);
      await fill('#start_at', '20');
      assert.equal(await marks(), `${'u'.repeat(19)}FF`);
      assert.deepEqual(await page.$$eval('.sheet .slot.is-filled', (s) => s.map((e) => [e.dataset.slot, e.querySelector('.slot-name').textContent])),
        [['20', 'Bulk01 Label'], ['21', 'Bulk02 Label']], 'same slots as the PDF test above');
      assert.equal(await note(), 'Sheet 1: labels 20 to 21 will be printed. Labels 1 to 19 stay blank. 7 more labels go on sheet 2.');
      await fill('#start_at', '5');
      assert.equal(await marks(), `uuuu${'F'.repeat(9)}${'.'.repeat(8)}`);
      // tapping a slot on the picture sets the start position
      await page.click('.sheet .slot[data-slot="10"]');
      assert.equal(await page.$eval('#start_at', (e) => e.value), '10');
      assert.equal(await marks(), `${'u'.repeat(9)}${'F'.repeat(9)}...`);
      // invalid input: nothing marked, and the note says what to enter
      await fill('#start_at', '0');
      assert.equal(await marks(), '.'.repeat(21));
      assert.match(await note(), /Enter a label number from 1 to 21/);
      await fill('#start_at', '1');
    });

    it('the whole 24-entry group: 24 labels on a 2-page PDF (21 + 3)', async () => {
      await backToList();
      await until(() => document.querySelector('#group option[value=Bulk]'));
      await page.select('#group', 'Bulk');
      await fill('#q', '');
      await page.type('#q', ' ');
      await listIs(24);
      await openLabels();
      assert.match(await text(), /Current search\/filter \(24\)/);
      const pdf = await generate();
      assert.match(await notice(), /24 labels on 2 sheets\./);
      assert.equal(pdf.pages, 2);
      assert.equal(pdf.texts[0].filter((x) => /Label$/.test(x.t)).length, 21);
      assert.equal(pdf.texts[1].filter((x) => /Label$/.test(x.t)).length, 3);
      if (process.env.UI_SCREENSHOTS) writeFileSync(join(process.env.UI_SCREENSHOTS, 'labels-24.pdf'), pdf.bytes, 'latin1');
    });

    it('ticked entries only: 2 ticked -> 2 labels; nothing ticked -> message', async () => {
      await backToList();
      await listIs(24);
      assert.equal(await page.$eval('.selbar', (e) => e.hidden), true, 'no selection bar while nothing is selected');
      await page.click('input[aria-label="Select Bulk03 Label"]');
      await page.click('input[aria-label="Select Bulk05 Label"]');
      await until(() => document.body.innerText.includes('2 selected'));
      // the sticky bar appears, sits at the bottom of the viewport, and leads to the labels view
      await until(() => document.querySelector('.selbar').getAnimations().every((x) => x.playState === 'finished'));
      const bar = await page.$eval('.selbar', (e) => ({ hidden: e.hidden, pos: getComputedStyle(e).position, bottom: Math.round(e.getBoundingClientRect().bottom), vh: innerHeight, text: e.innerText.replace(/\s+/g, ' ').trim() }));
      assert.equal(bar.hidden, false);
      assert.equal(bar.pos, 'fixed');
      assert.equal(bar.bottom, bar.vh);
      assert.match(bar.text, /^2 selected Clear Print labels$/);
      assert.equal(await page.$$eval('li.entry-card.is-selected', (l) => l.length), 2, 'selected rows are highlighted');
      await clickText('.selbar a', 'Print labels');
      await waitH1('Print labels');
      assert.match(await text(), /Only selected addresses \(2\)/);
      assert.equal(await page.$eval('#mode-ticked', (e) => e.checked), true, 'selected addresses are preselected when there is a selection');
      await page.click('#mode-ticked');
      const pdf = await generate();
      assert.match(await notice(), /2 labels on 1 sheet\./);
      assert.equal(pdf.pages, 1);
      assert.deepEqual(allTexts(pdf).filter((t) => t.t.startsWith('Bulk')).map((t) => t.t), ['Bulk03 Label', 'Bulk05 Label']);
      await backToList();
      // "Select all shown" selects every listed entry; "Clear" in the bar empties the selection and hides the bar
      await clickText('button', 'Select all shown');
      await until(() => document.querySelector('.sel-count')?.textContent === '24 selected');
      await clickText('.selbar button', 'Clear');
      await until(() => document.querySelector('.selbar').hidden);
      assert.equal(await page.$$eval('ul.list input[type=checkbox]:checked', (l) => l.length), 0);
      await openLabels();
      assert.equal(await page.$eval('#mode-filter', (e) => e.checked), true);
      await page.click('#mode-ticked');
      await page.click('form button[type=submit]');
      await until(() => document.querySelector('p.error')?.textContent === 'No addresses are selected.');
    });

    // ---------- label layouts ----------
    const rectsOf = (pdf) => [...pdf.bytes.matchAll(/stream\r?\n([\s\S]*?)endstream/g)].map((m) => m[1]).filter((x) => x.includes(' Td') || / re\r?\nS/.test(x))
      .map((st) => [...st.matchAll(/([\d.\-]+) ([\d.\-]+) ([\d.\-]+) ([\d.\-]+) re\r?\nS/g)]
        .map((m) => ({ x: Number(m[1]) * MM, y: 297 - Number(m[2]) * MM, w: Number(m[3]) * MM, h: -Number(m[4]) * MM })));
    const clearField = (sel) => page.$eval(sel, (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
    const mmY = (ypt) => 297 - ypt * MM;
    const setLayout = async (id) => { if (await page.$eval('#layout', (e) => e.value) !== id) await page.select('#layout', id); };
    const sheetGeometry = () => page.$eval('.sheet', (sh) => {
      const sr = sh.getBoundingClientRect();
      const slots = [...sh.querySelectorAll('.slot')].map((e) => e.getBoundingClientRect());
      const uniq = (a) => [...new Set(a.map((v) => Math.round(v)))];
      return { n: slots.length, cols: uniq(slots.map((r) => r.left)).length, rows: uniq(slots.map((r) => r.top)).length, sw: sr.width, sh: sr.height, w: slots[0]?.width, h: slots[0]?.height, dc: sh.dataset.cols, dr: sh.dataset.rows,
        inside: slots.every((r) => r.left >= sr.left - 1 && r.right <= sr.right + 1 && r.top >= sr.top - 1 && r.bottom <= sr.bottom + 1) };
    });

    it('12-per-sheet 2 x 6 (99.1 x 42.3): preview redraws, start-at is limited to 12, 13 addresses make a 2-page PDF with text inside the label rectangles', async () => {
      const { presetById, labelRect: lr } = await import('../../public/labels.js');
      const L = presetById('l7177');
      await backToList();
      await listIs(24);
      await page.evaluate(() => { for (let i = 1; i <= 13; i++) document.querySelector(`input[aria-label="Select Bulk${String(i).padStart(2, '0')} Label"]`).click(); });
      await until(() => document.body.innerText.includes('13 selected'));
      await until(() => document.querySelector('.selbar').getAnimations().every((x) => x.playState === 'finished'));
      await clickText('.selbar a', 'Print labels');
      await waitH1('Print labels');
      assert.equal(await page.$eval('#mode-ticked', (e) => e.checked), true);
      await setLayout('l7160');
      assert.equal((await sheetGeometry()).n, 21);
      await page.select('#layout', 'l7177');
      const g = await sheetGeometry();
      assert.deepEqual([g.n, g.cols, g.rows, g.dc, g.dr], [12, 2, 6, '2', '6']);
      assert.ok(Math.abs(g.sh / g.sw - 297 / 210) < 0.01, `sheet is A4-shaped: ${g.sh / g.sw}`);
      assert.ok(Math.abs(g.w / g.h - 99.1 / 42.3) < 0.05, `slot is 99.1 x 42.3-shaped: ${g.w / g.h}`);
      assert.equal(g.inside, true, 'all slots drawn inside the sheet');
      assert.match(await page.$eval('#layout-desc', (e) => e.textContent), /^12 labels per sheet: 2 columns × 6 rows, each 99\.1 × 42\.3 mm\.$/);
      // start-at is limited to the 12 slots of this layout
      assert.equal(await page.$eval('#start_at', (e) => e.max), '12');
      assert.equal(await page.$eval('label[for=start_at]', (e) => e.textContent), 'Start at label (1 to 12)');
      await fill('#start_at', '13');
      assert.match(await page.$eval('#sheet-note', (e) => e.textContent), /Enter a label number from 1 to 12/);
      for (const f of pdfFiles()) rmSync(join(dlDir, f));
      await page.click('form button[type=submit]');
      await until(() => document.querySelector('p.error')?.textContent.includes('Start label must be a whole number from 1 to 12.'));
      await fill('#start_at', '12');
      const marks = await page.$$eval('.sheet .slot', (s) => s.map((e) => (e.classList.contains('is-filled') ? 'F' : e.classList.contains('is-used') ? 'u' : '.')).join(''));
      assert.equal(marks, 'uuuuuuuuuuuF');
      // switching from a layout with more slots clamps a too-large start label
      await page.select('#layout', 'l7160');
      await fill('#start_at', '20');
      await page.select('#layout', 'l7177');
      assert.equal(await page.$eval('#start_at', (e) => e.value), '12', 'clamped to the last slot of the 12-up sheet');
      // tapping a slot sets the start position
      await page.click('.sheet .slot[data-slot="7"]');
      assert.equal(await page.$eval('#start_at', (e) => e.value), '7');
      await fill('#start_at', '1');

      const pdf = await generate();
      assert.equal(await notice(), 'Created address-labels.pdf: 13 labels on 2 sheets.');
      assert.equal(pdf.pages, 2);
      const { jsPDF } = await import('jspdf');
      const meas = new jsPDF({ unit: 'mm', format: 'a4' });
      const pad = 4;
      const names = [];
      for (const [pi, texts] of pdf.texts.entries()) {
        // font size comes from the layout (11.5 pt for 42.3 mm labels) because this short content fits
        const perSlot = new Map();
        for (const t of texts) {
          const ymm = mmY(t.ypt);
          const idx = Array.from({ length: 12 }, (_, i) => i).find((i) => { const r = lr(i, L); return t.xmm >= r.x && t.xmm < r.x + r.w && ymm > r.y && ymm < r.y + r.h; });
          assert.notEqual(idx, undefined, `text "${t.t}" is not inside any label rectangle (page ${pi + 1}, x=${t.xmm}, y=${ymm})`);
          const r = lr(idx, L);
          assert.ok(near(t.xmm, r.x + pad), `"${t.t}" starts ${pad} mm inside its label: ${t.xmm} vs ${r.x + pad}`);
          meas.setFont('helvetica', 'bold'); meas.setFontSize(11.5);
          assert.ok(t.xmm + meas.getTextWidth(t.t) <= r.x + r.w - pad + 0.01, `"${t.t}" ends inside the right padding`);
          assert.ok(ymm >= r.y + pad && ymm <= r.y + r.h - pad, `baseline of "${t.t}" is inside the label's text box`);
          perSlot.set(idx, [...(perSlot.get(idx) || []), t]);
          if (/^Bulk\d\d Label$/.test(t.t)) names.push([pi, idx, t]);
        }
        assert.equal(perSlot.size, pi === 0 ? 12 : 1, `page ${pi + 1} fills ${pi === 0 ? 12 : 1} slots`);
        for (const lines of perSlot.values()) assert.equal(lines.length, 4, 'name, street, city/state and PIN');
      }
      assert.equal(names.length, 13);
      assert.deepEqual(names.map(([pi, idx]) => [pi, idx]), Array.from({ length: 13 }, (_, i) => [i < 12 ? 0 : 1, i % 12]));
      const r0 = lr(0, L);
      assert.ok(near(names[0][2].ypt, await expectedYpt(r0.y + pad, 11.5), 0.001), 'first line sits 4 mm below the label top at 11.5 pt');
      assert.ok(near(names[1][2].xmm - names[0][2].xmm, 101.6), 'columns 101.6 mm apart');
      assert.ok(near(names[0][2].ypt - names[2][2].ypt, 42.3 / MM, 0.001), 'rows 42.3 mm apart');
    });

    it('a very long address still sits inside its 12-up label (text shrinks, nothing leaves the rectangle)', async () => {
      const { presetById, labelRect: lr } = await import('../../public/labels.js');
      const L = presetById('l7164');
      const long = 'Very '.repeat(30).trim();
      const r = await api.post('/api/addresses', { ...ADDR, first_name: 'Longline', surname: 'Tester', address_line1: long, address_line2: long, landmark: long, phone: '9611111111' });
      assert.equal(r.status, 201, r.text);
      await backToList();
      await until(() => document.querySelector('.selbar').getAnimations().every((x) => x.playState === 'finished'));
      await clickText('.selbar button', 'Clear');
      await until(() => document.querySelector('.selbar').hidden);
      await page.select('#group', '');
      await fill('#q', ''); await page.type('#q', 'Longline');
      await listIs(1);
      await openLabels('l7164');
      const pdf = await generate();
      assert.equal(pdf.pages, 1);
      const r0 = lr(0, L);
      assert.ok(pdf.texts[0].length >= 4);
      for (const t of pdf.texts[0]) {
        const ymm = mmY(t.ypt);
        assert.ok(t.xmm >= r0.x + 3 - 0.01, `"${t.t}" left`);
        assert.ok(ymm > r0.y && ymm < r0.y + r0.h, `"${t.t}" baseline inside the label (y=${ymm})`);
      }
      const lowest = Math.max(...pdf.texts[0].map((t) => mmY(t.ypt)));
      assert.ok(lowest < r0.y + r0.h - 3 + 0.01, `last baseline ${lowest} is above the bottom padding`);
    });

    it('custom layout: prefilled from the selected preset, bad input shows inline messages and blocks the PDF, good input redraws the preview', async () => {
      await goHash('#/labels');
      await waitH1('Print labels');
      await setLayout('l7177');
      assert.equal(await page.$eval('#custom-sheet', (e) => e.hidden), true);
      for (const x of pdfFiles()) rmSync(join(dlDir, x));
      await page.select('#layout', 'custom');
      assert.equal(await page.$eval('#custom-sheet', (e) => e.hidden), false);
      const vals = () => page.$$eval('#custom-sheet input', (i) => i.map((e) => e.value));
      assert.deepEqual(await vals(), ['2', '6', '99.1', '42.3', '21.6', '4.65', '2.5', '0'], 'pre-filled with the 99.1 x 42.3 preset');
      assert.equal((await sheetGeometry()).n, 12);
      const labelsFor = await page.$$eval('#custom-sheet label', (l) => l.map((e) => e.textContent.trim()));
      assert.deepEqual(labelsFor, ['Columns', 'Rows', 'Label width (mm)', 'Label height (mm)', 'Top margin (mm)', 'Left margin (mm)', 'Horizontal gap (mm)', 'Vertical gap (mm)']);
      for (const f of ['cols', 'rows', 'labelW', 'labelH', 'topMargin', 'sideMargin', 'colGap', 'rowGap']) {
        assert.equal(await page.$eval(`label[for=custom_${f}]`, (e) => e.control?.id), `custom_${f}`, `label is tied to ${f}`);
      }
      await fill('#custom_labelW', '110');
      await until(() => document.getElementById('custom_labelW-err').textContent.includes('Too wide for A4'));
      assert.equal(await page.$eval('#custom_labelW', (e) => e.getAttribute('aria-invalid')), 'true');
      assert.match(await page.$eval('#custom_labelW-err', (e) => e.textContent), /210 mm wide/);
      assert.equal((await sheetGeometry()).n, 0, 'no preview while invalid');
      assert.match(await page.$eval('#sheet-note', (e) => e.textContent), /Fix the sheet sizes/);
      await page.click('form button[type=submit]');
      await until(() => document.querySelector('p.error')?.textContent.startsWith('Fix the sheet sizes first.'));
      assert.equal(await page.$eval('#custom_labelW', (e) => e === document.activeElement), true, 'focus moves to the bad field');
      await fill('#custom_labelW', '0');
      await until(() => /more than 0/.test(document.getElementById('custom_labelW-err').textContent));
      await clearField('#custom_labelW');
      await until(() => /enter a number/.test(document.getElementById('custom_labelW-err').textContent));
      await fill('#custom_labelW', '99.1');
      await fill('#custom_cols', '1.5');
      await until(() => /whole number/.test(document.getElementById('custom_cols-err').textContent));
      await fill('#custom_cols', '2');
      await fill('#custom_rowGap', '-1');
      await until(() => /cannot be negative/.test(document.getElementById('custom_rowGap-err').textContent));
      await fill('#custom_rowGap', '0');
      await fill('#custom_labelH', '60');
      await until(() => document.getElementById('custom_labelH-err').textContent.includes('Too tall for A4'));
      await new Promise((r) => setTimeout(r, 400));
      assert.deepEqual(pdfFiles(), [], 'nothing was downloaded');
      // a valid custom sheet: 2 x 5, 100 x 50 mm
      await fillForm({ custom_rows: '5', custom_labelW: '100', custom_labelH: '50', custom_topMargin: '10', custom_sideMargin: '5', custom_colGap: '0' });
      await until(() => [...document.querySelectorAll('#custom-sheet .field-error')].every((e) => e.textContent === ''));
      const g = await sheetGeometry();
      assert.deepEqual([g.n, g.cols, g.rows], [10, 2, 5]);
      assert.equal(await page.$eval('#start_at', (e) => e.max), '10');
      assert.equal(await page.$eval('label[for=start_at]', (e) => e.textContent), 'Start at label (1 to 10)');
      assert.match(await page.$eval('#layout-desc', (e) => e.textContent), /^10 labels per sheet: 2 columns × 5 rows, each 100 × 50 mm\.$/);
      const pdf = await generate();
      assert.equal(pdf.pages, 1, 'the filter still shows only Longline');
      assert.ok(near(pdf.texts[0][0].xmm, 5 + 4), `custom sheet: 5 mm margin + 4 mm padding (labels 100 mm wide): ${pdf.texts[0][0].xmm}`);
    });

    it('the layout choice and the custom values survive a reload; localStorage trouble falls back to the 12-up default', async () => {
      await page.reload();
      await waitH1('Print labels');
      assert.equal(await page.$eval('#layout', (e) => e.value), 'custom');
      assert.deepEqual(await page.$$eval('#custom-sheet input', (i) => i.map((e) => e.value)), ['2', '5', '100', '50', '10', '5', '0', '0']);
      assert.equal((await sheetGeometry()).n, 10);
      await page.select('#layout', 'l7164');
      await page.reload();
      await waitH1('Print labels');
      assert.equal(await page.$eval('#layout', (e) => e.value), 'l7164');
      assert.equal((await sheetGeometry()).n, 12);
      assert.equal((await sheetGeometry()).cols, 3);
      // garbage in storage -> default; custom values that no longer fit -> default
      await page.evaluate(() => localStorage.setItem('fab.labelLayout', '{not json'));
      await page.reload();
      await waitH1('Print labels');
      assert.equal(await page.$eval('#layout', (e) => e.value), 'l7177');
      await page.evaluate(() => localStorage.setItem('fab.labelLayout', JSON.stringify({ id: 'custom', custom: { cols: '9', rows: '9', labelW: '90', labelH: '90', topMargin: '0', sideMargin: '0', colGap: '0', rowGap: '0' } })));
      await page.reload();
      await waitH1('Print labels');
      assert.equal(await page.$eval('#layout', (e) => e.value), 'l7177');
      await page.evaluate(() => localStorage.setItem('fab.labelLayout', JSON.stringify({ id: 'bogus' })));
      await page.reload();
      await waitH1('Print labels');
      assert.equal(await page.$eval('#layout', (e) => e.value), 'l7177');
      // storage that throws is survived
      await page.evaluateOnNewDocument(() => {
        const boom = () => { throw new DOMException('denied', 'SecurityError'); };
        Storage.prototype.getItem = boom; Storage.prototype.setItem = boom;
      });
      await page.reload();
      await waitH1('Print labels');
      assert.equal(await page.$eval('#layout', (e) => e.value), 'l7177');
      await page.select('#layout', 'l7164');
      assert.equal((await sheetGeometry()).n, 12, 'still works without storage');
    });

    it('label outlines: off by default; on draws a rectangle for every slot of every sheet (filled or not), no errors', async () => {
      // new documents now have throwing storage (set above), so use a fresh page for the rest of the labels tests
      const old = page;
      page = await browser.newPage();
      await old.close();
      await page.setViewport({ width: 390, height: 800 });
      page.on('console', (m) => { if (/Content[- ]Security[- ]Policy|Refused to/i.test(m.text())) cspViolations.push(m.text()); });
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
      await page.evaluateOnNewDocument(() => {
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
      });
      await page.goto(`${srv.baseUrl}/#/labels`);
      await waitH1('Print labels');
      await setLayout('l7177');
      assert.equal(await page.$eval('#outlines', (e) => e.checked), false, 'off by default');
      assert.equal(await page.$eval('label[for=outlines]', (e) => e.textContent.trim()), 'Draw label outlines (for a test print on plain paper)');
      let pdf = await generate();
      assert.equal(rectsOf(pdf).flat().length, 0, 'no outlines by default');
      await page.click('#outlines');
      const total = Number((/\((\d+)\)/.exec(await page.$eval('label[for=mode-filter]', (e) => e.textContent)) || [])[1]);
      pdf = await generate();
      const pages = rectsOf(pdf);
      assert.equal(pdf.pages, Math.ceil(total / 12));
      assert.equal(pages.length, pdf.pages);
      const { presetById, labelRect: lr } = await import('../../public/labels.js');
      for (const rs of pages) {
        assert.equal(rs.length, 12, 'one outline per slot on every page, including empty slots');
        rs.forEach((r, i) => {
          const e = lr(i, presetById('l7177'));
          assert.ok(near(r.x, e.x) && near(r.y, e.y) && near(r.w, e.w) && near(r.h, e.h), `outline ${i}: ${JSON.stringify(r)} vs ${JSON.stringify(e)}`);
        });
      }
      assert.match(pdf.bytes, /0\.75 G/, 'light grey stroke colour');
      assert.match(await notice(), /on \d+ sheets?\./);
      await page.click('#outlines');
    });

    it('printer shift: validated, remembered, and a 2 mm shift moves every text and outline position by exactly 2 mm', async () => {
      assert.equal(await page.$eval('#shift_x', (e) => e.value), '0');
      assert.equal(await page.$eval('#shift_y', (e) => e.value), '0');
      assert.equal(await page.$eval('label[for=shift_x]', (e) => e.textContent), 'Shift right (mm)');
      assert.equal(await page.$eval('label[for=shift_y]', (e) => e.textContent), 'Shift down (mm)');
      await page.click('#outlines');
      const base = await generate();
      await fill('#shift_x', '2');
      const right = await generate();
      await fill('#shift_x', '0'); await fill('#shift_y', '1.5');
      const down = await generate();
      assert.equal(base.pages, right.pages);
      const flat = (p) => p.texts.flat();
      assert.equal(flat(base).length, flat(right).length);
      flat(base).forEach((t, i) => {
        assert.ok(near(flat(right)[i].xmm - t.xmm, 2, 0.005), `text x moved by 2 mm: ${flat(right)[i].xmm - t.xmm}`);
        assert.ok(near(flat(right)[i].ypt, t.ypt, 0.001), 'text y unchanged by a horizontal shift');
        assert.ok(near(t.ypt - flat(down)[i].ypt, 1.5 / MM, 0.001), 'a 1.5 mm shift down lowers the text by 1.5 mm');
        assert.ok(near(flat(down)[i].xmm, t.xmm, 0.005));
      });
      rectsOf(base).flat().forEach((r, i) => {
        const rr = rectsOf(right).flat()[i], dd = rectsOf(down).flat()[i];
        assert.ok(near(rr.x - r.x, 2, 0.005) && near(rr.y, r.y, 0.005) && near(rr.w, r.w, 0.005), 'outline moved right by 2 mm, same size');
        assert.ok(near(dd.y - r.y, 1.5, 0.005) && near(dd.x, r.x, 0.005), 'outline moved down by 1.5 mm');
      });
      // negative and decimal values work; out-of-range and junk are refused with a message and no PDF
      await fill('#shift_x', '-1.25'); await fill('#shift_y', '0');
      const left = await generate();
      assert.ok(near(flat(left)[0].xmm - flat(base)[0].xmm, -1.25, 0.005));
      for (const bad of ['5.5', '-6', '1e1', '']) {
        if (bad === '') await clearField('#shift_x'); else await fill('#shift_x', bad);
        await until(() => document.getElementById('shift_x-err').textContent.length > 0);
        for (const f of pdfFiles()) rmSync(join(dlDir, f));
        await page.evaluate(() => { document.querySelector('form p.error')?.remove(); });
        await page.click('form button[type=submit]');
        await until(() => document.querySelector('p.error')?.textContent.startsWith('Fix the fine-tune shift first.'));
        assert.equal(await page.$eval('#shift_x', (e) => e.getAttribute('aria-invalid')), 'true');
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual(pdfFiles(), []);
      }
      // remembered across a reload
      await fill('#shift_x', '2'); await fill('#shift_y', '-0.5');
      await page.reload();
      await waitH1('Print labels');
      assert.equal(await page.$eval('#shift_x', (e) => e.value), '2');
      assert.equal(await page.$eval('#shift_y', (e) => e.value), '-0.5');
      await fill('#shift_x', '0'); await fill('#shift_y', '0');
      await page.click('#outlines');
    });

    it('360 px wide: Labels view with the 12-up layout and with Custom open has no horizontal scroll, labelled inputs and 44 px controls', async () => {
      await page.setViewport({ width: 360, height: 800 });
      await page.reload();
      await waitH1('Print labels');
      const probe = () => page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        small: [...document.querySelectorAll('main button, main input:not([type=checkbox]):not([type=radio]), main select, main a.btn')]
          .filter((e) => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 44)
          .map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}:${Math.round(e.getBoundingClientRect().height)}px`),
        unlabelled: [...document.querySelectorAll('main input, main select')].filter((e) => !e.labels || e.labels.length === 0).map((e) => e.id || e.type),
        wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > 361).slice(0, 5).map((e) => `${e.tagName.toLowerCase()}#${e.id}.${e.className}`),
      }));
      await setLayout('l7177');
      await new Promise((r) => setTimeout(r, 300));
      if (process.env.UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.UI_SCREENSHOTS, 'labels-360-12up.png'), fullPage: true });
      let m = await probe();
      assert.deepEqual(m, { sw: 360, small: [], unlabelled: [], wide: [] }, '12-up');
      await page.select('#layout', 'custom');
      await fill('#custom_labelW', '120');
      await until(() => document.getElementById('custom_labelW-err').textContent.length > 0);
      await new Promise((r) => setTimeout(r, 300));
      if (process.env.UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.UI_SCREENSHOTS, 'labels-360-custom.png'), fullPage: true });
      m = await probe();
      assert.deepEqual(m, { sw: 360, small: [], unlabelled: [], wide: [] }, 'Custom open with an error showing');
      await fill('#custom_labelW', '99.1');
      await page.select('#layout', 'l7177');
      await page.setViewport({ width: 390, height: 800 });
    });
  });

  // ---------- Excel export ----------
  describe('excel export', () => {
    const xlsxFiles = () => readdirSync(dlDir).filter((f) => f.endsWith('.xlsx')).sort();
    const resetXlsx = () => { for (const f of xlsxFiles()) rmSync(join(dlDir, f)); };
    async function waitXlsx() {
      for (let i = 0; i < 100; i++) {
        const f = xlsxFiles();
        if (f.length) {
          await new Promise((r) => setTimeout(r, 300));
          return { name: f[0], path: join(dlDir, f[0]), bytes: readFileSync(join(dlDir, f[0])) };
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`no .xlsx arrived; files: ${readdirSync(dlDir)}`);
    }
    const py = spawnSync('python3', ['-I', '-c', 'import openpyxl'], { encoding: 'utf8' });
    const hasOpenpyxl = py.status === 0;
    /** Open with openpyxl: header, data rows as [value, data_type] pairs. */
    function readWithOpenpyxl(path) {
      const script = `
import sys, json, openpyxl
ws = openpyxl.load_workbook(sys.argv[1])['Addresses']
print(json.dumps({'header': [c.value for c in ws[1]], 'rows': [[[c.value, c.data_type] for c in r] for r in ws.iter_rows(min_row=2)], 'freeze': ws.freeze_panes}, ensure_ascii=False))`;
      const r = spawnSync('python3', ['-I', '-c', script, path], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    }
    const HEADER = ['First name', 'Surname', 'Address line 1', 'Address line 2', 'Landmark', 'City', 'State', 'PIN', 'Phone', 'Email', 'Group', 'Notes', 'Added by'];
    const flashText = () => page.$eval('.notice[role=status]', (e) => e.textContent);

    it('More menu: "Export to Excel (.xlsx)" downloads addresses.xlsx with every address; PIN keeps its leading zero and "=" stays text', async () => {
      const r = await api.post('/api/addresses', { ...ADDR, first_name: '=SUM(1,2)', surname: 'Amp & <Lt> \u00dcn\u00ef', pin: '012345', phone: '9000000012', group_name: 'Excel', notes: 'Line1\nLine2' });
      assert.equal(r.status, 201, r.text);
      const total = (await api.get('/api/addresses')).json.addresses.length;
      await goHash('#/');
      await waitH1('Addresses');
      resetXlsx();
      await menuGo('Export to Excel (.xlsx)');
      const f = await waitXlsx();
      assert.equal(f.name, 'addresses.xlsx');
      assert.equal(f.bytes.subarray(0, 2).toString('latin1'), 'PK', 'ZIP signature');
      await until((t) => document.querySelector('.notice[role=status]')?.textContent === t, `Created addresses.xlsx: ${total} addresses.`);
      assert.equal(await page.$eval('#more-menu', (e) => e.hidden), true, 'menu closes after choosing');
      if (hasOpenpyxl) {
        const o = readWithOpenpyxl(f.path);
        assert.deepEqual(o.header, HEADER);
        assert.equal(o.rows.length, total);
        assert.equal(o.freeze, 'A2');
        const row = o.rows.find((x) => x[1][0].startsWith('Amp'));
        assert.deepEqual(row[0], ['=SUM(1,2)', 's']);
        assert.equal(row[1][0], 'Amp & <Lt> \u00dcn\u00ef');
        assert.deepEqual(row[7], ['012345', 's']);
        assert.deepEqual(row[8], ['9000000012', 's']);
        assert.equal(row[11][0], 'Line1\nLine2');
        assert.equal(row[12][0], 'Owner');
      }
    });

    it('Labels view: "Export these addresses to Excel" exports exactly the set that would be printed (search, everything, selected)', async () => {
      // 1) a search
      await goHash('#/');
      await waitH1('Addresses');
      await until(() => document.querySelector('#q'));
      await fill('#q', ''); await page.type('#q', '<Lt>');
      await listIs(1);
      await clickText('#top a', 'Labels');
      await waitH1('Print labels');
      assert.equal(await page.$eval('#labels-export-xlsx', (e) => e.textContent), 'Export these addresses to Excel');
      resetXlsx();
      await page.click('#labels-export-xlsx');
      let f = await waitXlsx();
      assert.equal(f.name, 'addresses-selected.xlsx');
      assert.equal(f.bytes.subarray(0, 2).toString('latin1'), 'PK');
      assert.equal(await flashText(), 'Created addresses-selected.xlsx: 1 address.');
      if (hasOpenpyxl) {
        const o = readWithOpenpyxl(f.path);
        assert.equal(o.rows.length, 1);
        assert.deepEqual(o.rows[0][0], ['=SUM(1,2)', 's']);
      }
      // 2) everything (no search): same file name as the More menu export
      await clickText('#top a', 'Addresses'); await waitH1('Addresses');
      await fill('#q', ''); await page.type('#q', ' ');
      await page.select('#group', '');
      const total = (await api.get('/api/addresses')).json.addresses.length;
      await until(() => /^\d+ addresses$/.test(document.querySelector('p[role=status]')?.textContent || ''));
      assert.equal(await status(), `${total} addresses`, 'the list shows every address');
      await clickText('#top a', 'Labels');
      await waitH1('Print labels');
      resetXlsx();
      await page.click('#labels-export-xlsx');
      f = await waitXlsx();
      assert.equal(f.name, 'addresses.xlsx');
      if (hasOpenpyxl) assert.equal(readWithOpenpyxl(f.path).rows.length, total);
      // 3) ticked entries only
      await clickText('#top a', 'Addresses'); await waitH1('Addresses');
      await until(() => document.querySelector('input[aria-label="Select Bulk03 Label"]'));
      await page.click('input[aria-label="Select Bulk03 Label"]');
      await page.click('input[aria-label="Select Bulk05 Label"]');
      await until(() => document.querySelector('.selbar').getAnimations().every((x) => x.playState === 'finished'));
      await clickText('.selbar a', 'Print labels');
      await waitH1('Print labels');
      assert.equal(await page.$eval('#mode-ticked', (e) => e.checked), true);
      resetXlsx();
      await page.click('#labels-export-xlsx');
      f = await waitXlsx();
      assert.equal(f.name, 'addresses-selected.xlsx');
      assert.equal(f.bytes.subarray(0, 2).toString('latin1'), 'PK');
      assert.equal(await flashText(), 'Created addresses-selected.xlsx: 2 addresses.');
      if (hasOpenpyxl) {
        const o = readWithOpenpyxl(f.path);
        assert.deepEqual(o.rows.map((r) => r[0][0]).sort(), ['Bulk03', 'Bulk05']);
        assert.deepEqual(o.rows.map((r) => r[7][0]), ['560001', '560001']);
      }
      // nothing ticked -> message, no file
      await clickText('#top a', 'Addresses'); await waitH1('Addresses');
      await until(() => document.querySelector('.selbar') && !document.querySelector('.selbar').hidden);
      await until(() => document.querySelector('.selbar').getAnimations().every((x) => x.playState === 'finished'));
      await clickText('.selbar button', 'Clear');
      await clickText('#top a', 'Labels'); await waitH1('Print labels');
      await page.click('#mode-ticked');
      resetXlsx();
      await page.click('#labels-export-xlsx');
      await until(() => document.querySelector('p.error')?.textContent === 'No addresses are selected.');
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(xlsxFiles(), []);
      assert.equal(hasOpenpyxl, true, 'openpyxl was available, so the files above were opened with a real reader');
    });
  });

  // ---------- escaping, layout, hygiene ----------
  it('user-supplied HTML is shown as text and never executed (list, edit form, users list)', async () => {
    const payload = '<img src=x onerror="window.__xss=1">';
    const r = await api.post('/api/addresses', { ...ADDR, first_name: payload, surname: '<b>bold</b>', phone: '9500000001', address_line1: '<script>window.__xss=2</script>' });
    assert.equal(r.status, 201, r.text);
    const u = await api.post('/api/users', { name: '<i onclick="window.__xss=3">Evil</i>', email: 'evil-name@example.com' });
    assert.equal(u.status, 201, u.text);
    await clickText('#top a', 'Addresses');
    await waitH1('Addresses');
    await until(() => document.querySelector('#group'));
    await page.select('#group', '');
    await fill('#q', ''); await page.type('#q', '9500000001');
    await listIs(1);
    assert.match((await entries())[0], /<img src=x onerror="window\.__xss=1"> <b>bold<\/b>/);
    assert.equal(await page.$$eval('ul.list img, ul.list b b', (e) => e.length), 0);
    await clickText('ul.list a.entry', '<img', false);
    await waitH1('Edit address');
    assert.equal(await page.$eval('#address_line1', (e) => e.value), '<script>window.__xss=2</script>');
    await menuGo('Users');
    await waitH1('Users');
    await until(() => [...document.querySelectorAll('li.user')].some((l) => l.innerText.includes('<i onclick')));
    assert.equal(await page.$$eval('li.user i', (e) => e.length), 0);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
  });

  it('360 px wide: no horizontal scrolling on any view; inputs and buttons are tappable', async () => {
    await page.setViewport({ width: 360, height: 740 });
    const problems = [];
    const views = [['#/', 'Addresses'], ['#/', 'Addresses', 'more'], ['#/', 'Addresses', 'selected'], ['#/new', 'Add address'],
      [`#/edit/${firstAddressId}`, 'Edit address'], ['#/labels', 'Print labels'], ['#/users', 'Users'], ['#/password', 'Change password']];
    for (const [hash, h, extra] of views) {
      await goHash(hash);
      await waitH1(h);
      if (extra === 'more') await openMore();
      if (extra === 'selected') { await until(() => document.querySelector('ul.list input[type=checkbox]')); await page.click('ul.list input[type=checkbox]'); }
      await new Promise((r) => setTimeout(r, 300));
      if (process.env.UI_SCREENSHOTS) await page.screenshot({ path: join(process.env.UI_SCREENSHOTS, `view-${h.replace(/\W+/g, '-')}.png`) });
      const m = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        small: [...document.querySelectorAll('main button, main input:not([type=checkbox]):not([type=radio]), main select, main textarea, main a.btn, main a.tel, #top a, #top button')]
          .filter((e) => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 40)
          .map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}:${Math.round(e.getBoundingClientRect().height)}px`),
      }));
      if (m.sw > 360) {
        const wide = await page.evaluate(() => [...document.querySelectorAll('body *')]
          .filter((e) => e.getBoundingClientRect().right > 361)
          .slice(0, 6).map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className ? '.' + e.className : ''} right=${Math.round(e.getBoundingClientRect().right)} text="${(e.textContent || '').trim().slice(0, 40)}"`));
        problems.push(`${hash}${extra || ''}: scrollWidth ${m.sw} > 360; elements past the edge: ${wide.join(' | ')}`);
      }
      if (m.small.length) problems.push(`${hash}${extra || ''}: controls under 40px tall: ${m.small.join(', ')}`);
      if (extra === 'more') {
        const r = await page.$eval('#more-menu', (e) => { const b = e.getBoundingClientRect(); return [b.left, b.right]; });
        if (r[0] < 0 || r[1] > 360) problems.push(`More menu outside the viewport: ${r}`);
        await page.keyboard.press('Escape');
      }
      if (extra === 'selected') await clickText('.selbar button', 'Clear');
    }
    assert.deepEqual(problems, []);
  });

  it('360 px wide: the login view fits too (fresh, logged-out browser context)', async () => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    p.on('console', (m) => { if (/Content[- ]Security[- ]Policy|Refused to/i.test(m.text())) cspViolations.push(m.text()); });
    p.on('pageerror', (e) => pageErrors.push(String(e)));
    try {
      await p.setViewport({ width: 360, height: 740 });
      await p.goto(`${srv.baseUrl}/`);
      await p.waitForFunction(() => document.querySelector('h1')?.textContent === 'Family Address Book', { timeout: 10000 });
      if (process.env.UI_SCREENSHOTS) await p.screenshot({ path: join(process.env.UI_SCREENSHOTS, 'view-Login.png') });
      const m = await p.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        btn: document.querySelector('button[type=submit]').getBoundingClientRect().height,
        labelled: ['email', 'password'].every((id) => document.querySelector(`label[for=${id}]`)),
      }));
      assert.ok(m.sw <= 360, `scrollWidth ${m.sw}`);
      assert.ok(m.btn >= 44, `login button ${m.btn}px`);
      assert.ok(m.labelled, 'inputs have labels');
    } finally {
      await ctx.close();
    }
  });

  it('phone and PIN inputs have mobile keyboard hints', async () => {
    await page.setViewport({ width: 390, height: 800 });
    await goHash('#/new');
    await waitH1('Add address');
    assert.equal(await page.$eval('#pin', (e) => e.getAttribute('inputmode')), 'numeric');
    assert.equal(await page.$eval('#phone', (e) => e.getAttribute('inputmode')), 'tel');
  });

  it('no Content-Security-Policy violations were reported during the whole run (including the PDF download)', async () => {
    assert.deepEqual(cspViolations, []);
    assert.deepEqual(await page.evaluate(() => window.__csp).catch(() => []), []);
  });

  it('no uncaught page errors and no console errors during the whole run', () => {
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
  });
});
