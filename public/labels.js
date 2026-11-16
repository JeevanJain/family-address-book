// Pure label-layout maths for Avery L7160 (A4, 3 x 7, 63.5 x 38.1 mm).
// No DOM, no jsPDF: importable from the browser and from Node tests.
// All lengths are millimetres.

export const PAGE_W = 210;
export const PAGE_H = 297;
export const COLS = 3;
export const ROWS = 7;
export const PER_SHEET = COLS * ROWS; // 21
export const LABEL_W = 63.5;
export const LABEL_H = 38.1;
export const TOP_MARGIN = 15.15;
export const SIDE_MARGIN = 7.25;
export const COL_GAP = 2.5;
export const ROW_GAP = 0;

/** Line height as a multiple of the font size. */
export const LINE_FACTOR = 1.2;
const PT_TO_MM = 25.4 / 72;

/** Height in mm of one line of text at `size` points. */
export function lineHeightMm(size) {
  return size * PT_TO_MM * LINE_FACTOR;
}

/**
 * Rectangle of a label slot, row-major (0 = top-left, 1 = top-middle, 3 = second row left).
 * @param {number} index 0..20
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function labelRect(index) {
  if (!Number.isInteger(index) || index < 0 || index >= PER_SHEET) {
    throw new RangeError('label index must be an integer 0..20');
  }
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return {
    x: SIDE_MARGIN + col * (LABEL_W + COL_GAP),
    y: TOP_MARGIN + row * (LABEL_H + ROW_GAP),
    w: LABEL_W,
    h: LABEL_H,
  };
}

/**
 * Assign `count` labels to sheets and slots. `startAt` (1..21) only affects sheet 1.
 * @param {number} count
 * @param {number} [startAt=1]
 * @returns {{sheet:number, slot:number}[]} sheet is 0-based, slot is 0..20
 */
export function planLabels(count, startAt = 1) {
  const start = Number.isInteger(startAt) && startAt >= 1 && startAt <= PER_SHEET ? startAt : 1;
  const out = [];
  for (let i = 0; i < count; i++) {
    const n = i + (start - 1);
    out.push({ sheet: Math.floor(n / PER_SHEET), slot: n % PER_SHEET });
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
