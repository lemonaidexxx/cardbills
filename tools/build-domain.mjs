import fs from 'node:fs';
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const names = ['guard_', 'locked_', 'baselineChange_', 'saveBaseline_', 'diagnostics_'];
let body = ['domain/base.js', 'domain/import.js', 'domain/workflows.js'].map(read).join('\n');
for (const name of names) body = body.replace(new RegExp('function ' + name + '\\('), 'function legacy_' + name + '(');
const module = `import { createPlatform } from './platform.mjs';\nexport function createDomain(snapshot, owner) {\nconst platform = createPlatform(snapshot, owner);\nconst {PropertiesService, Session, LockService, Utilities, SpreadsheetApp, ScriptApp, ContentService, Calendar, HtmlService} = platform;\n${body}\n${read('worker/domain-adapter.txt')}\n}\n`;
fs.writeFileSync(new URL('../worker/domain.generated.mjs', import.meta.url), module);
console.log('Built isolated financial domain module.');
