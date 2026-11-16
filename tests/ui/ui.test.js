// UI smoke tests: drive the real front end (public/index.html + app.js) in headless Chrome
// via puppeteer-core, against a live `wrangler pages dev` server with a throwaway D1 database.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    assert.deepEqual(more, ['Users', 'Change password', 'Export CSV', 'Log out']);
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
    for (const next of ['Change password', 'Export CSV', 'Log out']) {
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
    const openLabels = async () => { await clickText('#top a', 'Labels'); await waitH1('Print labels'); };
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
