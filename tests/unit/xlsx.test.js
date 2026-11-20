import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {
  crc32, zipStore, xmlText, columnName, buildXlsx, addressesToXlsx, ADDRESS_COLUMNS, XLSX_MIME,
} from '../../public/xlsx.js';

const td = new TextDecoder();

/** Independent minimal ZIP reader: walks the central directory and checks every CRC. */
function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  assert.ok(eocd >= 0, 'end of central directory record');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  for (let n = 0; n < count; n++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50, 'central header signature');
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = td.decode(bytes.subarray(p + 46, p + 46 + nlen));
    assert.equal(dv.getUint32(off, true), 0x04034b50, `local header signature of ${name}`);
    const lname = dv.getUint16(off + 26, true);
    const lextra = dv.getUint16(off + 28, true);
    const start = off + 30 + lname + lextra;
    const raw = bytes.subarray(start, start + csize);
    const data = method === 0 ? raw : inflateRawSync(raw);
    assert.equal(data.length, usize, `size of ${name}`);
    assert.equal(crc32(data), crc, `crc of ${name}`);
    files[name] = data;
    p += 46 + nlen + xlen + clen;
  }
  return files;
}

const sample = [
  { first_name: 'Test', surname: 'User', address_line1: '1 Example Road', address_line2: 'Block B', landmark: 'Near the park', city: 'Exampleville', state: 'Karnataka', pin: '012345', phone: '0987654321', email: 'test@example.com', group_name: 'Family', notes: 'Line one\nLine two', created_by_name: 'Owner' },
  { first_name: '=SUM(1,2)', surname: 'Tom & <Jerry> "Q" \'s', address_line1: '+1 Road', city: 'München', state: 'Kārnataka ನಮಸ್ಕಾರ ✓', pin: '560001', phone: '9876543210', created_by_name: '@Owner' },
  { first_name: 'Ctrl\u0001Char\u0000s￾', surname: '  spaced  ', address_line1: 'x', city: 'y', state: 'z', pin: '000000', phone: '9000000000', notes: 'emoji \u{1F600} ok' },
];

describe('crc32 / zipStore', () => {
  test('known CRC-32 values', () => {
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
    assert.equal(crc32(new Uint8Array()), 0);
  });
  test('round trip: names, contents and CRCs survive', () => {
    const files = [{ name: 'a.txt', data: new TextEncoder().encode('hello') }, { name: 'dir/b.bin', data: new Uint8Array([0, 255, 1, 2]) }, { name: 'empty', data: new Uint8Array() }];
    const out = zipStore(files, new Date(2026, 0, 2, 3, 4, 6));
    assert.equal(String.fromCharCode(out[0], out[1]), 'PK');
    const got = readZip(out);
    assert.deepEqual(Object.keys(got), ['a.txt', 'dir/b.bin', 'empty']);
    assert.equal(td.decode(got['a.txt']), 'hello');
    assert.deepEqual([...got['dir/b.bin']], [0, 255, 1, 2]);
    assert.equal(got.empty.length, 0);
  });
});

describe('xml helpers', () => {
  test('xmlText escapes the five special characters', () => {
    assert.equal(xmlText(`a & b < c > d " e ' f`), 'a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });
  test('strips characters that are illegal in XML 1.0, keeps tab / newline and astral characters', () => {
    assert.equal(xmlText('a\u0000b\u0001c\u0008d\u000Be\u000Cf\u001Fg￾h￿i'), 'abcdefghi');
    assert.equal(xmlText('x\ty\nz'), 'x\ty\nz');
    assert.equal(xmlText('\u{1F600}क'), '\u{1F600}क');
    assert.equal(xmlText('lone\uD800surrogate'), 'lonesurrogate');
    assert.equal(xmlText('a\r\nb\rc'), 'a\nb\nc');
    assert.equal(xmlText(null), '');
    assert.equal(xmlText(undefined), '');
  });
  test('columnName', () => {
    assert.deepEqual([0, 1, 12, 25, 26, 27, 51, 52, 701, 702].map(columnName), ['A', 'B', 'M', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
});

describe('buildXlsx / addressesToXlsx', () => {
  const files = readZip(addressesToXlsx(sample));
  const sheet = td.decode(files['xl/worksheets/sheet1.xml']);

  test('starts with the ZIP signature and has every required part', () => {
    const bytes = addressesToXlsx(sample);
    assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'PK');
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/styles.xml']) {
      assert.ok(files[part], `missing ${part}`);
    }
    assert.equal(Object.keys(files)[0], '[Content_Types].xml');
    assert.match(XLSX_MIME, /spreadsheetml\.sheet$/);
  });
  test('workbook names the sheet "Addresses" and the parts are wired together', () => {
    assert.match(td.decode(files['xl/workbook.xml']), /<sheet name="Addresses" sheetId="1" r:id="rId1"\/>/);
    assert.match(td.decode(files['xl/_rels/workbook.xml.rels']), /Id="rId1"[^>]*Target="worksheets\/sheet1\.xml"/);
    assert.match(td.decode(files['_rels/.rels']), /Target="xl\/workbook\.xml"/);
    const ct = td.decode(files['[Content_Types].xml']);
    assert.match(ct, /\/xl\/worksheets\/sheet1\.xml/);
    assert.match(ct, /\/xl\/styles\.xml/);
  });
  test('header columns are the 13 agreed columns, in order', () => {
    assert.deepEqual(ADDRESS_COLUMNS.map((c) => c.header), ['First name', 'Surname', 'Address line 1', 'Address line 2', 'Landmark', 'City', 'State', 'PIN', 'Phone', 'Email', 'Group', 'Notes', 'Added by']);
  });
  test('header frozen, column widths set, dimension covers the data', () => {
    assert.match(sheet, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
    assert.equal((sheet.match(/<col /g) || []).length, 13);
    assert.match(sheet, /<dimension ref="A1:M4"\/>/);
  });
  test('every cell is an inline string; nothing is a number or a formula', () => {
    assert.equal(/<f[ >]/.test(sheet), false, 'no formula elements');
    assert.equal(/<v>/.test(sheet), false, 'no numeric values');
    const cells = sheet.match(/<c r="[A-Z]+\d+"[^>]*?(\/>|>)/g);
    for (const c of cells) assert.ok(c.endsWith('/>') || /t="inlineStr"/.test(c), c);
  });
  test('a value starting with "=" is written as literal text', () => {
    assert.match(sheet, /<c r="A3" s="2" t="inlineStr"><is><t>=SUM\(1,2\)<\/t><\/is><\/c>/);
  });
  test('PIN and phone keep leading zeros as text', () => {
    assert.match(sheet, /<c r="H2" s="2" t="inlineStr"><is><t>012345<\/t>/);
    assert.match(sheet, /<c r="I2" s="2" t="inlineStr"><is><t>0987654321<\/t>/);
  });
  test('special characters are escaped; illegal ones removed; whitespace preserved', () => {
    assert.match(sheet, /Tom &amp; &lt;Jerry&gt; &quot;Q&quot; &apos;s/);
    assert.match(sheet, /<t>CtrlChars<\/t>/);
    assert.match(sheet, /<t xml:space="preserve">  spaced  <\/t>/);
    assert.match(sheet, /<t xml:space="preserve">Line one\nLine two<\/t>/);
    assert.match(sheet, /München/);
  });
  test('empty cells are written as empty styled cells, empty export still has a header', () => {
    assert.match(sheet, /<c r="D3" s="2"\/>/);
    const empty = td.decode(readZip(addressesToXlsx([]))['xl/worksheets/sheet1.xml']);
    assert.match(empty, /<dimension ref="A1:M1"\/>/);
    assert.match(empty, /<t>First name<\/t>/);
    assert.equal(td.decode(readZip(addressesToXlsx(undefined))['xl/worksheets/sheet1.xml']).includes('<row r="2">'), false);
  });
  test('sheet name is sanitised', () => {
    const f = readZip(buildXlsx({ sheetName: 'a/b:c*d?[e]\u0001', columns: [{ header: 'H' }], rows: [] }));
    assert.match(td.decode(f['xl/workbook.xml']), /<sheet name="a b c d  e " sheetId="1"/);
  });
  test('a few thousand rows build quickly and stay a valid zip', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ ...sample[0], first_name: `N${i}` }));
    const t0 = Date.now();
    const out = addressesToXlsx(many);
    assert.ok(Date.now() - t0 < 2000);
    assert.ok(readZip(out)['xl/worksheets/sheet1.xml'].length > 100000);
  });
});

// ---------- validation with a real reader (openpyxl), skipped if it is not installed ----------
const py = spawnSync('python3', ['-I', '-c', 'import openpyxl; print(openpyxl.__version__)'], { encoding: 'utf8' });
const hasOpenpyxl = py.status === 0;

describe('openpyxl reads the file', { skip: hasOpenpyxl ? false : 'python3 with openpyxl is not available' }, () => {
  test('header, rows, text cells, literal formula text, escaping and non-ASCII', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fab-xlsx-'));
    try {
      const file = join(dir, 'addresses.xlsx');
      writeFileSync(file, addressesToXlsx(sample));
      const script = `
import sys, json, openpyxl
wb = openpyxl.load_workbook(sys.argv[1])
ws = wb['Addresses']
out = {
  'sheets': wb.sheetnames,
  'header': [c.value for c in ws[1]],
  'rows': ws.max_row - 1,
  'freeze': ws.freeze_panes,
  'bold_header': all(c.font.b for c in ws[1]),
  'r2': [[c.value, c.data_type, c.number_format] for c in ws[2]],
  'r3': [[c.value, c.data_type] for c in ws[3]],
  'r4': [[c.value, c.data_type] for c in ws[4]],
}
print(json.dumps(out, ensure_ascii=False))
`;
      const r = spawnSync('python3', ['-I', '-c', script, file], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const o = JSON.parse(r.stdout);
      assert.deepEqual(o.sheets, ['Addresses']);
      assert.deepEqual(o.header, ADDRESS_COLUMNS.map((c) => c.header));
      assert.equal(o.rows, 3);
      assert.equal(o.freeze, 'A2');
      assert.equal(o.bold_header, true);
      const col = (name) => ADDRESS_COLUMNS.findIndex((c) => c.header === name);
      assert.deepEqual(o.r2[col('PIN')], ['012345', 's', '@']);
      assert.deepEqual(o.r2[col('Phone')], ['0987654321', 's', '@']);
      assert.equal(o.r2[col('Notes')][0], 'Line one\nLine two');
      assert.deepEqual(o.r3[col('First name')], ['=SUM(1,2)', 's']);
      assert.equal(o.r3[col('Surname')][0], 'Tom & <Jerry> "Q" \'s');
      assert.equal(o.r3[col('City')][0], 'München');
      assert.equal(o.r3[col('State')][0], 'Kārnataka ನಮಸ್ಕಾರ ✓');
      assert.deepEqual(o.r3[col('Address line 1')], ['+1 Road', 's']);
      assert.equal(o.r4[col('First name')][0], 'CtrlChars');
      assert.equal(o.r4[col('Surname')][0], '  spaced  ');
      assert.equal(o.r4[col('Notes')][0], 'emoji \u{1F600} ok');
      assert.equal(o.r4[col('PIN')][0], '000000');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
