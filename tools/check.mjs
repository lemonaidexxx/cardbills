import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const root=new URL('../',import.meta.url);
const read=name=>fs.readFileSync(new URL(name,root),'utf8');
const worker=read('worker/auth-source.mjs'),backend=read('apps-script/Code.gs')+'\n'+read('apps-script/Gateway.gs');
new vm.Script(backend);
for(const file of ['public/app.js','public/login.js'])new vm.Script(read(file));
execFileSync(process.execPath,['--check',fileURLToPath(new URL('worker/index.mjs',root))]);
const wrangler=JSON.parse(read('wrangler.json'));assert.equal(wrangler.assets.html_handling,'none');assert.equal(wrangler.assets.run_worker_first,true);JSON.parse(read('apps-script/appsscript.json'));
const methods=JSON.parse(worker.match(/const rpcMethods = new Set\((\[[^\n]+\])\);/)[1]);
for(const name of methods)assert.match(backend,new RegExp('function '+name+'\\('),name+' must exist');
const gatewayMethods=read('apps-script/Gateway.gs').match(/const actions=\{([^}]+)\}/)[1].split(',');
assert.deepEqual([...methods].sort(),gatewayMethods.sort());
for(const name of ['public/app.js','public/login.js','public/app.html','public/login.html']){
  const content=read(name);
  assert.equal(/SUPABASE_SECRET_KEY|BRIDGE_SECRET|SESSION_KEY|service_role/.test(content),false,name+' must use the application API');
}
for(const name of ['public/app.html','public/login.html']){
  for(const match of read(name).matchAll(/(?:src|href)="\/(.*?)"/g))assert.ok(fs.existsSync(new URL('public/'+match[1].split('?')[0],root)),match[1]);
}
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  if(['node_modules','.git','.wrangler'].includes(entry.name))continue;
  const full=path.join(dir,entry.name);
  if(entry.name==='01_Install_And_Import.sql'||entry.name==='current-ledger.json')throw Error('Keep the private migration outside the repository.');
  if(entry.isDirectory())walk(full);else assert.equal(/\.(xlsx|csv|cardbills\.json)$/i.test(entry.name),false,'Keep private import data outside the source project');
}}
walk(fileURLToPath(root));
console.log('Syntax, RPC allowlists, asset references and source-package checks passed.');
