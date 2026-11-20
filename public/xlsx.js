// Minimal .xlsx writer: one worksheet, every cell stored as text, bold header row, frozen header,
// column widths. No dependencies and no DOM, so it runs in the browser and in Node tests.
// The ZIP container is store-only (no compression): CRC-32, local headers, central directory.

const enc = new TextEncoder();

// ---------- ZIP (store only) ----------
let crcTable = null;
/** CRC-32 (IEEE) of a byte array. */
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

/**
 * Build a ZIP archive with every entry stored uncompressed.
 * @param {{name:string, data:Uint8Array}[]} files
 * @param {Date} [when]
 * @returns {Uint8Array}
 */
export function zipStore(files, when = new Date()) {
  const { date, time } = dosDateTime(when);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: names are UTF-8
    lv.setUint16(8, 0, true); // method 0 = stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, f.data);
    centrals.push(central);
    offset += local.length + f.data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let pos = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, pos); pos += part.length; }
  return out;
}

// ---------- XML helpers ----------
/**
 * Escape text for XML 1.0 element content and drop characters XML cannot carry
 * (control characters other than tab, newline and carriage return; lone surrogates; U+FFFE and U+FFFF).
 * Carriage returns are normalised to newlines.
 */
export function xmlText(value) {
  let out = '';
  for (const ch of String(value ?? '').replace(/\r\n?/g, '\n')) {
    const c = ch.codePointAt(0);
    const legal = c === 0x9 || c === 0xA || (c >= 0x20 && c <= 0xD7FF) || (c >= 0xE000 && c <= 0xFFFD) || (c >= 0x10000 && c <= 0x10FFFF);
    if (!legal) continue;
    out += ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch === "'" ? '&apos;' : ch;
  }
  return out;
}

/** Column letters for a 0-based index: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnName(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

// Style indexes: 0 default, 1 bold header (text), 2 body text (number format 49 = "@", so Excel keeps typed values as text).
const STYLE_HEADER = 1;
const STYLE_TEXT = 2;

const STYLES_XML = `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">`
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>'
  + '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

function cellXml(ref, value, style) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s === '') return `<c r="${ref}" s="${style}"/>`;
  const t = xmlText(s);
  const keep = /^\s|\s$|\n/.test(t) ? ' xml:space="preserve"' : '';
  // t="inlineStr": always text, never a number and never a formula, whatever the value starts with.
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t${keep}>${t}</t></is></c>`;
}

/**
 * Build an .xlsx workbook with one sheet.
 * @param {{sheetName?:string, columns:{header:string, width?:number}[], rows:(string|number|null|undefined)[][]}} spec
 * @returns {Uint8Array} the file contents
 */
export function buildXlsx({ sheetName = 'Sheet1', columns, rows }) {
  const name = xmlText(String(sheetName).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
  const lastCol = columnName(columns.length - 1);
  const lastRow = rows.length + 1;

  const sheetRows = [];
  sheetRows.push(`<row r="1">${columns.map((c, i) => cellXml(`${columnName(i)}1`, c.header, STYLE_HEADER)).join('')}</row>`);
  rows.forEach((r, n) => {
    const rn = n + 2;
    sheetRows.push(`<row r="${rn}">${columns.map((_, i) => cellXml(`${columnName(i)}${rn}`, r[i], STYLE_TEXT)).join('')}</row>`);
  });

  const sheet = `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
    + `<dimension ref="A1:${lastCol}${lastRow}"/>`
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + `<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${sheetRows.join('')}</sheetData>`
    + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
    + '</worksheet>';

  const parts = [
    ['[Content_Types].xml', `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>'],
    ['_rels/.rels', `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">`
      + `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
      + `<bookViews><workbookView/></bookViews><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">`
      + `<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES_XML],
    ['xl/worksheets/sheet1.xml', sheet],
  ];
  return zipStore(parts.map(([n, x]) => ({ name: n, data: enc.encode(x) })));
}

// ---------- the address book export ----------
/** Export columns in order: header text, address field, column width in characters. */
export const ADDRESS_COLUMNS = Object.freeze([
  { header: 'First name', key: 'first_name', width: 16 },
  { header: 'Surname', key: 'surname', width: 16 },
  { header: 'Address line 1', key: 'address_line1', width: 32 },
  { header: 'Address line 2', key: 'address_line2', width: 26 },
  { header: 'Landmark', key: 'landmark', width: 24 },
  { header: 'City', key: 'city', width: 16 },
  { header: 'State', key: 'state', width: 16 },
  { header: 'PIN', key: 'pin', width: 10 },
  { header: 'Phone', key: 'phone', width: 14 },
  { header: 'Email', key: 'email', width: 28 },
  { header: 'Group', key: 'group_name', width: 14 },
  { header: 'Notes', key: 'notes', width: 36 },
  { header: 'Added by', key: 'created_by_name', width: 16 },
]);

/** Build the "Addresses" workbook from address records as returned by /api/addresses. */
export function addressesToXlsx(addresses) {
  return buildXlsx({
    sheetName: 'Addresses',
    columns: ADDRESS_COLUMNS,
    rows: (addresses || []).map((a) => ADDRESS_COLUMNS.map((c) => a[c.key])),
  });
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
