// Pure label-layout maths for A4 sticker sheets (several built-in layouts plus a custom one).
// No DOM, no jsPDF: importable from the browser and from Node tests.
// All lengths are millimetres. A4 portrait is 210 x 297 mm.

export const PAGE_W = 210;
export const PAGE_H = 297;

/**
 * A sheet layout. Labels are laid out row by row from the top-left corner.
 * @typedef {{id:string, name:string, cols:number, rows:number, labelW:number, labelH:number,
 *   topMargin:number, sideMargin:number, colGap:number, rowGap:number}} Layout
 */

/** Built-in layouts, in the order they are offered. The first one is the default. */
export const PRESETS = Object.freeze([
  { id: 'l7160', name: '21 per sheet, 3 \u00d7 7, 63.5 \u00d7 38.1 mm (L7160)', cols: 3, rows: 7, labelW: 63.5, labelH: 38.1, topMargin: 15.15, sideMargin: 7.25, colGap: 2.5, rowGap: 0 },
  { id: 'l7177', name: '12 per sheet, 2 \u00d7 6, 99.1 \u00d7 42.3 mm (L7177)', cols: 2, rows: 6, labelW: 99.1, labelH: 42.3, topMargin: 21.6, sideMargin: 4.65, colGap: 2.5, rowGap: 0 },
  { id: 'l7164', name: '12 per sheet, 3 \u00d7 4, 63.5 \u00d7 72 mm (L7164)', cols: 3, rows: 4, labelW: 63.5, labelH: 72, topMargin: 4.5, sideMargin: 7.25, colGap: 2.5, rowGap: 0 },
  { id: 'w105x48', name: '12 per sheet, 2 \u00d7 6, 105 \u00d7 48 mm', cols: 2, rows: 6, labelW: 105, labelH: 48, topMargin: 4.5, sideMargin: 0, colGap: 0, rowGap: 0 },
  { id: 'w105x49', name: '12 per sheet, 2 \u00d7 6, 105 \u00d7 49.5 mm (edge to edge)', cols: 2, rows: 6, labelW: 105, labelH: 49.5, topMargin: 0, sideMargin: 0, colGap: 0, rowGap: 0 },
  { id: 'w100x44', name: '12 per sheet, 2 \u00d7 6, 100 \u00d7 44 mm', cols: 2, rows: 6, labelW: 100, labelH: 44, topMargin: 16.5, sideMargin: 4, colGap: 2, rowGap: 0 },
  // Measured from the owner's own sheet: 1 cm top margin, about 3 mm between rows.
  { id: 'w100x44g3', name: '12 per sheet, 2 \u00d7 6, 100 \u00d7 44 mm, 3 mm row gap, 10 mm top', cols: 2, rows: 6, labelW: 100, labelH: 44, topMargin: 10, sideMargin: 4, colGap: 2, rowGap: 3 },
].map((p) => Object.freeze(p)));

export const CUSTOM_ID = 'custom';
/** Default for functions called without a layout (kept so existing callers do not change): L7160. */
export const DEFAULT_LAYOUT = PRESETS[0];
/** The layout the Labels screen starts with when nothing is remembered: the owner's measured 12-per-sheet layout. */
export const UI_DEFAULT_ID = 'w100x44g3';
/** Presets in the order the chooser lists them: the screen default first, the rest in their usual order. */
export const CHOOSER_PRESETS = Object.freeze([PRESETS.find((p) => p.id === UI_DEFAULT_ID), ...PRESETS.filter((p) => p.id !== UI_DEFAULT_ID)]);

// Constants for the default layout (L7160), kept for existing callers.
export const COLS = DEFAULT_LAYOUT.cols;
export const ROWS = DEFAULT_LAYOUT.rows;
export const PER_SHEET = COLS * ROWS; // 21
export const LABEL_W = DEFAULT_LAYOUT.labelW;
export const LABEL_H = DEFAULT_LAYOUT.labelH;
export const TOP_MARGIN = DEFAULT_LAYOUT.topMargin;
export const SIDE_MARGIN = DEFAULT_LAYOUT.sideMargin;
export const COL_GAP = DEFAULT_LAYOUT.colGap;
export const ROW_GAP = DEFAULT_LAYOUT.rowGap;

/** Numeric fields of a layout with their labels, in the order the Custom form shows them. */
export const LAYOUT_FIELDS = Object.freeze([
  { key: 'cols', label: 'Columns', integer: true },
  { key: 'rows', label: 'Rows', integer: true },
  { key: 'labelW', label: 'Label width (mm)' },
  { key: 'labelH', label: 'Label height (mm)' },
  { key: 'topMargin', label: 'Top margin (mm)' },
  { key: 'sideMargin', label: 'Left margin (mm)' },
  { key: 'colGap', label: 'Horizontal gap (mm)' },
  { key: 'rowGap', label: 'Vertical gap (mm)' },
]);

const MAX_COLS = 10;
const MAX_ROWS = 30;
const MIN_LABEL = 10; // mm: smaller than this cannot hold an address
const EPS = 0.05; // mm of tolerance for decimal rounding

const fmt = (n) => String(Math.round(n * 100) / 100);

/** Number of labels on one sheet. */
export function perSheet(layout = DEFAULT_LAYOUT) {
  return layout.cols * layout.rows;
}

/** The built-in layout with this id, or undefined. */
export function presetById(id) {
  return PRESETS.find((p) => p.id === id);
}

/**
 * Check that a layout is usable on A4.
 * @param {Partial<Layout>} layout
 * @returns {{ok:boolean, errors:Record<string,string>, message:string}} errors is keyed by field; message is the first one
 */
export function validateLayout(layout) {
  const errors = {};
  const l = layout || {};
  for (const { key, label, integer } of LAYOUT_FIELDS) {
    const v = l[key];
    const name = label.replace(/ \(mm\)$/, '');
    if (typeof v !== 'number' || !Number.isFinite(v)) { errors[key] = `${name}: enter a number.`; continue; }
    if (integer) {
      if (!Number.isInteger(v) || v < 1) errors[key] = `${name} must be a whole number, 1 or more.`;
      else if (v > (key === 'cols' ? MAX_COLS : MAX_ROWS)) errors[key] = `${name} can be at most ${key === 'cols' ? MAX_COLS : MAX_ROWS}.`;
    } else if (key === 'labelW' || key === 'labelH') {
      if (v <= 0) errors[key] = `${name} must be more than 0 mm.`;
      else if (v < MIN_LABEL) errors[key] = `${name} must be at least ${MIN_LABEL} mm to hold an address.`;
    } else if (v < 0) {
      errors[key] = `${name} cannot be negative.`;
    }
  }
  if (!Object.keys(errors).length) {
    const usedW = l.sideMargin + l.cols * l.labelW + (l.cols - 1) * l.colGap;
    const usedH = l.topMargin + l.rows * l.labelH + (l.rows - 1) * l.rowGap;
    if (usedW > PAGE_W + EPS) {
      errors.labelW = `Too wide for A4: ${fmt(l.sideMargin)} + ${l.cols} \u00d7 ${fmt(l.labelW)} + ${l.cols - 1} \u00d7 ${fmt(l.colGap)} = ${fmt(usedW)} mm, but the page is ${PAGE_W} mm wide.`;
    }
    if (usedH > PAGE_H + EPS) {
      errors.labelH = `Too tall for A4: ${fmt(l.topMargin)} + ${l.rows} \u00d7 ${fmt(l.labelH)} + ${l.rows - 1} \u00d7 ${fmt(l.rowGap)} = ${fmt(usedH)} mm, but the page is ${PAGE_H} mm tall.`;
    }
  }
  const first = Object.values(errors)[0];
  return { ok: !first, errors, message: first || '' };
}

/**
 * Build a custom layout from form text. Blank or non-numeric text becomes NaN, which validateLayout rejects.
 * A decimal comma is accepted.
 * @param {Record<string,string|number>} values keyed by LAYOUT_FIELDS keys
 * @returns {Layout}
 */
export function customLayout(values) {
  const out = { id: CUSTOM_ID, name: 'Custom' };
  for (const { key } of LAYOUT_FIELDS) {
    const raw = values ? values[key] : undefined;
    const t = typeof raw === 'number' ? String(raw) : String(raw ?? '').trim().replace(',', '.');
    out[key] = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : NaN;
  }
  return out;
}

/** Layout values as strings, for filling the Custom form. */
export function layoutToValues(layout) {
  const out = {};
  for (const { key } of LAYOUT_FIELDS) out[key] = String(layout[key]);
  return out;
}

/** One-line description of a layout, e.g. "12 labels per sheet: 2 columns x 6 rows, each 99.1 x 42.3 mm". */
export function describeLayout(layout) {
  const n = perSheet(layout);
  return `${n} label${n === 1 ? '' : 's'} per sheet: ${layout.cols} column${layout.cols === 1 ? '' : 's'} \u00d7 ${layout.rows} row${layout.rows === 1 ? '' : 's'}, each ${fmt(layout.labelW)} \u00d7 ${fmt(layout.labelH)} mm.`;
}

export const MAX_SHIFT = 5; // mm either way

/**
 * Parse the two "nudge" fields (text, decimals and a decimal comma allowed, minus allowed).
 * @param {string|number} x shift right, mm
 * @param {string|number} y shift down, mm
 * @returns {{ok:boolean, shift:{x:number,y:number}, errors:{x?:string,y?:string}}}
 */
export function parseShift(x, y) {
  const errors = {};
  const out = {};
  for (const [k, raw, name] of [['x', x, 'Shift right'], ['y', y, 'Shift down']]) {
    const t = String(raw ?? '').trim().replace(',', '.');
    const v = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : NaN;
    if (Number.isNaN(v)) errors[k] = `${name}: enter a number from -${MAX_SHIFT} to ${MAX_SHIFT} (0 for no shift).`;
    else if (Math.abs(v) > MAX_SHIFT) errors[k] = `${name} must be between -${MAX_SHIFT} and ${MAX_SHIFT} mm.`;
    else out[k] = v === 0 ? 0 : v; // no negative zero
  }
  return { ok: !errors.x && !errors.y, shift: { x: out.x ?? 0, y: out.y ?? 0 }, errors };
}

/** Starting font size in points for a layout: grows with label height, between 11 and 14 pt. */
export function startFontSize(layout = DEFAULT_LAYOUT) {
  const size = 11 + (layout.labelH - 38.1) * 0.1;
  return Math.min(14, Math.max(11, Math.round(size * 4) / 4));
}

/** Inner padding in mm: 4 on labels at least 90 mm wide, otherwise 3. */
export function labelPadding(layout = DEFAULT_LAYOUT) {
  return layout.labelW >= 90 ? 4 : 3;
}

/** Line height as a multiple of the font size. */
export const LINE_FACTOR = 1.2;
const PT_TO_MM = 25.4 / 72;

/** Height in mm of one line of text at `size` points. */
export function lineHeightMm(size) {
  return size * PT_TO_MM * LINE_FACTOR;
}

/**
 * Rectangle of a label slot, row-major (0 = top-left, 1 = next to it, `cols` = second row left).
 * @param {number} index 0..perSheet(layout)-1
 * @param {Layout} [layout] defaults to L7160
 * @param {{x:number,y:number}|null} [shift] printer correction in mm: x moves right, y moves down
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function labelRect(index, layout = DEFAULT_LAYOUT, shift = null) {
  const n = perSheet(layout);
  if (!Number.isInteger(index) || index < 0 || index >= n) {
    throw new RangeError(`label index must be an integer 0..${n - 1}`);
  }
  const col = index % layout.cols;
  const row = Math.floor(index / layout.cols);
  return {
    x: layout.sideMargin + col * (layout.labelW + layout.colGap) + (shift ? shift.x : 0),
    y: layout.topMargin + row * (layout.labelH + layout.rowGap) + (shift ? shift.y : 0),
    w: layout.labelW,
    h: layout.labelH,
  };
}

/**
 * Assign `count` labels to sheets and slots. `startAt` (1..perSheet) only affects sheet 1;
 * anything else falls back to 1.
 * @param {number} count
 * @param {number} [startAt=1]
 * @param {Layout} [layout] defaults to L7160
 * @returns {{sheet:number, slot:number}[]} sheet is 0-based, slot is 0..perSheet-1
 */
export function planLabels(count, startAt = 1, layout = DEFAULT_LAYOUT) {
  const per = perSheet(layout);
  const start = Number.isInteger(startAt) && startAt >= 1 && startAt <= per ? startAt : 1;
  const out = [];
  for (let i = 0; i < count; i++) {
    const n = i + (start - 1);
    out.push({ sheet: Math.floor(n / per), slot: n % per });
  }
  return out;
}

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Text lines for one label, empty parts skipped.
 * @param {object} address
 * @param {{includePhone?:boolean}} [opts]
 * @returns {{text:string, bold:boolean}[]}
 */
export function addressLines(address, { includePhone = false } = {}) {
  const a = address || {};
  const lines = [];
  const add = (text, bold = false) => { if (text) lines.push({ text, bold }); };
  add([clean(a.first_name), clean(a.surname)].filter(Boolean).join(' '), true);
  add(clean(a.address_line1));
  add(clean(a.address_line2));
  add(clean(a.landmark));
  add([clean(a.city), clean(a.state)].filter(Boolean).join(', '));
  if (clean(a.pin)) add(`PIN: ${clean(a.pin)}`, true);
  if (includePhone && clean(a.phone)) add(`Ph: ${clean(a.phone)}`);
  return lines;
}

// Break a single over-long word into pieces that each fit maxW.
function breakWord(word, size, bold, measure, maxW) {
  const parts = [];
  let cur = '';
  for (const ch of Array.from(word)) {
    if (cur && measure(cur + ch, size, bold) > maxW) {
      parts.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

function wrapLine(line, size, measure, maxW) {
  const { text, bold } = line;
  if (measure(text, size, bold) <= maxW) return [{ text, bold }];
  const out = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const trial = cur ? `${cur} ${word}` : word;
    if (measure(trial, size, bold) <= maxW) { cur = trial; continue; }
    if (cur) { out.push(cur); cur = ''; }
    if (measure(word, size, bold) <= maxW) { cur = word; continue; }
    const pieces = breakWord(word, size, bold, measure, maxW);
    cur = pieces.pop() || '';
    out.push(...pieces);
  }
  if (cur) out.push(cur);
  return out.map((t) => ({ text: t, bold }));
}

/**
 * Wrap long lines to maxW and shrink the font (0.25 pt steps) until everything fits maxH.
 * If even minSize does not fit, trailing lines are dropped and the last kept line ends
 * with an ellipsis, so the result never exceeds the box.
 * @param {{text:string,bold:boolean}[]} lines
 * @param {(text:string,size:number,bold:boolean)=>number} measureFn width in mm
 * @param {number} maxW mm
 * @param {number} maxH mm
 * @param {number} startSize pt
 * @param {number} minSize pt
 * @returns {{size:number, lines:{text:string,bold:boolean}[]}}
 */
export function fitText(lines, measureFn, maxW, maxH, startSize, minSize) {
  const step = 0.25;
  const input = (lines || []).filter((l) => l && l.text);
  let size = startSize;
  for (;;) {
    const wrapped = input.flatMap((l) => wrapLine(l, size, measureFn, maxW));
    if (wrapped.length * lineHeightMm(size) <= maxH + 1e-9) return { size, lines: wrapped };
    if (size - step < minSize - 1e-9) break;
    size = Math.max(minSize, size - step);
  }
  size = minSize;
  const wrapped = input.flatMap((l) => wrapLine(l, size, measureFn, maxW));
  const fit = Math.max(1, Math.floor((maxH + 1e-9) / lineHeightMm(size)));
  const kept = wrapped.slice(0, fit);
  if (wrapped.length > fit && kept.length) {
    const last = kept[kept.length - 1];
    let t = last.text;
    while (t && measureFn(`${t}…`, size, last.bold) > maxW) t = t.slice(0, -1);
    kept[kept.length - 1] = { text: `${t}…`, bold: last.bold };
  }
  return { size, lines: kept };
}
