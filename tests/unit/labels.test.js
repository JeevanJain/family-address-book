import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  labelRect, planLabels, addressLines, fitText, lineHeightMm, PER_SHEET, COLS, ROWS,
  LABEL_W, LABEL_H, TOP_MARGIN, SIDE_MARGIN, COL_GAP, ROW_GAP, PAGE_W, PAGE_H,
} from '../../public/labels.js';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} expected ${b}, got ${a}`);

describe('geometry', () => {
  test('constants match the spec', () => {
    assert.equal(PER_SHEET, 21);
    assert.equal(COLS, 3);
    assert.equal(ROWS, 7);
    assert.equal(LABEL_W, 63.5);
    assert.equal(LABEL_H, 38.1);
    assert.equal(TOP_MARGIN, 15.15);
    assert.equal(SIDE_MARGIN, 7.25);
    assert.equal(COL_GAP, 2.5);
    assert.equal(ROW_GAP, 0);
  });
  test('first label at (7.25, 15.15)', () => {
    const r = labelRect(0);
    close(r.x, 7.25); close(r.y, 15.15); close(r.w, 63.5); close(r.h, 38.1);
  });
  test('x step is 66.0 and y step is 38.1', () => {
    for (let i = 0; i < PER_SHEET; i++) {
      const r = labelRect(i);
      close(r.x, 7.25 + (i % 3) * 66.0, `x[${i}]`);
      close(r.y, 15.15 + Math.floor(i / 3) * 38.1, `y[${i}]`);
    }
    close(labelRect(1).x - labelRect(0).x, 66.0);
    close(labelRect(3).y - labelRect(0).y, 38.1);
  });
  test('all 21 rects are inside the page and do not overlap', () => {
    const rects = Array.from({ length: PER_SHEET }, (_, i) => labelRect(i));
    for (const r of rects) {
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= PAGE_W + 1e-9 && r.y + r.h <= PAGE_H + 1e-9);
    }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const overlap = a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
      assert.equal(overlap, false, `${i} overlaps ${j}`);
    }
  });
  test('last label right edge 202.75 and bottom 281.85', () => {
    const r = labelRect(20);
    close(r.x + r.w, 202.75);
    close(r.y + r.h, 281.85);
  });
  test('index out of range throws', () => {
    for (const bad of [-1, 21, 1.5, NaN, '0', undefined]) assert.throws(() => labelRect(bad), RangeError, String(bad));
  });
});

describe('planLabels', () => {
  test('startAt 1 fills from slot 0', () => {
    assert.deepEqual(planLabels(3, 1), [{ sheet: 0, slot: 0 }, { sheet: 0, slot: 1 }, { sheet: 0, slot: 2 }]);
  });
  test('default startAt is 1', () => assert.deepEqual(planLabels(1), [{ sheet: 0, slot: 0 }]));
  test('startAt 5 begins at slot 4', () => {
    const p = planLabels(2, 5);
    assert.deepEqual(p, [{ sheet: 0, slot: 4 }, { sheet: 0, slot: 5 }]);
  });
  test('startAt 5 with 20 labels overflows to sheet 2', () => {
    const p = planLabels(20, 5);
    assert.deepEqual(p[16], { sheet: 0, slot: 20 });
    assert.deepEqual(p[17], { sheet: 1, slot: 0 });
    assert.deepEqual(p[19], { sheet: 1, slot: 2 });
  });
  test('startAt 21 uses only the last slot of sheet 1', () => {
    const p = planLabels(3, 21);
    assert.deepEqual(p, [{ sheet: 0, slot: 20 }, { sheet: 1, slot: 0 }, { sheet: 1, slot: 1 }]);
  });
  test('21 labels at start 1 fit exactly one sheet; 22 need two', () => {
    assert.equal(planLabels(21, 1).at(-1).sheet, 0);
    assert.deepEqual(planLabels(22, 1).at(-1), { sheet: 1, slot: 0 });
  });
  test('startAt applies to sheet 1 only', () => {
    const p = planLabels(50, 10);
    assert.ok(p.filter((x) => x.sheet === 1).length === 21);
    assert.equal(p.find((x) => x.sheet === 1).slot, 0);
  });
  test('zero labels gives empty plan; invalid startAt falls back to 1', () => {
    assert.deepEqual(planLabels(0, 5), []);
    assert.deepEqual(planLabels(1, 0), [{ sheet: 0, slot: 0 }]);
    assert.deepEqual(planLabels(1, 22), [{ sheet: 0, slot: 0 }]);
    assert.deepEqual(planLabels(1, 'x'), [{ sheet: 0, slot: 0 }]);
  });
});

describe('addressLines', () => {
  const full = {
    first_name: 'Test', surname: 'User', address_line1: '1 Example Road', address_line2: 'Block B',
    landmark: 'Near the park', city: 'Exampleville', state: 'Karnataka', pin: '560001', phone: '9876543210',
  };
  test('full address: name bold, PIN on its own bold line, in order', () => {
    const l = addressLines(full);
    assert.deepEqual(l, [
      { text: 'Test User', bold: true },
      { text: '1 Example Road', bold: false },
      { text: 'Block B', bold: false },
      { text: 'Near the park', bold: false },
      { text: 'Exampleville, Karnataka', bold: false },
      { text: 'PIN: 560001', bold: true },
    ]);
  });
  test('skips empty / null / whitespace parts', () => {
    const l = addressLines({ ...full, surname: '', address_line2: null, landmark: '   ' });
    assert.deepEqual(l.map((x) => x.text), ['Test', '1 Example Road', 'Exampleville, Karnataka', 'PIN: 560001']);
  });
  test('city only / state only has no dangling comma', () => {
    assert.equal(addressLines({ ...full, state: '' }).find((x) => x.text.startsWith('Exampleville')).text, 'Exampleville');
    assert.equal(addressLines({ ...full, city: null }).find((x) => x.text === 'Karnataka').text, 'Karnataka');
  });
  test('PIN is never merged into the city line', () => {
    const l = addressLines(full);
    const cityLine = l.find((x) => x.text.includes('Exampleville'));
    assert.ok(!cityLine.text.includes('560001'));
    assert.equal(l.filter((x) => x.text.includes('560001')).length, 1);
  });
  test('phone only when requested', () => {
    assert.ok(!addressLines(full).some((x) => x.text.includes('9876543210')));
    const l = addressLines(full, { includePhone: true });
    assert.equal(l.at(-1).text, 'Ph: 9876543210');
    assert.equal(l.at(-1).bold, false);
    assert.ok(!addressLines({ ...full, phone: '' }, { includePhone: true }).some((x) => x.text.startsWith('Ph')));
  });
  test('null / empty input does not throw', () => {
    assert.deepEqual(addressLines(null), []);
    assert.deepEqual(addressLines({}), []);
  });
});

// A deterministic fake font: 0.2 mm per character per pt/10 ... width = chars * size * 0.18 (bold 10% wider).
const measure = (text, size, bold) => text.length * size * 0.18 * (bold ? 1.1 : 1);
const BOX_W = LABEL_W - 6;
const BOX_H = LABEL_H - 6;

function assertFits(res, maxW, maxH, m = measure) {
  assert.ok(res.lines.length * lineHeightMm(res.size) <= maxH + 1e-6, `height ${res.lines.length * lineHeightMm(res.size)} > ${maxH}`);
  for (const l of res.lines) assert.ok(m(l.text, res.size, l.bold) <= maxW + 1e-6, `width of "${l.text}" > ${maxW}`);
}

describe('fitText', () => {
  test('short content keeps the start size and is unchanged', () => {
    const lines = addressLines({ first_name: 'Test', surname: 'User', address_line1: '1 Example Road', city: 'X', state: 'Y', pin: '560001' });
    const r = fitText(lines, measure, BOX_W, BOX_H, 11, 5);
    assert.equal(r.size, 11);
    assert.equal(r.lines.length, lines.length);
    assertFits(r, BOX_W, BOX_H);
  });
  test('long lines wrap at word boundaries', () => {
    const lines = [{ text: 'word '.repeat(30).trim(), bold: false }];
    const r = fitText(lines, measure, BOX_W, 200, 11, 5);
    assert.ok(r.lines.length > 1);
    assertFits(r, BOX_W, 200);
    assert.equal(r.lines.map((l) => l.text).join(' '), lines[0].text);
  });
  test('over-long single word is broken so it fits the width', () => {
    const r = fitText([{ text: 'X'.repeat(80), bold: true }], measure, BOX_W, 200, 11, 5);
    assertFits(r, BOX_W, 200);
    assert.equal(r.lines.map((l) => l.text).join(''), 'X'.repeat(80));
  });
  test('too much text shrinks the font but never below minSize', () => {
    const lines = [];
    for (let i = 0; i < 9; i++) lines.push({ text: `Line number ${i} of the address`, bold: false });
    const r = fitText(lines, measure, BOX_W, BOX_H, 11, 5);
    assert.ok(r.size < 11);
    assert.ok(r.size >= 5);
    assertFits(r, BOX_W, BOX_H);
  });
  test('never exceeds the box, even for hostile input (fuzz)', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 300; n++) {
      const lines = [];
      const count = 1 + Math.floor(rnd() * 12);
      for (let i = 0; i < count; i++) {
        const words = 1 + Math.floor(rnd() * 25);
        const text = Array.from({ length: words }, () => 'a'.repeat(1 + Math.floor(rnd() * (rnd() < 0.1 ? 60 : 12)))).join(' ');
        lines.push({ text, bold: rnd() < 0.3 });
      }
      const r = fitText(lines, measure, BOX_W, BOX_H, 11, 5);
      assertFits(r, BOX_W, BOX_H);
      assert.ok(r.size >= 5 && r.size <= 11);
    }
  });
  test('when minimum size still cannot fit, lines are dropped and the last ends with an ellipsis', () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({ text: `Row ${i}`, bold: false }));
    const r = fitText(lines, measure, BOX_W, BOX_H, 11, 5);
    assert.equal(r.size, 5);
    assert.ok(r.lines.at(-1).text.endsWith('…'));
    assertFits(r, BOX_W, BOX_H);
  });
  test('ignores empty lines and handles empty input', () => {
    assert.deepEqual(fitText([], measure, BOX_W, BOX_H, 11, 5).lines, []);
    assert.deepEqual(fitText([{ text: '', bold: false }], measure, BOX_W, BOX_H, 11, 5).lines, []);
  });
  test('works with real jsPDF text metrics (Helvetica)', async () => {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const m = (text, size, bold) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); return doc.getTextWidth(text); };
    const lines = addressLines({
      first_name: 'Test', surname: 'User With A Rather Extraordinarily Long Surname Indeed',
      address_line1: '1 Example Road, Some Very Long Colony Name, Extension Phase Three Sector Twelve',
      address_line2: 'Third Floor, Wing C', landmark: 'Opposite the big old banyan tree near the bus stand',
      city: 'Exampleville', state: 'Karnataka', pin: '560001', phone: '9876543210',
    }, { includePhone: true });
    const r = fitText(lines, m, BOX_W, BOX_H, 11, 5);
    assertFits(r, BOX_W, BOX_H, m);
  });
});

// ---------- layouts ----------
import {
  PRESETS, DEFAULT_LAYOUT, CUSTOM_ID, LAYOUT_FIELDS, perSheet, presetById, validateLayout, customLayout,
  layoutToValues, describeLayout, startFontSize, labelPadding,
} from '../../public/labels.js';

describe('layout presets', () => {
  test('six presets in the agreed order, ids unique, default is L7160', () => {
    assert.deepEqual(PRESETS.map((p) => p.id), ['l7160', 'l7177', 'l7164', 'w105x48', 'w105x49', 'w100x44']);
    assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length);
    assert.equal(DEFAULT_LAYOUT, PRESETS[0]);
    assert.equal(CUSTOM_ID, 'custom');
    assert.equal(presetById('l7164').labelH, 72);
    assert.equal(presetById('nope'), undefined);
  });
  test('names say count, arrangement and size, with the code in brackets where there is one', () => {
    assert.deepEqual(PRESETS.map((p) => p.name), [
      '21 per sheet, 3 × 7, 63.5 × 38.1 mm (L7160)',
      '12 per sheet, 2 × 6, 99.1 × 42.3 mm (L7177)',
      '12 per sheet, 3 × 4, 63.5 × 72 mm (L7164)',
      '12 per sheet, 2 × 6, 105 × 48 mm',
      '12 per sheet, 2 × 6, 105 × 49.5 mm (edge to edge)',
      '12 per sheet, 2 × 6, 100 × 44 mm',
    ]);
  });
  test('exact numbers of every preset', () => {
    const row = (p) => [p.cols, p.rows, p.labelW, p.labelH, p.topMargin, p.sideMargin, p.colGap, p.rowGap];
    assert.deepEqual(PRESETS.map(row), [
      [3, 7, 63.5, 38.1, 15.15, 7.25, 2.5, 0],
      [2, 6, 99.1, 42.3, 21.6, 4.65, 2.5, 0],
      [3, 4, 63.5, 72, 4.5, 7.25, 2.5, 0],
      [2, 6, 105, 48, 4.5, 0, 0, 0],
      [2, 6, 105, 49.5, 0, 0, 0, 0],
      [2, 6, 100, 44, 16.5, 4, 2, 0],
    ]);
  });
  for (const p of PRESETS) {
    test(`arithmetic: ${p.id} is centred across 210 mm and fits 297 mm`, () => {
      const across = p.cols * p.labelW + (p.cols - 1) * p.colGap + 2 * p.sideMargin;
      assert.ok(Math.abs(across - 210) <= 0.1, `${p.id}: width sum ${across}`);
      const down = p.rows * p.labelH + (p.rows - 1) * p.rowGap + p.topMargin;
      const bottom = 297 - down;
      assert.ok(bottom >= -1e-9, `${p.id}: bottom margin ${bottom}`);
      assert.deepEqual(validateLayout(p), { ok: true, errors: {}, message: '' });
    });
    test(`every slot of ${p.id} lies on the page and no two overlap`, () => {
      const n = perSheet(p);
      const rects = Array.from({ length: n }, (_, i) => labelRect(i, p));
      for (const r of rects) assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 210 + 0.1 && r.y + r.h <= 297 + 1e-9, JSON.stringify(r));
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = rects[i], b = rects[j];
        assert.equal(a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6, false, `${i}/${j}`);
      }
    });
  }
  test('perSheet counts', () => {
    assert.deepEqual(PRESETS.map((p) => perSheet(p)), [21, 12, 12, 12, 12, 12]);
    assert.equal(perSheet(), 21);
  });
});

describe('layout-aware geometry', () => {
  test('labelRect without a layout is still L7160', () => {
    assert.deepEqual(labelRect(4), labelRect(4, presetById('l7160')));
  });
  test('L7177: 2 columns, second column 101.6 mm right of the first, rows 42.3 mm apart', () => {
    const l = presetById('l7177');
    const a = labelRect(0, l), b = labelRect(1, l), c = labelRect(2, l), z = labelRect(11, l);
    close(a.x, 4.65); close(a.y, 21.6); close(a.w, 99.1); close(a.h, 42.3);
    close(b.x - a.x, 101.6); close(b.y, a.y);
    close(c.x, a.x); close(c.y - a.y, 42.3);
    close(z.x + z.w, 4.65 + 101.6 + 99.1); close(z.y + z.h, 21.6 + 6 * 42.3);
  });
  test('L7164 is 3 x 4 and the last label is bottom-right', () => {
    const l = presetById('l7164');
    const z = labelRect(11, l);
    close(z.x, 7.25 + 2 * 66); close(z.y, 4.5 + 3 * 72);
  });
  test('edge-to-edge: first label at the page corner, last label ends at the page corner', () => {
    const l = presetById('w105x49');
    assert.deepEqual(labelRect(0, l), { x: 0, y: 0, w: 105, h: 49.5 });
    const z = labelRect(11, l);
    close(z.x + z.w, 210); close(z.y + z.h, 297);
  });
  test('index range follows the layout', () => {
    const l = presetById('l7177');
    assert.doesNotThrow(() => labelRect(11, l));
    assert.throws(() => labelRect(12, l), RangeError);
    assert.doesNotThrow(() => labelRect(20));
    assert.throws(() => labelRect(21), RangeError);
  });
});

describe('planLabels per layout', () => {
  const l12 = presetById('l7177');
  test('13 labels on a 12-up sheet need 2 sheets, the 13th is slot 0 of sheet 2', () => {
    const p = planLabels(13, 1, l12);
    assert.deepEqual(p[11], { sheet: 0, slot: 11 });
    assert.deepEqual(p[12], { sheet: 1, slot: 0 });
    assert.equal(planLabels(12, 1, l12).at(-1).sheet, 0);
  });
  test('start at 12 uses the last slot of sheet 1 only', () => {
    assert.deepEqual(planLabels(2, 12, l12), [{ sheet: 0, slot: 11 }, { sheet: 1, slot: 0 }]);
  });
  test('start 13..21 is invalid on a 12-up sheet and falls back to 1', () => {
    assert.deepEqual(planLabels(1, 13, l12), [{ sheet: 0, slot: 0 }]);
    assert.deepEqual(planLabels(1, 21, l12), [{ sheet: 0, slot: 0 }]);
    assert.deepEqual(planLabels(1, 21), [{ sheet: 0, slot: 20 }]);
  });
  test('startAt applies to sheet 1 only, later sheets hold perSheet labels', () => {
    const p = planLabels(30, 5, l12);
    assert.equal(p.filter((x) => x.sheet === 1).length, 12);
    assert.equal(p.filter((x) => x.sheet === 0).length, 8);
    assert.equal(p.at(-1).sheet, 2);
  });
});

describe('validateLayout', () => {
  const ok = { ...presetById('l7177') };
  const bad = (patch) => validateLayout({ ...ok, ...patch });
  test('accepts a custom layout that fits', () => {
    assert.equal(validateLayout(customLayout({ cols: '2', rows: '5', labelW: '100', labelH: '50', topMargin: '10', sideMargin: '5', colGap: '0', rowGap: '0' })).ok, true);
  });
  test('rejects too wide, naming the sum and the page width', () => {
    const r = bad({ labelW: 105 });
    assert.equal(r.ok, false);
    assert.match(r.message, /Too wide for A4/);
    assert.match(r.message, /= 217\.15 mm/);
    assert.match(r.message, /210 mm wide/);
    assert.ok(r.errors.labelW);
  });
  test('rejects too tall', () => {
    const r = bad({ labelH: 50 });
    assert.equal(r.ok, false);
    assert.match(r.message, /Too tall for A4/);
    assert.ok(r.errors.labelH);
  });
  test('right at the page edge is fine, a hair over is not', () => {
    assert.equal(validateLayout({ ...ok, labelW: 105, sideMargin: 0, colGap: 0, topMargin: 0, labelH: 49.5 }).ok, true);
    assert.equal(validateLayout({ ...ok, labelW: 105.2, sideMargin: 0, colGap: 0 }).ok, false);
  });
  test('non-positive or tiny sizes', () => {
    for (const k of ['labelW', 'labelH']) {
      assert.match(bad({ [k]: 0 }).errors[k], /more than 0 mm/);
      assert.match(bad({ [k]: -5 }).errors[k], /more than 0 mm/);
      assert.match(bad({ [k]: 4 }).errors[k], /at least 10 mm/);
    }
  });
  test('columns and rows must be whole numbers of at least 1', () => {
    for (const k of ['cols', 'rows']) {
      assert.match(bad({ [k]: 0 }).errors[k], /whole number/);
      assert.match(bad({ [k]: 1.5 }).errors[k], /whole number/);
      assert.match(bad({ [k]: -2 }).errors[k], /whole number/);
    }
    assert.match(bad({ cols: 11 }).errors.cols, /at most 10/);
    assert.match(bad({ rows: 31 }).errors.rows, /at most 30/);
  });
  test('margins and gaps cannot be negative but may be zero', () => {
    for (const k of ['topMargin', 'sideMargin', 'colGap', 'rowGap']) {
      assert.match(bad({ [k]: -1 }).errors[k], /cannot be negative/);
    }
    assert.equal(bad({ topMargin: 0, sideMargin: 0, colGap: 0, rowGap: 0 }).ok, true);
  });
  test('missing, NaN and non-number values are reported, not thrown', () => {
    assert.match(bad({ labelW: NaN }).errors.labelW, /enter a number/);
    assert.match(bad({ cols: undefined }).errors.cols, /enter a number/);
    assert.match(bad({ rows: '6' }).errors.rows, /enter a number/);
    assert.equal(validateLayout(null).ok, false);
    assert.equal(validateLayout(undefined).ok, false);
    assert.equal(validateLayout({}).ok, false);
  });
  test('message is the first error and is empty when valid', () => {
    assert.equal(bad({}).message, '');
    const r = bad({ cols: 0, labelW: 0 });
    assert.equal(r.message, Object.values(r.errors)[0]);
  });
});

describe('customLayout / layoutToValues', () => {
  test('parses strings, decimals and a decimal comma; blank and junk become NaN', () => {
    const l = customLayout({ cols: '2', rows: ' 6 ', labelW: '99,1', labelH: '42.3', topMargin: '', sideMargin: 'abc', colGap: '.5', rowGap: '-1' });
    assert.equal(l.id, 'custom');
    assert.equal(l.cols, 2); assert.equal(l.rows, 6); assert.equal(l.labelW, 99.1); assert.equal(l.labelH, 42.3);
    assert.ok(Number.isNaN(l.topMargin)); assert.ok(Number.isNaN(l.sideMargin));
    assert.equal(l.colGap, 0.5);
    assert.equal(l.rowGap, -1, 'a minus sign parses; validateLayout then rejects it');
    assert.match(validateLayout({ ...presetById('l7177'), rowGap: l.rowGap }).errors.rowGap, /cannot be negative/);
  });
  test('round trip through layoutToValues', () => {
    for (const p of PRESETS) {
      const l = customLayout(layoutToValues(p));
      for (const { key } of LAYOUT_FIELDS) assert.equal(l[key], p[key], `${p.id}.${key}`);
      assert.equal(validateLayout(l).ok, true);
    }
  });
  test('missing input object does not throw', () => {
    assert.equal(validateLayout(customLayout(undefined)).ok, false);
  });
});

describe('describeLayout / font size / padding', () => {
  test('describeLayout', () => {
    assert.equal(describeLayout(presetById('l7177')), '12 labels per sheet: 2 columns × 6 rows, each 99.1 × 42.3 mm.');
    assert.equal(describeLayout(presetById('l7160')), '21 labels per sheet: 3 columns × 7 rows, each 63.5 × 38.1 mm.');
  });
  test('start font size grows with label height within 11..14 pt; L7160 stays 11', () => {
    assert.equal(startFontSize(presetById('l7160')), 11);
    assert.equal(startFontSize(), 11);
    assert.equal(startFontSize(presetById('l7164')), 14);
    const sizes = PRESETS.map((p) => startFontSize(p));
    for (const s of sizes) assert.ok(s >= 11 && s <= 14);
    assert.ok(startFontSize({ labelH: 50 }) > startFontSize({ labelH: 40 }));
    assert.equal(startFontSize({ labelH: 10 }), 11);
    assert.equal(startFontSize({ labelH: 280 }), 14);
  });
  test('padding is 3 mm, or 4 mm on labels at least 90 mm wide', () => {
    assert.equal(labelPadding(presetById('l7160')), 3);
    assert.equal(labelPadding(presetById('l7164')), 3);
    assert.equal(labelPadding(presetById('l7177')), 4);
    assert.equal(labelPadding({ labelW: 90 }), 4);
    assert.equal(labelPadding({ labelW: 89.9 }), 3);
  });
  test('real Helvetica text fits the box of every preset at its start size', async () => {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const m = (text, size, bold) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); return doc.getTextWidth(text); };
    const lines = addressLines({
      first_name: 'Test', surname: 'User With A Rather Extraordinarily Long Surname Indeed',
      address_line1: '1 Example Road, Some Very Long Colony Name, Extension Phase Three Sector Twelve',
      address_line2: 'Third Floor, Wing C', landmark: 'Opposite the big old banyan tree near the bus stand',
      city: 'Exampleville', state: 'Karnataka', pin: '560001', phone: '9876543210',
    }, { includePhone: true });
    for (const p of PRESETS) {
      const pad = labelPadding(p);
      const r = fitText(lines, m, p.labelW - 2 * pad, p.labelH - 2 * pad, startFontSize(p), 5);
      assertFits(r, p.labelW - 2 * pad, p.labelH - 2 * pad, m);
      assert.ok(r.size <= startFontSize(p));
    }
  });
});

// ---------- chooser order, default and printer shift ----------
import { CHOOSER_PRESETS, UI_DEFAULT_ID, parseShift, MAX_SHIFT } from '../../public/labels.js';

describe('chooser order and screen default', () => {
  test('the Labels screen defaults to 12 per sheet, 2 x 6, 99.1 x 42.3 mm and lists it first; all presets stay available', () => {
    assert.equal(UI_DEFAULT_ID, 'l7177');
    assert.equal(CHOOSER_PRESETS[0].id, 'l7177');
    assert.deepEqual(CHOOSER_PRESETS.map((p) => p.id).sort(), PRESETS.map((p) => p.id).sort());
    assert.equal(CHOOSER_PRESETS.length, 6);
    assert.deepEqual(CHOOSER_PRESETS.slice(1).map((p) => p.id), ['l7160', 'l7164', 'w105x48', 'w105x49', 'w100x44']);
  });
  test('functions called without a layout are still L7160', () => {
    assert.equal(DEFAULT_LAYOUT.id, 'l7160');
    assert.equal(perSheet(), 21);
    assert.deepEqual(planLabels(1, 21), [{ sheet: 0, slot: 20 }]);
  });
});

describe('printer shift', () => {
  test('labelRect without a shift, with a null shift and with a zero shift are identical', () => {
    for (const p of PRESETS) for (let i = 0; i < perSheet(p); i++) {
      assert.deepEqual(labelRect(i, p, null), labelRect(i, p));
      assert.deepEqual(labelRect(i, p, { x: 0, y: 0 }), labelRect(i, p));
    }
  });
  test('a shift moves x and y of every slot by exactly that much and leaves the size alone', () => {
    for (const p of PRESETS) for (let i = 0; i < perSheet(p); i++) {
      const a = labelRect(i, p), b = labelRect(i, p, { x: 2, y: -1.5 });
      close(b.x - a.x, 2); close(b.y - a.y, -1.5); close(b.w, a.w); close(b.h, a.h);
    }
  });
  test('parseShift accepts decimals, a decimal comma and signs; the limits are inclusive', () => {
    assert.deepEqual(parseShift('2', '-1.5'), { ok: true, shift: { x: 2, y: -1.5 }, errors: {} });
    assert.deepEqual(parseShift('0,5', '+.5').shift, { x: 0.5, y: 0.5 });
    assert.equal(parseShift('5', '-5').ok, true);
    assert.equal(parseShift(0, '0').ok, true);
    assert.equal(Object.is(parseShift('-0', '0').shift.x, -0), false, 'no negative zero');
    assert.equal(MAX_SHIFT, 5);
  });
  test('parseShift rejects out-of-range, blank and junk with a message naming the field', () => {
    const r = parseShift('5.1', 'abc');
    assert.equal(r.ok, false);
    assert.match(r.errors.x, /Shift right must be between -5 and 5 mm/);
    assert.match(r.errors.y, /Shift down: enter a number/);
    assert.equal(parseShift('', '0').ok, false);
    assert.equal(parseShift('0', '-5.01').ok, false);
    assert.equal(parseShift('1e1', '0').ok, false);
    assert.deepEqual(parseShift('x', '9').shift, { x: 0, y: 0 });
  });
});
