import vm from 'node:vm';
import fs from 'node:fs';
import crypto from 'node:crypto';

export function fixture() {
  const properties = { OWNER_EMAIL: 'owner@example.test', OWNER_USER_ID: '11111111-1111-4111-8111-111111111111', SPREADSHEET_ID: 'test-workbook', BRIDGE_SECRET: 'a'.repeat(64) };
  let active = properties.OWNER_EMAIL;
  const propApi = { getProperty: key => properties[key] || null, setProperty: (key, value) => { properties[key] = value; return propApi; }, getProperties: () => ({ ...properties }), deleteProperty: key => { delete properties[key]; return propApi; } };
  class Range {
    constructor(sheet, row, col, height = 1, width = 1) { Object.assign(this, { sheet, row, col, height, width }); }
    getValues() { return Array.from({ length: this.height }, (_, r) => Array.from({ length: this.width }, (_, c) => this.sheet.data[this.row + r - 1]?.[this.col + c - 1] ?? '')); }
    getFormulas() { return this.getValues().map(row => row.map(() => '')); }
    setValues(rows) { rows.forEach((row, r) => row.forEach((value, c) => { const index = this.row + r - 1; this.sheet.data[index] ||= []; this.sheet.data[index][this.col + c - 1] = typeof value === 'string' && value.startsWith("'") ? value.slice(1) : value; })); return this; }
    setValue(value) { return this.setValues([[value]]); }
    setFontWeight() { return this; }
    setBackground() { return this; }
    setNumberFormat() { return this; }
    setDataValidation() { return this; }
    protect() { return this; }
    setDescription() { return this; }
    setWarningOnly() { return this; }
    clearContent() { return this.setValues(Array.from({ length: this.height }, () => Array(this.width).fill(''))); }
  }
  class Sheet {
    constructor(name) { this.name = name; this.data = []; this.maxRows = 1000; }
    getName() { return this.name; }
    getRange(...args) { return new Range(this, ...args); }
    getLastRow() { let n = this.data.length; while (n && !(this.data[n - 1] || []).some(x => x !== '')) n--; return n; }
    getLastColumn() { return Math.max(0, ...this.data.map(row => row.length)); }
    getMaxRows() { return this.maxRows; }
    insertRowsAfter(_, count) { this.maxRows += count; }
    setFrozenRows() {}
  }
  const sheets = new Map();
  const book = { getId: () => properties.SPREADSHEET_ID, getSheetByName: name => sheets.get(name), insertSheet: name => { const s = new Sheet(name); sheets.set(name, s); return s; }, getSheets: () => [...sheets.values()], setSpreadsheetTimeZone() {} };
  const builder = { requireValueInList() { return this; }, setAllowInvalid() { return this; }, build() { return {}; } };
  const formatDate = (date, zone, format) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(p => [p.type, p.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`, time = `${parts.hour}:${parts.minute}`;
    if (format === 'HH:mm') return time;
    if (format === 'yyyy-MM-dd HH:mm') return `${day} ${time}`;
    if (format === 'yyyy-MM-dd') return day;
    if (format === 'Z') return zone === 'UTC' ? '+0000' : '+0800';
    return date.toISOString();
  };
  const context = vm.createContext({ console, Date, Intl, Buffer,
    PropertiesService: { getScriptProperties: () => propApi },
    Session: { getActiveUser: () => ({ getEmail: () => active }), getEffectiveUser: () => ({ getEmail: () => properties.OWNER_EMAIL }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: { getUuid: () => crypto.randomUUID(), DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (_, value) => [...crypto.createHash('sha256').update(value).digest()], computeHmacSha256Signature: (value, key) => [...crypto.createHmac('sha256', key).update(value).digest()], formatDate },
    SpreadsheetApp: { openById: () => book, getActiveSpreadsheet: () => book, newDataValidation: () => builder, flush() {} },
    ScriptApp: { getProjectTriggers: () => [] },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) }
  });
  const base = new URL('../apps-script/', import.meta.url);
  vm.runInContext(fs.readFileSync(new URL('Code.gs', base), 'utf8') + '\n' + fs.readFileSync(new URL('Gateway.gs', base), 'utf8'), context);
  return { context, properties, book, sheets, setActive: email => { active = email; }, evaluate: text => vm.runInContext(text, context) };
}
