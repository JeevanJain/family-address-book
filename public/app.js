// Family Address Book - hash-routed single-page app. No framework.
// All user data is inserted with textContent / DOM APIs only (never innerHTML).
import {
  PAGE_W, PAGE_H, PRESETS, CHOOSER_PRESETS, UI_DEFAULT_ID, CUSTOM_ID, DEFAULT_LAYOUT, LAYOUT_FIELDS, parseShift, presetById, perSheet, labelRect, planLabels,
  validateLayout, customLayout, layoutToValues, describeLayout, startFontSize, labelPadding,
  addressLines, fitText, lineHeightMm,
} from '/labels.js';
import { addressesToXlsx, XLSX_MIME } from '/xlsx.js';

const mainEl = document.getElementById('app');
let appEl = mainEl; // per-route container, so a stale async view cannot write into a newer page
const topEl = document.getElementById('top');

let me = null; // current user
let renderToken = 0;
const selected = new Set(); // ticked address ids (persist while navigating)
const listState = { q: '', group: '' };

// ---------- DOM helper ----------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };

// ---------- API ----------
class ApiError extends Error {
  constructor(status, data) {
    super((data && data.message) || `Request failed (${status})`);
    this.status = status;
    this.code = data && data.error;
    this.data = data || {};
  }
}

async function api(method, path, body, { auth = true } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body === undefined ? {} : body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError(0, { error: 'network', message: 'Could not reach the server. Check your connection.' });
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    if (auth && res.status === 401) {
      me = null;
      go('#/login');
    } else if (res.status === 403 && data && data.error === 'password_change_required') {
      if (me) me.must_change_password = true;
      go('#/password');
    }
    throw new ApiError(res.status, data);
  }
  return data;
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

// ---------- validation (mirrors functions/_lib/validate.js) ----------
const TEXT_FIELDS = {
  first_name: ['First name', true, 100],
  surname: ['Surname', false, 100],
  address_line1: ['Address line 1', true, 200],
  address_line2: ['Address line 2', false, 200],
  landmark: ['Landmark', false, 200],
  city: ['City', true, 100],
  state: ['State', true, 100],
  group_name: ['Group', false, 50],
  notes: ['Notes', false, 1000],
};
function normalisePhone(value) {
  let v = String(value).replace(/[\s\-.()]/g, '');
  if (v.startsWith('+91')) v = v.slice(3);
  else if (v.startsWith('0')) v = v.slice(1);
  return /^\d{10}$/.test(v) ? v : null;
}
function isValidEmail(v) {
  const s = String(v).trim();
  return s.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s);
}
function validateAddress(v) {
  const errors = {};
  for (const [f, [label, req, max]] of Object.entries(TEXT_FIELDS)) {
    const s = (v[f] || '').trim();
    if (!s && req) errors[f] = `${label} is required.`;
    else if (s.length > max) errors[f] = `${label} is too long (max ${max}).`;
  }
  if (!/^\d{6}$/.test((v.pin || '').trim())) errors.pin = 'PIN must be exactly 6 digits.';
  if (normalisePhone(v.phone || '') === null) errors.phone = 'Phone must be 10 digits (a leading +91 or 0 is removed).';
  if ((v.email || '').trim() && !isValidEmail(v.email)) errors.email = 'Email is not valid.';
  return errors;
}

// ---------- icons (inline SVG built with DOM APIs; no innerHTML, no inline styles) ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  el.append(...kids);
  return el;
}
const ICONS = {
  phone: { fill: 'M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.6 21 3 13.4 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z' },
  down: { stroke: 'M6 9l6 6 6-6' },
  right: { stroke: 'M9 6l6 6-6 6' },
  plus: { stroke: 'M12 5v14M5 12h14' },
  alert: { stroke: 'M12 3.5 2.5 20h19L12 3.5zM12 10v4.5M12 17.3v.2' },
  envelope: { stroke: 'M3.5 6.5h17v11h-17zM3.5 7.5l8.5 6 8.5-6' },
  printer: { stroke: 'M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M7 14h10v6H7z' },
};
function icon(name, cls = 'icon') {
  const p = ICONS[name];
  const path = p.fill
    ? s('path', { d: p.fill, fill: 'currentColor' })
    : s('path', { d: p.stroke, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  return s('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true', focusable: 'false' }, path);
}
/** The app's mark: a postage stamp with a house on it. Perforations are drawn in the background colour. */
function stampMark(cls) {
  return s('svg', { viewBox: '0 0 40 48', class: `stamp ${cls}`, 'aria-hidden': 'true', focusable: 'false' },
    s('rect', { x: 2, y: 2, width: 36, height: 44, class: 'stamp-paper' }),
    s('rect', { x: 2, y: 2, width: 36, height: 44, class: 'stamp-perf', fill: 'none', 'stroke-width': 3.2, 'stroke-dasharray': '2.6 2.4' }),
    s('rect', { x: 7.5, y: 7.5, width: 25, height: 33, class: 'stamp-line', fill: 'none', 'stroke-width': 1.2 }),
    s('path', { d: 'M12.5 26.5 20 20l7.5 6.5M15 24.5V33h10v-8.5', class: 'stamp-line', fill: 'none', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
}

const fullName = (a) => [a.first_name, a.surname].filter(Boolean).join(' ');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------- shared UI pieces ----------
let closeMenu = null; // set while the More menu exists
document.addEventListener('click', (e) => {
  if (closeMenu && !(e.target instanceof Element && e.target.closest('.more'))) closeMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && closeMenu) closeMenu(true);
});

function renderTop() {
  clear(topEl);
  closeMenu = null;
  if (!me || me.must_change_password) { topEl.hidden = true; return; }
  topEl.hidden = false;
  const cur = location.hash || '#/';
  const tab = (href, text, match) => {
    const on = match.test(cur);
    return h('li', null, h('a', { href, class: on ? 'tab current' : 'tab', 'aria-current': on ? 'page' : undefined, text }));
  };
  const item = (href, text, match, extra) => {
    const on = match && match.test(cur);
    return h('li', null, h('a', { href, 'aria-current': on ? 'page' : undefined, text, ...extra }));
  };
  const inMore = /^#\/(users|password)/.test(cur);

  const btn = h('button', { type: 'button', id: 'more-btn', class: inMore ? 'more-btn current' : 'more-btn', 'aria-expanded': 'false', 'aria-controls': 'more-menu' },
    h('span', { text: 'More' }), icon('down'));
  const panel = h('div', { id: 'more-menu', class: 'more-menu', hidden: true },
    h('p', { class: 'who' }, 'Signed in as ', h('strong', { text: me.name }), me.role === 'owner' ? ' (owner)' : ''),
    h('ul', null,
      item('#/users', 'Users', /^#\/users/),
      item('#/password', 'Change password', /^#\/password/),
      item('/api/export.csv', 'Export CSV', null, { download: 'addresses.csv' }),
      h('li', null, h('button', { type: 'button', onclick: () => { if (closeMenu) closeMenu(true); exportAllToExcel(); }, text: 'Export to Excel (.xlsx)' })),
      h('li', { class: 'sep' }, h('button', { type: 'button', onclick: logout, text: 'Log out' }))));
  const wrap = h('div', { class: 'more' }, btn, panel);

  const setOpen = (open, focusButton) => {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (!open && focusButton) btn.focus();
  };
  closeMenu = (focusButton) => { if (!panel.hidden) setOpen(false, focusButton); };
  btn.addEventListener('click', () => setOpen(panel.hidden));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); panel.querySelector('a, button').focus(); }
  });
  // Close when keyboard focus leaves the menu, or once an item has been chosen.
  wrap.addEventListener('focusout', (e) => { if (e.relatedTarget && !wrap.contains(e.relatedTarget)) setOpen(false); });
  panel.addEventListener('click', (e) => { if (e.target instanceof Element && e.target.closest('a')) setOpen(false); });

  topEl.append(h('div', { class: 'topbar-inner' },
    h('div', { class: 'topbar-row' },
      h('a', { class: 'brand', href: '#/' }, stampMark('stamp-sm'), h('span', { text: 'Family Address Book' })),
      h('nav', { 'aria-label': 'Account' }, wrap)),
    h('nav', { 'aria-label': 'Main' },
      h('ul', { class: 'tabs' },
        tab('#/', 'Addresses', /^#\/?$|^#\/edit/),
        tab('#/new', 'Add', /^#\/new/),
        tab('#/labels', 'Labels', /^#\/labels/)))));
}

async function logout() {
  try { await api('POST', '/api/logout', {}, { auth: false }); } catch { /* ignore */ }
  me = null;
  selected.clear();
  go('#/login');
}

function errorBox(msg) { return h('p', { class: 'error', role: 'alert', text: msg }); }

function field({ id, label, type = 'text', value = '', autocomplete, inputmode, required, maxlength, list, error, textarea, hint, cls, step, min }) {
  const errId = `${id}-err`;
  const hintId = hint ? `${id}-hint` : null;
  const describedBy = [hintId, error ? errId : null].filter(Boolean).join(' ') || undefined;
  const attrs = {
    id, name: id, value: textarea ? undefined : value, autocomplete, inputmode, maxlength, list, step, min,
    type: textarea ? undefined : type, required: required ? true : undefined,
    'aria-invalid': error ? 'true' : undefined,
    'aria-describedby': describedBy,
    autocapitalize: type === 'email' ? 'off' : undefined,
    spellcheck: type === 'email' || type === 'password' ? 'false' : undefined,
  };
  const input = textarea ? h('textarea', { ...attrs, rows: 3 }) : h('input', attrs);
  if (textarea) input.value = value;
  return h('div', { class: cls ? `field ${cls}` : 'field' },
    h('label', { for: id }, label, required ? h('span', { class: 'req', 'aria-hidden': 'true', text: ' *' }) : null),
    hint ? h('div', { class: 'hint', id: hintId, text: hint }) : null,
    input,
    h('div', { class: 'field-error', id: errId, text: error || '' }));
}

function setFieldError(form, name, msg) {
  const input = form.elements[name];
  const err = document.getElementById(`${name}-err`);
  if (err) err.textContent = msg || '';
  if (input) {
    const hint = document.getElementById(`${name}-hint`) ? `${name}-hint` : '';
    const ids = [hint, msg ? `${name}-err` : ''].filter(Boolean).join(' ');
    if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    if (ids) input.setAttribute('aria-describedby', ids); else input.removeAttribute('aria-describedby');
  }
}

async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      input.focus(); input.select();
      return document.execCommand('copy');
    } catch { return false; }
  }
}

// A short message shown at the top of the page (for actions started from the More menu).
// Navigating to another view replaces the whole page content, which removes it.
let flashEl = null;
let flashTimer = 0;
function flash(message, isError) {
  if (flashEl) flashEl.remove();
  flashEl = h('div', { class: isError ? 'error' : 'notice', role: isError ? 'alert' : 'status', text: message });
  mainEl.prepend(flashEl);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (flashEl) flashEl.remove(); flashEl = null; }, 8000);
}

/** Save bytes as a file through a Blob URL and a temporary <a download> (allowed by the page's CSP). */
function downloadBytes(bytes, filename, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = h('a', { href: url, download: filename, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Build and download an .xlsx of the given address records. Returns the number of rows. */
function downloadXlsx(addresses, filename) {
  downloadBytes(addressesToXlsx(addresses), filename, XLSX_MIME);
  return addresses.length;
}

async function exportAllToExcel() {
  try {
    const all = (await api('GET', '/api/addresses')).addresses || [];
    if (!all.length) { flash('There are no addresses to export.', true); return; }
    downloadXlsx(all, 'addresses.xlsx');
    flash(`Created addresses.xlsx: ${plural(all.length, 'address', 'addresses')}.`);
  } catch (err) {
    if (err.status !== 401) flash(`Could not create the Excel file: ${err.message}`, true);
  }
}

// ---------- remembered label layout (per browser; localStorage may be unavailable) ----------
const LAYOUT_STORE_KEY = 'fab.labelLayout';
function loadLayoutPrefs() {
  try {
    const o = JSON.parse(localStorage.getItem(LAYOUT_STORE_KEY));
    if (!o || typeof o !== 'object') return null;
    const id = o.id === CUSTOM_ID || presetById(o.id) ? o.id : null;
    let custom = null;
    if (o.custom && typeof o.custom === 'object') {
      custom = {};
      for (const { key } of LAYOUT_FIELDS) custom[key] = typeof o.custom[key] === 'string' ? o.custom[key].slice(0, 12) : '';
    }
    const str = (v) => (typeof v === 'string' ? v.slice(0, 12) : '0');
    return { id, custom, shiftX: str(o.shiftX), shiftY: str(o.shiftY) };
  } catch { return null; }
}
function saveLayoutPrefs(id, custom, shiftX, shiftY) {
  try { localStorage.setItem(LAYOUT_STORE_KEY, JSON.stringify({ id, custom, shiftX, shiftY })); } catch { /* storage unavailable: just don't remember */ }
}

// ---------- views ----------
function viewLogin() {
  const msg = h('div', { class: 'msg' });
  const form = h('form', { novalidate: true, class: 'panel' },
    field({ id: 'email', label: 'Email', type: 'email', autocomplete: 'username', inputmode: 'email', required: true }),
    field({ id: 'password', label: 'Password', type: 'password', autocomplete: 'current-password', required: true }),
    msg,
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary wide', text: 'Log in' })));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    const email = form.elements.email.value.trim();
    const password = form.elements.password.value;
    if (!email || !password) { msg.append(errorBox('Enter your email and password.')); return; }
    const btn = form.querySelector('button'); btn.disabled = true;
    try {
      const data = await api('POST', '/api/login', { email, password }, { auth: false });
      me = data.user;
      go(me.must_change_password ? '#/password' : '#/');
    } catch (err) {
      msg.append(errorBox(err.message));
      btn.disabled = false;
    }
  });
  appEl.append(h('div', { class: 'login' },
    stampMark('stamp-lg'),
    h('h1', { text: 'Family Address Book' }),
    h('p', { class: 'lede', text: 'Addresses for the whole family, kept in one place. Only invited family members can log in.' }),
    form,
    h('p', { class: 'aside', text: 'Forgotten your password? Ask the person who looks after this address book to reset it.' })));
}

function viewPassword() {
  const forced = !!me.must_change_password;
  const msg = h('div', { class: 'msg' });
  const form = h('form', { novalidate: true, class: 'panel' },
    forced ? h('p', { class: 'notice info', text: 'Please choose your own password before continuing.' }) : null,
    field({ id: 'current_password', label: 'Current password', type: 'password', autocomplete: 'current-password', required: true }),
    field({ id: 'new_password', label: 'New password', type: 'password', autocomplete: 'new-password', required: true, hint: 'At least 8 characters.' }),
    field({ id: 'confirm_password', label: 'Repeat new password', type: 'password', autocomplete: 'new-password', required: true }),
    msg,
    h('div', { class: 'actions' },
      h('button', { type: 'submit', class: 'primary', text: 'Change password' }),
      forced ? h('button', { type: 'button', onclick: logout, text: 'Log out' }) : h('a', { class: 'btn', href: '#/', text: 'Cancel' })));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    const cur = form.elements.current_password.value;
    const next = form.elements.new_password.value;
    const rep = form.elements.confirm_password.value;
    const errs = {};
    if (!cur) errs.current_password = 'Enter your current password.';
    if (next.length < 8) errs.new_password = 'Password must be at least 8 characters.';
    else if (next.length > 200) errs.new_password = 'Password must be at most 200 characters.';
    else if (next === cur) errs.new_password = 'New password must be different from the current one.';
    if (rep !== next) errs.confirm_password = 'Passwords do not match.';
    for (const n of ['current_password', 'new_password', 'confirm_password']) setFieldError(form, n, errs[n]);
    if (Object.keys(errs).length) return;
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      await api('POST', '/api/password', { current_password: cur, new_password: next });
      me.must_change_password = false;
      go('#/');
    } catch (err) {
      msg.append(errorBox(err.message));
      btn.disabled = false;
    }
  });
  appEl.append(h('div', { class: 'narrow-page' }, h('h1', { text: 'Change password' }), form));
}

async function viewList() {
  const status = h('p', { class: 'count', role: 'status' });
  const listEl = h('ul', { class: 'list' });
  const emptyEl = h('div', { class: 'empty', hidden: true });
  const groupSel = h('select', { id: 'group', name: 'group' }, h('option', { value: '', text: 'All groups' }));
  const qInput = h('input', { id: 'q', name: 'q', type: 'search', value: listState.q, placeholder: 'Name, city, PIN or phone', autocomplete: 'off', enterkeyhint: 'search' });
  const selCount = h('span', { class: 'sel-count', 'aria-live': 'polite' });
  const selBar = h('div', { class: 'selbar', role: 'region', 'aria-label': 'Selected addresses', hidden: true },
    h('div', { class: 'selbar-inner' },
      selCount,
      h('button', { type: 'button', class: 'quiet', text: 'Clear', onclick: () => { selected.clear(); draw(); } }),
      h('a', { class: 'btn print', href: '#/labels' }, icon('printer'), h('span', { text: 'Print labels' }))));
  const selectAll = h('button', { type: 'button', class: 'quiet', text: 'Select all shown', onclick: () => { current.forEach((a) => selected.add(a.id)); draw(); } });
  let groupsLoaded = false;
  let seq = 0;
  let current = [];

  const updateTicks = () => {
    selCount.textContent = `${selected.size} selected`;
    selBar.hidden = selected.size === 0;
    appEl.classList.toggle('has-selection', selected.size > 0);
  };

  const row = (a) => {
    const name = fullName(a);
    const on = selected.has(a.id);
    const cb = h('input', { type: 'checkbox', checked: on ? true : undefined, 'aria-label': `Select ${name}` });
    const li = h('li', { class: on ? 'entry-card is-selected' : 'entry-card' });
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(a.id); else selected.delete(a.id);
      li.classList.toggle('is-selected', cb.checked);
      updateTicks();
    });
    const street = [a.address_line1, a.address_line2].filter(Boolean).join(', ');
    const place = [a.city, a.pin].filter(Boolean).join(' ');
    li.append(
      h('label', { class: 'tick' }, cb),
      h('div', { class: 'entry-body' },
        h('a', { class: 'entry', href: `#/edit/${a.id}` }, h('b', { text: name })),
        street ? h('span', { class: 'entry-line', text: street }) : null,
        h('span', { class: 'entry-line', text: place }),
        h('div', { class: 'entry-meta' },
          a.phone ? h('a', { class: 'tel', href: `tel:${a.phone}`, 'aria-label': `Call ${name}, ${a.phone}` }, icon('phone'), h('span', { text: a.phone })) : null,
          a.group_name ? h('span', { class: 'tag', text: a.group_name }) : null,
          h('span', { class: 'added', text: `Added by ${a.created_by_name || 'unknown'}` }))),
      icon('right', 'icon chev'));
    return li;
  };

  const filtering = () => !!(listState.q.trim() || listState.group);

  const draw = () => {
    clear(listEl);
    for (const a of current) listEl.append(row(a));
    clear(emptyEl);
    emptyEl.hidden = current.length > 0;
    selectAll.hidden = current.length === 0;
    if (current.length) {
      status.textContent = filtering() ? `${plural(current.length, 'address', 'addresses')} found` : plural(current.length, 'address', 'addresses');
    } else if (filtering()) {
      status.textContent = 'No addresses match your search.';
      emptyEl.append(
        h('p', { text: 'Check the spelling, or try part of a name, a city, a PIN or a phone number.' }),
        h('button', { type: 'button', text: 'Clear search', onclick: () => {
          listState.q = ''; listState.group = ''; qInput.value = ''; groupSel.value = ''; load(); qInput.focus();
        } }));
    } else {
      status.textContent = 'No addresses yet.';
      emptyEl.append(icon('envelope', 'icon empty-icon'),
        h('p', { text: 'Add the first one and everyone in the family will see it.' }),
        h('a', { class: 'btn primary', href: '#/new', text: 'Add the first address' }));
    }
    updateTicks();
  };

  const load = async () => {
    const my = ++seq;
    const params = new URLSearchParams();
    if (listState.q.trim()) params.set('q', listState.q.trim());
    if (listState.group) params.set('group', listState.group);
    try {
      const data = await api('GET', `/api/addresses?${params}`);
      if (my !== seq) return;
      current = data.addresses || [];
      if (!groupsLoaded || (data.groups || []).length !== groupSel.options.length - 1) {
        clear(groupSel);
        groupSel.append(h('option', { value: '', text: 'All groups' }));
        for (const g of data.groups || []) groupSel.append(h('option', { value: g, text: g }));
        groupSel.value = listState.group;
        groupsLoaded = true;
      }
      draw();
    } catch (err) {
      if (my === seq) status.textContent = err.message;
    }
  };

  let timer;
  qInput.addEventListener('input', () => {
    listState.q = qInput.value;
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  });
  groupSel.addEventListener('change', () => { listState.group = groupSel.value; load(); });

  appEl.append(
    h('div', { class: 'page-head' },
      h('h1', { text: 'Addresses' }),
      h('a', { class: 'btn primary', href: '#/new' }, icon('plus'), h('span', { text: 'Add address' }))),
    h('div', { class: 'filters', role: 'search' },
      h('div', { class: 'field' }, h('label', { for: 'q', text: 'Search' }), qInput),
      h('div', { class: 'field' }, h('label', { for: 'group', text: 'Group' }), groupSel)),
    h('div', { class: 'list-head' }, status, selectAll),
    listEl, emptyEl, selBar);
  updateTicks();
  await load();
}

const FIELD_ORDER = ['first_name', 'surname', 'address_line1', 'address_line2', 'landmark', 'city', 'state', 'pin', 'phone', 'email', 'group_name', 'notes'];

async function viewForm(id) {
  let existing = null;
  let groups = [];
  try {
    if (id) existing = (await api('GET', `/api/addresses/${encodeURIComponent(id)}`)).address;
    groups = (await api('GET', '/api/addresses')).groups || [];
  } catch (err) {
    appEl.append(h('h1', { text: id ? 'Edit address' : 'Add address' }), errorBox(err.message), h('a', { href: '#/', text: 'Back to list' }));
    return;
  }
  const v = existing || {};
  const msg = h('div', { class: 'msg' });
  const dupBox = h('div');
  const dl = h('datalist', { id: 'group-options' }, groups.map((g) => h('option', { value: g })));
  const val = (f) => (v[f] == null ? '' : String(v[f]));
  const pair = (...fields) => h('div', { class: 'pair' }, ...fields);
  const group = (legend, ...kids) => h('fieldset', null, h('legend', { text: legend }), ...kids);

  const form = h('form', { novalidate: true, class: 'panel' },
    h('p', { class: 'hint form-hint', text: 'Fields marked * are required.' }),
    group('Name',
      pair(
        field({ id: 'first_name', label: 'First name', value: val('first_name'), autocomplete: 'given-name', required: true, maxlength: 100 }),
        field({ id: 'surname', label: 'Surname', value: val('surname'), autocomplete: 'family-name', maxlength: 100 }))),
    group('Postal address',
      field({ id: 'address_line1', label: 'Address line 1', value: val('address_line1'), autocomplete: 'address-line1', required: true, maxlength: 200 }),
      field({ id: 'address_line2', label: 'Address line 2', value: val('address_line2'), autocomplete: 'address-line2', maxlength: 200 }),
      field({ id: 'landmark', label: 'Landmark', value: val('landmark'), autocomplete: 'off', maxlength: 200 }),
      pair(
        field({ id: 'city', label: 'City', value: val('city'), autocomplete: 'address-level2', required: true, maxlength: 100 }),
        field({ id: 'state', label: 'State', value: val('state'), autocomplete: 'address-level1', required: true, maxlength: 100 })),
      field({ id: 'pin', label: 'PIN code', value: val('pin'), autocomplete: 'postal-code', inputmode: 'numeric', required: true, maxlength: 6, cls: 'short' })),
    group('Contact',
      field({ id: 'phone', label: 'Phone', type: 'tel', value: val('phone'), autocomplete: 'tel', inputmode: 'tel', required: true, hint: '10 digits; +91 or a leading 0 is fine.' }),
      field({ id: 'email', label: 'Email', type: 'email', value: val('email'), autocomplete: 'email', inputmode: 'email' })),
    group('Group and notes',
      field({ id: 'group_name', label: 'Group', value: val('group_name'), autocomplete: 'off', list: 'group-options', maxlength: 50, hint: 'For example Family or Friends.' }),
      field({ id: 'notes', label: 'Notes', value: val('notes'), textarea: true, maxlength: 1000 })),
    dl, dupBox, msg,
    h('div', { class: 'actions' },
      h('button', { type: 'submit', class: 'primary', id: 'save-btn', text: existing ? 'Save changes' : 'Save address' }),
      h('a', { class: 'btn', href: '#/', text: 'Cancel' })));

  const collect = () => {
    const out = {};
    for (const f of FIELD_ORDER) out[f] = form.elements[f].value;
    return out;
  };

  const submit = async (confirmDuplicate) => {
    clear(msg);
    if (!confirmDuplicate) clear(dupBox);
    const body = collect();
    const errs = validateAddress(body);
    for (const f of FIELD_ORDER) setFieldError(form, f, errs[f]);
    const firstBad = FIELD_ORDER.find((f) => errs[f]);
    if (firstBad) { form.elements[firstBad].focus(); return; }
    if (confirmDuplicate) body.confirm_duplicate = true;
    const btn = document.getElementById('save-btn'); btn.disabled = true;
    try {
      if (existing) await api('PUT', `/api/addresses/${existing.id}`, body);
      else await api('POST', '/api/addresses', body);
      go('#/');
    } catch (err) {
      btn.disabled = false;
      if (err.status === 409 && err.code === 'duplicate_phone') {
        showDuplicate(err.data.existing || {});
      } else if (err.status === 400 && err.code === 'validation') {
        const fields = err.data.fields || {};
        for (const f of FIELD_ORDER) setFieldError(form, f, fields[f]);
        const bad = FIELD_ORDER.find((f) => fields[f]);
        if (bad) form.elements[bad].focus();
        msg.append(errorBox(err.message));
      } else if (err.status !== 401) {
        msg.append(errorBox(err.message));
      }
    }
  };

  const showDuplicate = (ex) => {
    clear(dupBox);
    const name = fullName(ex);
    dupBox.append(h('div', { class: 'warn', role: 'alert' },
      h('p', { class: 'warn-title' }, icon('alert'), h('b', { text: 'This phone number is already in the address book.' })),
      h('p', { class: 'warn-entry', text: `${name || 'Existing entry'}${ex.city ? `, ${ex.city}` : ''}${ex.phone ? ` (${ex.phone})` : ''}` }),
      h('p', { text: 'If this is a different person who shares the number, you can save anyway.' }),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'warn-btn', onclick: () => submit(true), text: 'Save anyway' }),
        h('button', { type: 'button', onclick: () => clear(dupBox), text: 'Go back and edit' }),
        ex.id ? h('a', { class: 'btn quiet', href: `#/edit/${ex.id}`, text: 'View existing entry' }) : null)));
    dupBox.scrollIntoView({ block: 'center' });
  };

  form.addEventListener('submit', (e) => { e.preventDefault(); submit(false); });

  const head = h('div', { class: 'form-head' }, h('h1', { text: existing ? 'Edit address' : 'Add address' }));
  if (existing) head.append(h('p', { class: 'added', text: `Added by ${existing.created_by_name || 'unknown'}` }));
  appEl.append(head, form);
  if (existing && me.role === 'owner') appEl.append(deleteBlock(existing));
}

function deleteBlock(a) {
  const box = h('div', { class: 'actions' });
  const ask = () => {
    clear(box);
    box.append(
      h('p', { class: 'confirm-text', role: 'alert', text: 'Delete this address? It will be removed from the list.' }),
      h('button', { type: 'button', class: 'danger', text: 'Yes, delete', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api('DELETE', `/api/addresses/${a.id}`);
          selected.delete(a.id);
          go('#/');
        } catch (err) {
          clear(box);
          box.append(errorBox(err.message));
          box.append(h('button', { type: 'button', class: 'danger-outline', text: 'Delete...', onclick: ask }));
        }
      } }),
      h('button', { type: 'button', text: 'Cancel', onclick: reset }));
    box.querySelector('button.danger').focus();
  };
  const reset = () => { clear(box); box.append(h('button', { type: 'button', class: 'danger-outline', text: 'Delete this address...', onclick: ask })); };
  reset();
  return h('section', { class: 'danger-zone', 'aria-labelledby': 'owner-actions-h' },
    h('h2', { id: 'owner-actions-h', text: 'Owner actions' }),
    h('p', { class: 'hint', text: 'Only you can delete. Deleted addresses disappear for everyone.' }),
    box);
}

async function viewLabels() {
  let all;
  try {
    all = (await api('GET', '/api/addresses')).addresses || [];
  } catch (err) {
    appEl.append(h('h1', { text: 'Print labels' }), errorBox(err.message));
    return;
  }
  const params = new URLSearchParams();
  if (listState.q.trim()) params.set('q', listState.q.trim());
  if (listState.group) params.set('group', listState.group);
  let filtered = all;
  if (params.toString()) {
    try { filtered = (await api('GET', `/api/addresses?${params}`)).addresses || []; } catch { filtered = all; }
  }
  const tickedList = all.filter((a) => selected.has(a.id));
  const filterDesc = params.toString()
    ? `Current search/filter (${filtered.length})` : `Everything in the current list (${filtered.length})`;

  // Remembered layout: a preset id or "custom", plus the text of the custom fields.
  const prefs = loadLayoutPrefs();
  const customValues = prefs && prefs.custom ? prefs.custom : layoutToValues(presetById(UI_DEFAULT_ID));
  const shiftValues = { x: prefs ? prefs.shiftX : '0', y: prefs ? prefs.shiftY : '0' };
  let layoutId = prefs && prefs.id ? prefs.id : UI_DEFAULT_ID;
  if (layoutId === CUSTOM_ID && !validateLayout(customLayout(customValues)).ok) layoutId = UI_DEFAULT_ID;
  const save = () => saveLayoutPrefs(layoutId, customValues, shiftValues.x, shiftValues.y);
  /** The layout in force, and whether it is usable (a custom layout can be mid-edit and invalid). */
  const currentLayout = () => (layoutId === CUSTOM_ID ? customLayout(customValues) : presetById(layoutId));
  const currentCheck = () => validateLayout(currentLayout());
  const perNow = () => (currentCheck().ok ? perSheet(currentLayout()) : 0);

  const msg = h('div', { class: 'msg' });
  const startInput = h('input', { id: 'start_at', type: 'number', inputmode: 'numeric', min: 1, max: 21, value: 1, 'aria-describedby': 'start-hint' });
  const startLabel = h('label', { for: 'start_at' });
  const phoneBox = h('input', { type: 'checkbox', id: 'include_phone' });
  const outlineBox = h('input', { type: 'checkbox', id: 'outlines' });
  const preferTicked = tickedList.length > 0;
  const modeFilter = h('input', { type: 'radio', name: 'mode', id: 'mode-filter', value: 'filter', checked: preferTicked ? undefined : true });
  const modeTicked = h('input', { type: 'radio', name: 'mode', id: 'mode-ticked', value: 'ticked', checked: preferTicked ? true : undefined });
  if (!tickedList.length && selected.size === 0) modeTicked.setAttribute('aria-describedby', 'ticked-hint');
  const btn = h('button', { type: 'submit', class: 'primary', text: 'Download PDF' });
  const xlsxBtn = h('button', { type: 'button', id: 'labels-export-xlsx', text: 'Export these addresses to Excel' });

  // Layout chooser.
  const layoutSel = h('select', { id: 'layout', name: 'layout', 'aria-describedby': 'layout-desc' },
    CHOOSER_PRESETS.map((p) => h('option', { value: p.id, text: p.name })),
    h('option', { value: CUSTOM_ID, text: 'Custom (enter your own sizes)' }));
  layoutSel.value = layoutId;
  const layoutDesc = h('p', { class: 'hint', id: 'layout-desc' });
  const customBox = h('div', { class: 'custom-sheet', id: 'custom-sheet', hidden: layoutId !== CUSTOM_ID },
    h('p', { class: 'hint', id: 'custom-hint', text: 'Measure your sticker sheet in millimetres. Decimals are fine. The left margin is the space from the paper edge to the first label.' }),
    h('div', { class: 'custom-grid' },
      LAYOUT_FIELDS.map(({ key, label, integer }) => field({
        id: `custom_${key}`, label, type: 'number', step: integer ? 1 : 'any', min: 0,
        inputmode: integer ? 'numeric' : 'decimal', value: customValues[key], cls: 'num',
      }))));

  // On-screen preview of sheet 1 (pure DOM; the PDF is built separately by buildPdf).
  // Slot positions are CSS custom properties (set through the CSSOM, which the page's CSP allows) in % of the A4 page.
  let slots = [];
  const sheet = h('div', { class: 'sheet', 'aria-hidden': 'true' });
  const sheetNote = h('p', { class: 'sheet-note', id: 'sheet-note', 'aria-live': 'polite' });
  const renderSheet = () => {
    clear(sheet);
    slots = [];
    const layout = currentLayout();
    sheet.dataset.cols = currentCheck().ok ? String(layout.cols) : '0';
    sheet.dataset.rows = currentCheck().ok ? String(layout.rows) : '0';
    if (!currentCheck().ok) return;
    const pct = (mm, of) => `${((mm / of) * 100).toFixed(3)}%`;
    for (let i = 0; i < perSheet(layout); i++) {
      const r = labelRect(i, layout);
      const slot = h('div', { class: 'slot', 'data-slot': i + 1 }, h('span', { class: 'slot-n', text: String(i + 1) }), h('span', { class: 'slot-name' }));
      slot.style.setProperty('--x', pct(r.x, PAGE_W));
      slot.style.setProperty('--y', pct(r.y, PAGE_H));
      slot.style.setProperty('--w', pct(r.w, PAGE_W));
      slot.style.setProperty('--h', pct(r.h, PAGE_H));
      slot.addEventListener('click', () => { startInput.value = String(i + 1); updatePreview(); });
      slots.push(slot);
      sheet.append(slot);
    }
  };

  const updatePreview = () => {
    const list = modeTicked.checked ? tickedList : filtered;
    const per = perNow();
    if (!per) { sheetNote.textContent = 'Fix the sheet sizes above to see where the labels go.'; return; }
    const layout = currentLayout();
    const raw = startInput.value.trim();
    const start = Number(raw);
    const valid = /^\d+$/.test(raw) && start >= 1 && start <= per;
    const plan = valid ? planLabels(list.length, start, layout) : [];
    const onSheet1 = new Map(plan.map((p, i) => [p, i]).filter(([p]) => p.sheet === 0).map(([p, i]) => [p.slot, list[i]]));
    slots.forEach((el, idx) => {
      const a = onSheet1.get(idx);
      el.classList.toggle('is-used', valid && idx + 1 < start);
      el.classList.toggle('is-filled', !!a);
      el.lastChild.textContent = a ? fullName(a) : '';
    });
    if (!valid) { sheetNote.textContent = `Enter a label number from 1 to ${per} to see where the labels go.`; return; }
    if (!list.length) { sheetNote.textContent = modeTicked.checked ? 'No addresses are selected yet.' : 'There are no addresses to print.'; return; }
    const first = onSheet1.size;
    const sheets = plan[plan.length - 1].sheet + 1;
    const span = first === 1 ? `label ${start}` : `labels ${start} to ${start + first - 1}`;
    let note = `Sheet 1: ${span} will be printed.`;
    if (start > 1) note += ` Labels 1 to ${start - 1} stay blank.`;
    if (sheets > 1) note += ` ${plural(list.length - first, 'more label goes', 'more labels go')} on ${sheets === 2 ? 'sheet 2' : `sheets 2 to ${sheets}`}.`;
    sheetNote.textContent = note;
  };

  /** Called whenever the chosen layout (or a custom value) changes. */
  const applyLayout = ({ clampStart } = {}) => {
    const check = currentCheck();
    const per = perNow();
    layoutDesc.textContent = check.ok ? describeLayout(currentLayout()) : 'Fix the sizes below to continue.';
    customBox.hidden = layoutId !== CUSTOM_ID;
    startLabel.textContent = per ? `Start at label (1 to ${per})` : 'Start at label';
    startInput.max = String(per || 1);
    if (per && clampStart) {
      const n = Number(startInput.value);
      if (Number.isFinite(n) && n > per) startInput.value = String(per);
    }
    renderSheet();
    updatePreview();
  };

  const showCustomErrors = () => {
    const errs = layoutId === CUSTOM_ID ? currentCheck().errors : {};
    for (const { key } of LAYOUT_FIELDS) setFieldError(form, `custom_${key}`, errs[key]);
  };

  layoutSel.addEventListener('change', () => {
    const prev = currentLayout();
    layoutId = layoutSel.value;
    if (layoutId === CUSTOM_ID && validateLayout(prev).ok) {
      // Switching to Custom: start from the sheet that was selected, so only the differences need typing.
      Object.assign(customValues, layoutToValues(prev));
      for (const { key } of LAYOUT_FIELDS) form.elements[`custom_${key}`].value = customValues[key];
    }
    save();
    showCustomErrors();
    applyLayout({ clampStart: true });
  });
  startInput.addEventListener('input', updatePreview);
  modeFilter.addEventListener('change', updatePreview);
  modeTicked.addEventListener('change', updatePreview);

  const form = h('form', { novalidate: true, class: 'panel labels-form' },
    h('div', { class: 'labels-opts' },
      h('fieldset', null,
        h('legend', { text: 'Label sheet' }),
        h('div', { class: 'field' },
          h('label', { for: 'layout', text: 'Sheet layout' }),
          layoutSel,
          layoutDesc),
        customBox,
        h('div', { class: 'nudge' },
          h('p', { class: 'hint', id: 'shift-hint', text: 'Fine-tune: if your printer feeds the paper slightly off, move everything a little. Between -5 and 5 mm; minus moves left or up. Leave at 0 otherwise.' }),
          h('div', { class: 'custom-grid' },
            field({ id: 'shift_x', label: 'Shift right (mm)', type: 'number', step: 'any', min: -5, inputmode: 'decimal', value: shiftValues.x, cls: 'num' }),
            field({ id: 'shift_y', label: 'Shift down (mm)', type: 'number', step: 'any', min: -5, inputmode: 'decimal', value: shiftValues.y, cls: 'num' })))),
      h('fieldset', null,
        h('legend', { text: 'Which addresses' }),
        h('label', { class: 'check choice', for: 'mode-filter' }, modeFilter, h('span', { text: filterDesc })),
        h('label', { class: 'check choice', for: 'mode-ticked' }, modeTicked, h('span', { text: `Only selected addresses (${tickedList.length})` })),
        h('p', { class: 'hint', id: 'ticked-hint', text: 'Select addresses on the Addresses page. To change the search or group, go back to the list.' })),
      h('fieldset', null,
        h('legend', { text: 'Options' }),
        h('div', { class: 'field short' },
          startLabel,
          h('div', { class: 'hint', id: 'start-hint', text: 'To reuse a partly used sheet, enter the first empty label, or tap it on the picture. Applies to the first sheet only.' }),
          startInput),
        h('label', { class: 'check', for: 'include_phone' }, phoneBox, h('span', { text: 'Include phone number' })),
        h('label', { class: 'check', for: 'outlines' }, outlineBox, h('span', { text: 'Draw label outlines (for a test print on plain paper)' })))),
    h('figure', { class: 'sheet-figure' },
      h('div', { class: 'sheet-wrap' }, sheet),
      h('figcaption', null, sheetNote)),
    h('div', { class: 'labels-act' },
      msg,
      h('div', { class: 'actions' }, btn),
      h('p', { class: 'hint print-hint', id: 'print-hint', text: 'When you print, choose 100% or “Actual size”, not “Fit to page”, or the labels will not line up with the stickers.' }),
      h('div', { class: 'actions' }, xlsxBtn, h('a', { class: 'btn', href: '#/', text: 'Back to list' }))));
  btn.setAttribute('aria-describedby', 'print-hint');

  // Custom values: remember them, check them as the user types.
  for (const { key } of LAYOUT_FIELDS) {
    form.elements[`custom_${key}`].addEventListener('input', (e) => {
      customValues[key] = e.target.value;
      save();
      showCustomErrors();
      applyLayout({ clampStart: false });
    });
  }

  const showShiftErrors = () => {
    const sh = parseShift(shiftValues.x, shiftValues.y);
    setFieldError(form, 'shift_x', sh.errors.x);
    setFieldError(form, 'shift_y', sh.errors.y);
    return sh;
  };
  for (const axis of ['x', 'y']) {
    form.elements[`shift_${axis}`].addEventListener('input', (e) => {
      shiftValues[axis] = e.target.value;
      save();
      showShiftErrors();
    });
  }

  /** Check the layout and the start label. Returns the numbers to print with, or null after showing a message. */
  const checkInputs = () => {
    const check = currentCheck();
    if (!check.ok) {
      showCustomErrors();
      const bad = LAYOUT_FIELDS.find(({ key }) => check.errors[key]);
      msg.append(errorBox(`Fix the sheet sizes first. ${check.message}`));
      if (bad && layoutId === CUSTOM_ID) form.elements[`custom_${bad.key}`].focus();
      return null;
    }
    const sh = showShiftErrors();
    if (!sh.ok) {
      msg.append(errorBox(`Fix the fine-tune shift first. ${sh.errors.x || sh.errors.y}`));
      form.elements[sh.errors.x ? 'shift_x' : 'shift_y'].focus();
      return null;
    }
    const per = perSheet(currentLayout());
    const startRaw = startInput.value.trim();
    const start = Number(startRaw);
    if (!/^\d+$/.test(startRaw) || start < 1 || start > per) {
      msg.append(errorBox(`Start label must be a whole number from 1 to ${per}.`));
      return null;
    }
    return { layout: currentLayout(), start, shift: sh.shift };
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clear(msg);
    const list = modeTicked.checked ? tickedList : filtered;
    if (!list.length) { msg.append(errorBox(modeTicked.checked ? 'No addresses are selected.' : 'There are no addresses to print.')); return; }
    const ok = checkInputs();
    if (!ok) return;
    const lib = window.jspdf && window.jspdf.jsPDF;
    if (!lib) { msg.append(errorBox('The PDF library did not load. Reload the page and try again.')); return; }
    try {
      const sheets = buildPdf(lib, list, ok.start, phoneBox.checked, ok.layout, outlineBox.checked, ok.shift);
      msg.append(h('p', { class: 'notice', role: 'status', text: `Created address-labels.pdf: ${list.length} label${list.length === 1 ? '' : 's'} on ${sheets} sheet${sheets === 1 ? '' : 's'}.` }));
    } catch (err) {
      msg.append(errorBox(`Could not create the PDF: ${err.message}`));
    }
  });

  // Exactly the set that would be printed: the selected addresses, or the current search/filter.
  xlsxBtn.addEventListener('click', () => {
    clear(msg);
    const list = modeTicked.checked ? tickedList : filtered;
    if (!list.length) { msg.append(errorBox(modeTicked.checked ? 'No addresses are selected.' : 'There are no addresses to export.')); return; }
    const subset = modeTicked.checked || list.length !== all.length;
    const name = subset ? 'addresses-selected.xlsx' : 'addresses.xlsx';
    try {
      downloadXlsx(list, name);
      msg.append(h('p', { class: 'notice', role: 'status', text: `Created ${name}: ${plural(list.length, 'address', 'addresses')}.` }));
    } catch (err) {
      msg.append(errorBox(`Could not create the Excel file: ${err.message}`));
    }
  });

  appEl.append(h('h1', { text: 'Print labels' }),
    h('p', { class: 'lede', text: 'Print addresses onto A4 sticker sheets. Pick the sheet you bought, then download the PDF.' }),
    form);
  applyLayout({ clampStart: false });
  showCustomErrors();
}

/** Draw a thin light-grey rectangle around every label slot of the current page. */
function drawOutlines(doc, layout, shift) {
  doc.setDrawColor(190);
  doc.setLineWidth(0.2);
  for (let i = 0; i < perSheet(layout); i++) {
    const r = labelRect(i, layout, shift);
    doc.rect(r.x, r.y, r.w, r.h, 'S');
  }
}

function buildPdf(JsPDF, list, startAt, includePhone, layout = DEFAULT_LAYOUT, outlines = false, shift = { x: 0, y: 0 }) {
  const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const measure = (text, size, bold) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    return doc.getTextWidth(text);
  };
  const pad = labelPadding(layout);
  const startSize = startFontSize(layout);
  const plan = planLabels(list.length, startAt, layout);
  let sheet = 0;
  if (outlines) drawOutlines(doc, layout, shift);
  list.forEach((a, i) => {
    const { sheet: s, slot } = plan[i];
    while (sheet < s) {
      doc.addPage('a4', 'portrait');
      sheet += 1;
      if (outlines) drawOutlines(doc, layout, shift);
    }
    const r = labelRect(slot, layout, shift);
    const fit = fitText(addressLines(a, { includePhone }), measure, r.w - 2 * pad, r.h - 2 * pad, startSize, 5);
    const lh = lineHeightMm(fit.size);
    fit.lines.forEach((line, n) => {
      doc.setFont('helvetica', line.bold ? 'bold' : 'normal');
      doc.setFontSize(fit.size);
      doc.text(line.text, r.x + pad, r.y + pad + n * lh, { baseline: 'top' });
    });
  });
  doc.save('address-labels.pdf');
  return sheet + 1;
}

async function viewUsers() {
  const holder = h('div');
  const secretHolder = h('div');
  const msg = h('div', { class: 'msg' });
  let users = [];

  const showSecret = (title, user, password) => {
    clear(secretHolder);
    const input = h('input', { type: 'text', readonly: true, value: password, id: 'secret-pw', 'aria-label': 'Generated password', autocomplete: 'off', spellcheck: 'false' });
    const status = h('span', { class: 'copy-status', role: 'status' });
    secretHolder.append(h('div', { class: 'secret', role: 'alert' },
      h('h2', { text: title }),
      h('p', null, 'Password for ', h('strong', { text: user.name }), ` (${user.email}):`),
      input,
      h('p', { class: 'once' }, h('b', { text: 'This will not be shown again.' }), ' Copy it now and pass it on. They will be asked to choose their own password at first login.'),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'primary', text: 'Copy password', onclick: async () => {
          status.textContent = (await copyText(password, input)) ? 'Copied.' : 'Copy failed. Select the password and copy it by hand.';
        } }),
        h('button', { type: 'button', text: 'I have saved it', onclick: () => clear(secretHolder) }),
        status)));
    secretHolder.scrollIntoView({ block: 'start' });
  };

  const act = async (u, action) => {
    clear(msg);
    try {
      const data = await api('POST', `/api/users/${u.id}/${action}`, {});
      if (action === 'reset-password') showSecret('New password', data.user, data.password);
      await load();
    } catch (err) {
      msg.append(errorBox(err.message));
    }
  };

  const userRow = (u) => {
    const actions = h('div', { class: 'actions' });
    const resetBtn = () => h('button', { type: 'button', class: 'small', text: 'Reset password...', onclick: () => {
      clear(actions);
      actions.append(
        h('span', { class: 'confirm-text', text: `Reset password for ${u.name}? Their current password stops working.` }),
        h('button', { type: 'button', class: 'danger small', text: 'Yes, reset', onclick: () => act(u, 'reset-password') }),
        h('button', { type: 'button', class: 'small', text: 'Cancel', onclick: () => renderActions() }));
    } });
    const renderActions = () => {
      clear(actions);
      if (me.role !== 'owner') return;
      if (u.role !== 'owner') {
        actions.append(u.disabled
          ? h('button', { type: 'button', class: 'small', text: 'Enable', onclick: () => act(u, 'enable') })
          : h('button', { type: 'button', class: 'danger-outline small', text: 'Disable', onclick: () => act(u, 'disable') }));
      }
      actions.append(resetBtn());
    };
    renderActions();
    return h('li', { class: u.disabled ? 'user is-disabled' : 'user' },
      h('div', { class: 'user-head' },
        h('b', { class: 'user-name', text: u.name }),
        u.role === 'owner' ? h('span', { class: 'tag', text: 'owner' }) : null,
        u.disabled ? h('span', { class: 'tag off', text: 'disabled' }) : null,
        u.must_change_password ? h('span', { class: 'tag pending', text: 'password change pending' }) : null),
      h('div', { class: 'user-email', text: u.email }),
      u.disabled ? h('p', { class: 'hint', text: 'Cannot log in until enabled again.' }) : null,
      me.role === 'owner' ? h('div', { class: 'owner-actions' }, h('span', { class: 'owner-label', text: 'Owner actions' }), actions) : null);
  };

  const load = async () => {
    try {
      users = (await api('GET', '/api/users')).users || [];
      clear(holder);
      holder.append(h('ul', { class: 'list users' }, users.map(userRow)));
    } catch (err) {
      clear(holder);
      holder.append(errorBox(err.message));
    }
  };

  const addMsg = h('div', { class: 'msg' });
  const form = h('form', { novalidate: true, class: 'panel' },
    h('h2', { text: 'Add a user' }),
    h('p', { class: 'hint', text: 'Add a family member who should be able to log in. A password is created for them and shown once, for you to pass on. Users can be disabled later, but not deleted.' }),
    field({ id: 'name', label: 'Name', autocomplete: 'off', required: true, maxlength: 100 }),
    field({ id: 'new_email', label: 'Email', type: 'email', autocomplete: 'off', inputmode: 'email', required: true }),
    addMsg,
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary', text: 'Add user' })));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(addMsg); clear(secretHolder);
    const name = form.elements.name.value.trim();
    const email = form.elements.new_email.value.trim();
    const errs = {};
    if (!name) errs.name = 'Name is required.';
    else if (name.length > 100) errs.name = 'Name is too long (max 100).';
    if (!isValidEmail(email)) errs.new_email = 'A valid email is required.';
    setFieldError(form, 'name', errs.name);
    setFieldError(form, 'new_email', errs.new_email);
    if (Object.keys(errs).length) return;
    const btn = form.querySelector('button'); btn.disabled = true;
    try {
      const data = await api('POST', '/api/users', { name, email });
      form.reset();
      showSecret('User added', data.user, data.password);
      await load();
    } catch (err) {
      if (err.status === 400 && err.data.fields) {
        setFieldError(form, 'name', err.data.fields.name);
        setFieldError(form, 'new_email', err.data.fields.email);
      }
      addMsg.append(errorBox(err.message));
    }
    btn.disabled = false;
  });

  appEl.append(h('h1', { text: 'Users' }),
    h('p', { class: 'lede', text: 'Everyone here can log in, see every address and add new ones.' }),
    secretHolder, msg, holder, form);
  await load();
}

// ---------- router ----------
async function route() {
  const token = ++renderToken;
  appEl = h('div');
  mainEl.replaceChildren(appEl);
  const hash = location.hash || '#/';

  if (me === null) {
    try {
      me = (await api('GET', '/api/me', undefined, { auth: false })).user;
    } catch { me = null; }
    if (token !== renderToken) return;
  }

  if (!me) {
    renderTop();
    mainEl.className = 'view-login';
    if (hash !== '#/login') { history.replaceState(null, '', '#/login'); }
    viewLogin();
    return;
  }
  if (me.must_change_password && hash !== '#/password') {
    history.replaceState(null, '', '#/password');
    renderTop();
    mainEl.className = 'view-password';
    viewPassword();
    return;
  }
  renderTop();

  const parts = hash.replace(/^#\/?/, '').split('/');
  const name = parts[0];
  mainEl.className = `view-${/^(new|edit|labels|users|password)$/.test(name) ? name : 'list'}`;
  try {
    if (name === 'login') { go('#/'); return; }
    if (name === 'password') viewPassword();
    else if (name === 'new') await viewForm(null);
    else if (name === 'edit' && /^\d+$/.test(parts[1] || '')) await viewForm(parts[1]);
    else if (name === 'labels') await viewLabels();
    else if (name === 'users') await viewUsers();
    else await viewList();
  } catch (err) {
    if (token === renderToken) appEl.append(errorBox(err.message || 'Something went wrong.'));
  }
  if (token === renderToken) {
    const h1 = appEl.querySelector('h1');
    if (h1) { h1.setAttribute('tabindex', '-1'); window.scrollTo(0, 0); }
  }
}

window.addEventListener('hashchange', route);
route();
