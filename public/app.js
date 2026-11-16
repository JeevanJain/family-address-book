// Family Address Book - hash-routed single-page app. No framework.
// All user data is inserted with textContent / DOM APIs only (never innerHTML).
import {
  PER_SHEET, LABEL_W, LABEL_H, labelRect, planLabels, addressLines, fitText, lineHeightMm,
} from '/labels.js';

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

// ---------- shared UI pieces ----------
function renderTop() {
  clear(topEl);
  if (!me || me.must_change_password) { topEl.hidden = true; return; }
  topEl.hidden = false;
  const cur = location.hash || '#/';
  const link = (href, text, match) => h('a', { href, class: match.test(cur) ? 'current' : '' , text });
  topEl.append(h('nav', { 'aria-label': 'Main' },
    link('#/', 'Addresses', /^#\/?$|^#\/edit/),
    link('#/new', 'Add', /^#\/new/),
    link('#/labels', 'Labels', /^#\/labels/),
    link('#/users', 'Users', /^#\/users/),
    h('a', { href: '/api/export.csv', download: 'addresses.csv', text: 'Export CSV' }),
    h('a', { href: '#/password', text: 'Password' }),
    h('button', { type: 'button', class: 'link', onclick: logout, text: 'Log out' }),
    h('span', { class: 'who', text: `Signed in as ${me.name}${me.role === 'owner' ? ' (owner)' : ''}` })));
}

async function logout() {
  try { await api('POST', '/api/logout', {}, { auth: false }); } catch { /* ignore */ }
  me = null;
  selected.clear();
  go('#/login');
}

function errorBox(msg) { return h('p', { class: 'error', role: 'alert', text: msg }); }

function field({ id, label, type = 'text', value = '', autocomplete, inputmode, required, maxlength, list, error, textarea, hint }) {
  const errId = `${id}-err`;
  const attrs = {
    id, name: id, value: textarea ? undefined : value, autocomplete, inputmode, maxlength, list,
    type: textarea ? undefined : type, required: required ? true : undefined,
    'aria-invalid': error ? 'true' : undefined,
    'aria-describedby': error ? errId : undefined,
    autocapitalize: type === 'email' ? 'off' : undefined,
    spellcheck: type === 'email' || type === 'password' ? 'false' : undefined,
  };
  const input = textarea ? h('textarea', { ...attrs, rows: 3 }) : h('input', attrs);
  if (textarea) input.value = value;
  return h('div', { class: 'field' },
    h('label', { for: id, text: label + (required ? ' *' : '') }),
    hint ? h('div', { class: 'muted', text: hint }) : null,
    input,
    h('div', { class: 'field-error', id: errId, text: error || '' }));
}

function setFieldError(form, name, msg) {
  const input = form.elements[name];
  const err = document.getElementById(`${name}-err`);
  if (err) err.textContent = msg || '';
  if (input) {
    if (msg) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', `${name}-err`); }
    else { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
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

// ---------- views ----------
function viewLogin() {
  const msg = h('div');
  const form = h('form', { novalidate: true },
    field({ id: 'email', label: 'Email', type: 'email', autocomplete: 'username', inputmode: 'email', required: true }),
    field({ id: 'password', label: 'Password', type: 'password', autocomplete: 'current-password', required: true }),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'primary', text: 'Log in' })));
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
  appEl.append(h('h1', { text: 'Family Address Book' }), form, msg);
}

function viewPassword() {
  const forced = !!me.must_change_password;
  const msg = h('div');
  const form = h('form', { novalidate: true },
    forced ? h('p', { class: 'notice', text: 'Please choose your own password before continuing.' }) : null,
    field({ id: 'current_password', label: 'Current password', type: 'password', autocomplete: 'current-password', required: true }),
    field({ id: 'new_password', label: 'New password', type: 'password', autocomplete: 'new-password', required: true, hint: 'At least 8 characters.' }),
    field({ id: 'confirm_password', label: 'Repeat new password', type: 'password', autocomplete: 'new-password', required: true }),
    h('div', { class: 'row' },
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
  appEl.append(h('h1', { text: 'Change password' }), form, msg);
}

function entryLine(a) {
  const place = [a.city, a.pin].filter(Boolean).join(' ');
  return [a.phone, place, a.group_name].filter(Boolean).join(' - ');
}

async function viewList() {
  const status = h('p', { class: 'muted', role: 'status' });
  const listEl = h('ul', { class: 'list' });
  const tickInfo = h('span', { class: 'muted' });
  const groupSel = h('select', { id: 'group', name: 'group' }, h('option', { value: '', text: 'All groups' }));
  const qInput = h('input', { id: 'q', name: 'q', type: 'search', value: listState.q, placeholder: 'Name, city, PIN or phone', autocomplete: 'off', enterkeyhint: 'search' });
  let groupsLoaded = false;
  let seq = 0;
  let current = [];

  const updateTicks = () => {
    tickInfo.textContent = `${selected.size} ticked`;
  };

  const draw = () => {
    clear(listEl);
    for (const a of current) {
      const name = [a.first_name, a.surname].filter(Boolean).join(' ');
      const cb = h('input', { type: 'checkbox', checked: selected.has(a.id) ? true : undefined, 'aria-label': `Tick ${name}` });
      cb.addEventListener('change', () => { if (cb.checked) selected.add(a.id); else selected.delete(a.id); updateTicks(); });
      listEl.append(h('li', null,
        h('span', { class: 'tick' }, cb),
        h('a', { class: 'entry', href: `#/edit/${a.id}` },
          h('b', { text: name }),
          h('span', { text: entryLine(a) }),
          h('small', { text: `Added by ${a.created_by_name || 'unknown'}` }))));
    }
    status.textContent = current.length ? `${current.length} address${current.length === 1 ? '' : 'es'}` : 'No addresses found.';
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
      updateTicks();
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
    h('h1', { text: 'Addresses' }),
    h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/new', text: 'Add address' })),
    h('label', { for: 'q', text: 'Search' }), qInput,
    h('label', { for: 'group', text: 'Group' }), groupSel,
    h('div', { class: 'row' },
      h('button', { type: 'button', text: 'Tick all shown', onclick: () => { current.forEach((a) => selected.add(a.id)); draw(); updateTicks(); } }),
      h('button', { type: 'button', text: 'Clear ticks', onclick: () => { selected.clear(); draw(); updateTicks(); } }),
      tickInfo,
      h('a', { class: 'btn', href: '#/labels', text: 'Print labels' })),
    status, listEl);
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
  const msg = h('div');
  const dupBox = h('div');
  const dl = h('datalist', { id: 'group-options' }, groups.map((g) => h('option', { value: g })));
  const val = (f) => (v[f] == null ? '' : String(v[f]));

  const form = h('form', { novalidate: true },
    field({ id: 'first_name', label: 'First name', value: val('first_name'), autocomplete: 'given-name', required: true, maxlength: 100 }),
    field({ id: 'surname', label: 'Surname', value: val('surname'), autocomplete: 'family-name', maxlength: 100 }),
    field({ id: 'address_line1', label: 'Address line 1', value: val('address_line1'), autocomplete: 'address-line1', required: true, maxlength: 200 }),
    field({ id: 'address_line2', label: 'Address line 2', value: val('address_line2'), autocomplete: 'address-line2', maxlength: 200 }),
    field({ id: 'landmark', label: 'Landmark', value: val('landmark'), autocomplete: 'off', maxlength: 200 }),
    field({ id: 'city', label: 'City', value: val('city'), autocomplete: 'address-level2', required: true, maxlength: 100 }),
    field({ id: 'state', label: 'State', value: val('state'), autocomplete: 'address-level1', required: true, maxlength: 100 }),
    field({ id: 'pin', label: 'PIN code', value: val('pin'), autocomplete: 'postal-code', inputmode: 'numeric', required: true, maxlength: 6 }),
    field({ id: 'phone', label: 'Phone', type: 'tel', value: val('phone'), autocomplete: 'tel', inputmode: 'tel', required: true, hint: '10 digits; +91 or a leading 0 is fine.' }),
    field({ id: 'email', label: 'Email', type: 'email', value: val('email'), autocomplete: 'email', inputmode: 'email' }),
    field({ id: 'group_name', label: 'Group', value: val('group_name'), autocomplete: 'off', list: 'group-options', maxlength: 50, hint: 'For example Family or Friends.' }),
    field({ id: 'notes', label: 'Notes', value: val('notes'), textarea: true, maxlength: 1000 }),
    dl, dupBox, msg,
    h('div', { class: 'row' },
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
    const name = [ex.first_name, ex.surname].filter(Boolean).join(' ');
    dupBox.append(h('div', { class: 'warn', role: 'alert' },
      h('p', null, h('b', { text: 'This phone number is already in the address book.' })),
      h('p', { text: `${name || 'Existing entry'}${ex.city ? `, ${ex.city}` : ''}${ex.phone ? ` (${ex.phone})` : ''}` }),
      h('div', { class: 'row' },
        ex.id ? h('a', { class: 'btn', href: `#/edit/${ex.id}`, text: 'View existing entry' }) : null,
        h('button', { type: 'button', class: 'primary', onclick: () => submit(true), text: 'Save anyway' }),
        h('button', { type: 'button', onclick: () => clear(dupBox), text: 'Go back and edit' }))));
    dupBox.scrollIntoView({ block: 'center' });
  };

  form.addEventListener('submit', (e) => { e.preventDefault(); submit(false); });

  appEl.append(h('h1', { text: existing ? 'Edit address' : 'Add address' }));
  if (existing) {
    appEl.append(h('p', { class: 'muted', text: `Added by ${existing.created_by_name || 'unknown'}` }));
  }
  appEl.append(form);
  if (existing && me.role === 'owner') appEl.append(deleteBlock(existing));
}

function deleteBlock(a) {
  const box = h('div', { class: 'row' });
  const ask = () => {
    clear(box);
    box.append(
      h('p', { class: 'grow', role: 'alert', text: 'Delete this address? It will be removed from the list.' }),
      h('button', { type: 'button', class: 'danger', text: 'Yes, delete', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api('DELETE', `/api/addresses/${a.id}`);
          selected.delete(a.id);
          go('#/');
        } catch (err) {
          clear(box);
          box.append(errorBox(err.message));
          box.append(h('button', { type: 'button', text: 'Delete...', onclick: ask }));
        }
      } }),
      h('button', { type: 'button', text: 'Cancel', onclick: reset }));
  };
  const reset = () => { clear(box); box.append(h('button', { type: 'button', class: 'danger', text: 'Delete this address...', onclick: ask })); };
  reset();
  return h('section', null, h('h2', { text: 'Owner actions' }), box);
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

  const msg = h('div');
  const startInput = h('input', { id: 'start_at', type: 'number', inputmode: 'numeric', min: 1, max: PER_SHEET, value: 1 });
  const phoneBox = h('input', { type: 'checkbox', id: 'include_phone' });
  const modeFilter = h('input', { type: 'radio', name: 'mode', id: 'mode-filter', value: 'filter', checked: true });
  const modeTicked = h('input', { type: 'radio', name: 'mode', id: 'mode-ticked', value: 'ticked' });
  if (!tickedList.length && selected.size === 0) modeTicked.setAttribute('aria-describedby', 'ticked-hint');
  const btn = h('button', { type: 'submit', class: 'primary', text: 'Download PDF' });

  const form = h('form', { novalidate: true },
    h('fieldset', null,
      h('legend', { text: 'Which addresses' }),
      h('label', { class: 'check', for: 'mode-filter' }, modeFilter, h('span', { text: filterDesc })),
      h('label', { class: 'check', for: 'mode-ticked' }, modeTicked, h('span', { text: `Only ticked entries (${tickedList.length})` })),
      h('p', { class: 'muted', id: 'ticked-hint', text: 'Tick entries on the Addresses page. To change the search or group, go back to the list.' })),
    h('label', { for: 'start_at', text: `Start at label (1 to ${PER_SHEET})` }),
    h('div', { class: 'muted', text: 'Use this to reuse a partly used sheet. Applies to the first sheet only.' }),
    startInput,
    h('label', { class: 'check', for: 'include_phone' }, phoneBox, h('span', { text: 'Include phone number' })),
    h('div', { class: 'row' }, btn, h('a', { class: 'btn', href: '#/', text: 'Back to list' })),
    msg);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clear(msg);
    const list = modeTicked.checked ? tickedList : filtered;
    if (!list.length) { msg.append(errorBox(modeTicked.checked ? 'No entries are ticked.' : 'There are no addresses to print.')); return; }
    const startRaw = startInput.value.trim();
    const start = Number(startRaw);
    if (!/^\d+$/.test(startRaw) || start < 1 || start > PER_SHEET) {
      msg.append(errorBox(`Start label must be a whole number from 1 to ${PER_SHEET}.`));
      return;
    }
    const lib = window.jspdf && window.jspdf.jsPDF;
    if (!lib) { msg.append(errorBox('The PDF library did not load. Reload the page and try again.')); return; }
    try {
      const sheets = buildPdf(lib, list, start, phoneBox.checked);
      msg.append(h('p', { class: 'notice', role: 'status', text: `Created address-labels.pdf: ${list.length} label${list.length === 1 ? '' : 's'} on ${sheets} sheet${sheets === 1 ? '' : 's'}.` }));
    } catch (err) {
      msg.append(errorBox(`Could not create the PDF: ${err.message}`));
    }
  });

  appEl.append(h('h1', { text: 'Print labels' }),
    h('p', { class: 'muted', text: `A4 sheets of ${PER_SHEET} labels (Avery L7160, ${LABEL_W} x ${LABEL_H} mm).` }),
    form);
}

const PAD = 3; // mm inner padding

function buildPdf(JsPDF, list, startAt, includePhone) {
  const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const measure = (text, size, bold) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    return doc.getTextWidth(text);
  };
  const plan = planLabels(list.length, startAt);
  let sheet = 0;
  list.forEach((a, i) => {
    const { sheet: s, slot } = plan[i];
    while (sheet < s) { doc.addPage('a4', 'portrait'); sheet += 1; }
    const r = labelRect(slot);
    const fit = fitText(addressLines(a, { includePhone }), measure, r.w - 2 * PAD, r.h - 2 * PAD, 11, 5);
    const lh = lineHeightMm(fit.size);
    fit.lines.forEach((line, n) => {
      doc.setFont('helvetica', line.bold ? 'bold' : 'normal');
      doc.setFontSize(fit.size);
      doc.text(line.text, r.x + PAD, r.y + PAD + n * lh, { baseline: 'top' });
    });
  });
  doc.save('address-labels.pdf');
  return sheet + 1;
}

async function viewUsers() {
  const holder = h('div');
  const secretHolder = h('div');
  const msg = h('div');
  let users = [];

  const showSecret = (title, user, password) => {
    clear(secretHolder);
    const input = h('input', { type: 'text', readonly: true, value: password, id: 'secret-pw', 'aria-label': 'Generated password', autocomplete: 'off', spellcheck: 'false' });
    const status = h('span', { class: 'muted', role: 'status' });
    secretHolder.append(h('div', { class: 'secret', role: 'alert' },
      h('h2', { text: title }),
      h('p', { text: `Password for ${user.name} (${user.email}):` }),
      input,
      h('p', null, h('b', { text: 'This will not be shown again.' }), ' Copy it now and pass it on. They will be asked to choose their own password at first login.'),
      h('div', { class: 'row' },
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
    const actions = h('div', { class: 'row' });
    const resetBtn = () => h('button', { type: 'button', text: 'Reset password...', onclick: () => {
      clear(actions);
      actions.append(
        h('span', { text: `Reset password for ${u.name}? Their current password stops working.` }),
        h('button', { type: 'button', class: 'danger', text: 'Yes, reset', onclick: () => act(u, 'reset-password') }),
        h('button', { type: 'button', text: 'Cancel', onclick: () => renderActions() }));
    } });
    const renderActions = () => {
      clear(actions);
      if (me.role !== 'owner') return;
      if (u.role !== 'owner') {
        actions.append(h('button', { type: 'button', text: u.disabled ? 'Enable' : 'Disable', onclick: () => act(u, u.disabled ? 'enable' : 'disable') }));
      }
      actions.append(resetBtn());
    };
    renderActions();
    return h('li', { class: 'user' },
      h('b', { text: u.name }),
      u.role === 'owner' ? h('span', { class: 'tag', text: 'owner' }) : null,
      u.disabled ? h('span', { class: 'tag off', text: 'disabled' }) : null,
      u.must_change_password ? h('span', { class: 'tag', text: 'password change pending' }) : null,
      h('div', { class: 'muted', text: u.email }),
      actions);
  };

  const load = async () => {
    try {
      users = (await api('GET', '/api/users')).users || [];
      clear(holder);
      holder.append(h('ul', { class: 'list' }, users.map(userRow)));
    } catch (err) {
      clear(holder);
      holder.append(errorBox(err.message));
    }
  };

  const addMsg = h('div');
  const form = h('form', { novalidate: true },
    field({ id: 'name', label: 'Name', autocomplete: 'off', required: true, maxlength: 100 }),
    field({ id: 'new_email', label: 'Email', type: 'email', autocomplete: 'off', inputmode: 'email', required: true }),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'primary', text: 'Add user' })),
    addMsg);
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

  appEl.append(h('h1', { text: 'Users' }), secretHolder, msg, holder,
    h('h2', { text: 'Add a co-user' }),
    h('p', { class: 'muted', text: 'A password is generated and shown once. Users cannot be deleted.' }),
    form);
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
    if (hash !== '#/login') { history.replaceState(null, '', '#/login'); }
    viewLogin();
    return;
  }
  if (me.must_change_password && hash !== '#/password') {
    history.replaceState(null, '', '#/password');
    renderTop();
    viewPassword();
    return;
  }
  renderTop();

  const parts = hash.replace(/^#\/?/, '').split('/');
  const name = parts[0];
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
