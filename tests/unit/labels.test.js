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
