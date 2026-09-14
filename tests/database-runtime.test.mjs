import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {fixture} from './backend-fixture.mjs';
import {createDomain} from '../worker/domain.generated.mjs';
import {BillsBillsEngine} from '../worker/finance.mjs';
import {formatLocal,parseCsv} from '../worker/platform.mjs';

const owner={id:'11111111-1111-4111-8111-111111111111',email:'owner@example.test'};
function sample(){
 const f=fixture();f.context.setup();
 const save=(e,r)=>f.context.apiSave(e,r,'',randomUUID()).id;
 const account=save('Accounts',{bank:'Example',nickname:'Preserved account',currency:'PHP',status:'ACTIVE',reviewStatus:'VERIFIED'});
 const card=save('Cards',{accountId:account,nickname:'Preserved card',lastFour:'0123',relationship:'PRIMARY',status:'ACTIVE'});
 const transaction=save('Transactions',{accountId:account,cardId:card,transactionDate:'2026-09-01',postingDate:'2026-09-02',description:'Example item',originalDescription:'Example item',amountMinor:10000,currency:'PHP',type:'UNKNOWN',reviewStatus:'REVIEW',status:'ACTIVE'});
 const statement=save('Statements',{accountId:account,statementDate:'2026-09-03',dueDate:'2026-09-30',balanceMinor:10000,minimumMinor:1000,currency:'PHP',status:'OPEN',reconciliation:'UNVERIFIED',calendarMode:'OFF'});
 const tables={};for(const [name,s]of f.sheets){const [columns,...rows]=s.data;tables[name.slice(3)]=rows.flatMap((r,i)=>r?.some(v=>v!=='')?[{...Object.fromEntries(columns.map((c,j)=>[c,r[j]??''])),_slot:i+2}]:[]);}
 const snapshot={ownerId:owner.id,sourceSheetId:'example-workbook-id-00000000',version:1,properties:{SCHEMA_VERSION:'4',DATA_TIMEZONE:'Asia/Manila',SPREADSHEET_ID:'example-workbook-id-00000000'},tables};
 return {snapshot,account,card,transaction,statement};
}
function apply(snapshot,domain){const next=structuredClone(snapshot);for(const c of domain.changes()){next.tables[c.entity]=next.tables[c.entity].filter(r=>r._slot!==c.slot);if(c.after)next.tables[c.entity].push({...c.after,_slot:c.slot});}next.properties=domain.properties();next.version++;return next;}
function row(d,e){return d.call('apiList',[e,{},0,'updatedAt:desc']).rows[0];}

test('database domain reads preserve all current records without writes',()=>{const {snapshot}=sample(),d=createDomain(snapshot,owner);assert.equal(d.inspect().issues.filter(i=>i.severity==='ERROR').length,0);assert.equal(d.call('apiBootstrap',[]).diagnostics.storage,'Supabase');assert.equal(row(d,'Cards').lastFour,'0123');assert.equal(row(d,'Accounts').nickname,'Preserved account');assert.deepEqual(d.changes(),[]);});
test('domain rejects mismatched owner before reading',()=>assert.throws(()=>createDomain(sample().snapshot,{id:randomUUID(),email:owner.email}),/ACCESS_DENIED/));
test('classifications and new tags save in one staged operation',()=>{const {snapshot}=sample(),d=createDomain(snapshot,owner),r=row(d,'Transactions');const result=d.call('apiSave',['TransactionReviewBatch',{items:[{id:r.id,token:r._token,type:'PURCHASE',reviewStatus:'VERIFIED',tags:'Home, Shared'}],includeSummary:true},'',randomUUID()]);assert.equal(result.rows[0].type,'PURCHASE');assert.equal(result.overview.totals.PHP.spendingMinor,10000);assert.equal(d.changes().filter(c=>c.entity==='Operations').length,1);assert.equal(d.changes().filter(c=>c.entity==='Labels').length,2);assert.equal(snapshot.tables.Transactions[0].type,'UNKNOWN');});
test('stale classifications produce no staged write',()=>{const d=createDomain(sample().snapshot,owner),r=row(d,'Transactions');assert.throws(()=>d.call('apiSave',['TransactionReviewBatch',{items:[{id:r.id,token:'f'.repeat(64),type:'PURCHASE',reviewStatus:'VERIFIED',tags:''}],includeSummary:true},'',randomUUID()]),/CONFLICT/);assert.equal(d.changes().length,0);});
test('partial and remaining full payment use the existing financial ledger',()=>{const {snapshot,statement}=sample();let d=createDomain(snapshot,owner),s=row(d,'Statements');d.call('apiSave',['StatementPayment',{statementId:statement,mode:'PARTIAL',amountMinor:4000,source:'NEW',date:'2026-09-05'},s._token,randomUUID()]);const after=apply(snapshot,d);d=createDomain(after,owner);s=row(d,'Statements');assert.equal(s.remainingMinor,6000);d.call('apiSave',['StatementPayment',{statementId:statement,mode:'FULL',amountMinor:6000,source:'NEW',date:'2026-09-06'},s._token,randomUUID()]);const result=apply(after,d);assert.equal(result.tables.BankPayments.reduce((a,r)=>a+r.amountMinor,0),10000);assert.equal(row(createDomain(result,owner),'Statements').settlement,'SETTLED');});
test('overpayment rejected without a staged payment',()=>{const d=createDomain(sample().snapshot,owner),s=row(d,'Statements');assert.throws(()=>d.call('apiSave',['StatementPayment',{statementId:s.id,mode:'PARTIAL',amountMinor:11000,source:'NEW',date:'2026-09-05'},s._token,randomUUID()]),/VALIDATION/);assert.equal(d.changes().length,0);});
test('partial snapshots append audit and operation records after historical slots',()=>{const {snapshot}=sample();snapshot.maxSlots={AuditHistory:9000,Operations:3000};snapshot.tables.AuditHistory=[];snapshot.tables.Operations=[];const d=createDomain(snapshot,owner),r=row(d,'Accounts');d.call('apiSave',['Accounts',{id:r.id,nickname:'Updated'},r._token,randomUUID()]);assert.ok(d.changes().some(c=>c.entity==='AuditHistory'&&c.slot===9001));assert.ok(d.changes().some(c=>c.entity==='Operations'&&c.slot===3001));});
test('literal descriptions and notes retain apostrophes and formula-like strings',()=>{const {snapshot}=sample(),d=createDomain(snapshot,owner),r=row(d,'Transactions');d.call('apiSave',['Transactions',{id:r.id,notes:"'=literal",description:'=SUM(1,2)'},r._token,randomUUID()]);const updated=d.changes().find(c=>c.entity==='Transactions').after;assert.equal(updated.description,'=SUM(1,2)');assert.equal(updated.notes,"'=literal");});
test('CSV parsing supports quoted cells and rejects open quotes',()=>{assert.deepEqual(parseCsv('A,B\r\n"x,y","q""z"'),[['A','B'],['x,y','q"z']]);assert.throws(()=>parseCsv('"abc'),/IMPORT/);});
test('timezone offsets preserve the intended local date',()=>{assert.equal(formatLocal('2026-09-01T17:00:00Z','Asia/Manila','yyyy-MM-dd'),'2026-09-02');assert.equal(formatLocal('2026-01-01T00:00:00Z','America/New_York','Z'),'-0500');});

const cacheSource=fs.readFileSync(new URL('../public/browse-cache.js',import.meta.url),'utf8');
function cache(){const c=vm.createContext({});vm.runInContext(cacheSource,c);let time=1000;return {cache:c.createBrowseCache(()=>time),setTime:x=>time=x};}
test('browser snapshot handles type filtering and bounded pagination without a request',()=>{const {cache:c}=cache();c.load({loadedAt:1000,issues:[],tables:{Transactions:Array.from({length:85},(_,i)=>({id:String(i).padStart(3,'0'),type:i%2?'FEE':'PURCHASE',status:'ACTIVE',transactionDate:'2026-09-01',updatedAt:String(i)}))}});assert.equal(c.list('Transactions',{type:'FEE'}).total,42);assert.equal(c.list('Transactions',{},1).rows.length,40);});
test('browser data expires and clears, with server fallback for unsupported entities',()=>{const {cache:c,setTime}=cache();c.load({loadedAt:1000,issues:[],tables:{Transactions:[]}});assert.equal(c.list('Shares',{}),null);setTime(122000);assert.equal(c.list('Transactions',{}),null);c.clear();assert.equal(c.list('Transactions'),null);});
test('confirmed classification updates patch the cached row',()=>{const {cache:c}=cache();c.load({loadedAt:1000,issues:[],tables:{Transactions:[{id:'one',type:'UNKNOWN',updatedAt:''}]}});c.patch([{id:'one',type:'FEE',updatedAt:''}],[]);assert.equal(c.list('Transactions',{type:'FEE'}).total,1);});

test('financial engine denies access before any database request',async()=>{const engine=new BillsBillsEngine({}, {OWNER_USER_ID:owner.id});const response=await engine.fetch(new Request('https://internal/finance',{method:'POST',body:JSON.stringify({session:{user:owner,complete:false},action:'apiBootstrap',args:[]})}));assert.equal(response.status,403);});

test('read cache rechecks authorization and reloads on database version changes',async()=>{
 const {snapshot}=sample(),old=globalThis.fetch;let version=1,heads=0,snapshots=0,denied=false;
 globalThis.fetch=async(url)=>{if(url.endsWith('/bb_read_version')){heads++;return denied?Response.json({message:'ACCESS_DENIED: Authenticator verification required.'},{status:403}):Response.json({ownerId:owner.id,version,day:'2026-09-14'});}if(url.endsWith('/bb_snapshot')){snapshots++;return Response.json({...snapshot,version});}throw Error('Unexpected request');};
 try{const engine=new BillsBillsEngine({}, {OWNER_USER_ID:owner.id,OWNER_EMAIL:owner.email,SUPABASE_URL:'https://project.supabase.co',SUPABASE_PUBLISHABLE_KEY:'pub'}),session={user:owner,complete:true,id:'a'.repeat(64),token:'verified-token'};
 const invoke=()=>engine.fetch(new Request('https://internal/finance',{method:'POST',body:JSON.stringify({session,action:'apiBootstrap',args:[]})}));
 const first=await (await invoke()).json();assert.equal(first.data.browseSnapshot,undefined);assert.ok(first.data.reviewBatchRevision);await invoke();assert.equal(heads,2);assert.equal(snapshots,1);version++;const changed=await (await invoke()).json();assert.equal(changed.data.databaseVersion,2);assert.equal(snapshots,2);denied=true;assert.equal((await invoke()).status,403);
 }finally{globalThis.fetch=old;}
});
test('runtime calls Supabase directly and forwards exact idempotency identity',async()=>{
 const {snapshot}=sample(),old=globalThis.fetch,calls=[];let stored=structuredClone(snapshot),receipt=null;
 globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body,headers:options.headers});if(url.endsWith('/bb_snapshot'))return Response.json(receipt?{replayed:true,result:receipt}:stored);if(url.endsWith('/bb_commit')){assert.equal(body.p_owner,owner.id);assert.equal(body.p_session,'a'.repeat(64));assert.equal(body.p_version,1);receipt=body.p_result;return Response.json(receipt);}throw Error('Unexpected network call');};
 try{const engine=new BillsBillsEngine({}, {OWNER_USER_ID:owner.id,OWNER_EMAIL:owner.email,SUPABASE_URL:'https://project.supabase.co',SUPABASE_PUBLISHABLE_KEY:'publishable',SUPABASE_SECRET_KEY:'sb_secret_example'}),session={user:owner,complete:true,id:'a'.repeat(64),token:'verified-token'},d=createDomain(snapshot,owner),r=row(d,'Transactions'),id=randomUUID(),args=['TransactionReviewBatch',{items:[{id:r.id,token:r._token,type:'PURCHASE',reviewStatus:'VERIFIED',tags:''}],includeSummary:true},'',id],request=()=>new Request('https://internal/finance',{method:'POST',body:JSON.stringify({session,action:'apiSave',args})});assert.equal((await engine.fetch(request())).status,200);assert.equal((await engine.fetch(request())).status,200);assert.equal(calls.filter(c=>c.url.endsWith('/bb_commit')).length,1);assert.equal(calls[0].body.p_request_id,id);assert.equal(calls[0].headers.Authorization,'Bearer verified-token');assert.equal(calls[1].headers.apikey,'sb_secret_example');assert.ok(calls.every(c=>c.url.includes('supabase.co/rest/v1/rpc/')));}finally{globalThis.fetch=old;}
});
test('database mode keeps authentication and removes the required Apps Script address',async()=>{const {configuration}=await import('../worker/runtime.generated.mjs');const env={DATA_BACKEND:'supabase',APP_ORIGIN:'https://app.example.test',SUPABASE_URL:'https://project.supabase.co',SUPABASE_PUBLISHABLE_KEY:'pub',SUPABASE_SECRET_KEY:'sb_secret_test',OWNER_USER_ID:owner.id,OWNER_EMAIL:owner.email,OWNER_USERNAME:'owner',SESSION_KEY:'a'.repeat(64)};assert.doesNotThrow(()=>configuration(env));assert.throws(()=>configuration({...env,DATA_BACKEND:'sheets'}),/settings/);});
test('financial SQL exposes no client writes or security-definer routines',()=>{const sql=fs.readFileSync(new URL('../supabase/financial_storage.sql',import.meta.url),'utf8');assert.equal(/security\s+definer/i.test(sql),false);for(const table of ['bb_workspaces','bb_records','bb_mutations'])assert.ok(sql.includes('alter table public.'+table+' enable row level security'));assert.ok(sql.includes("(select auth.jwt()->>'aal')='aal2'"));assert.ok(sql.includes('for update;'));assert.ok(sql.includes('existing is distinct from b'));assert.ok(sql.includes('expires_at>now()'));});
test('new deployment uses a Durable Object and preserves legacy-mode default',()=>{const config=JSON.parse(fs.readFileSync(new URL('../wrangler.json',import.meta.url),'utf8'));assert.equal(config.durable_objects.bindings[0].class_name,'BillsBillsEngine');assert.deepEqual(config.migrations[0].new_sqlite_classes,['BillsBillsEngine']);assert.equal(config.vars?.DATA_BACKEND,undefined);});

test('failed manual backup commits only error metadata and normal reads remain database-only',async()=>{
 const {snapshot}=sample(),old=globalThis.fetch,calls=[];snapshot.properties.LAST_BACKUP='2026-09-01T00:00:00Z';snapshot.properties.LAST_BACKUP_VERSION='1';
 globalThis.fetch=async(url,options)=>{calls.push(url);if(url.endsWith('/bb_read_version'))return Response.json({ownerId:owner.id,version:snapshot.version,day:'2026-09-14'});if(url.endsWith('/bb_snapshot'))return Response.json(snapshot);if(url.endsWith('/bb_commit')){const body=JSON.parse(options.body);assert.deepEqual(body.p_changes,[]);assert.equal(body.p_properties.LAST_BACKUP,snapshot.properties.LAST_BACKUP);assert.equal(body.p_properties.LAST_BACKUP_VERSION,'1');assert.match(body.p_properties.BACKUP_ERROR,/service account/);return Response.json(body.p_result);}throw Error('Unexpected provider request');};
 try{const engine=new BillsBillsEngine({}, {OWNER_USER_ID:owner.id,OWNER_EMAIL:owner.email,SUPABASE_URL:'https://project.supabase.co',SUPABASE_PUBLISHABLE_KEY:'pub',SUPABASE_SECRET_KEY:'sb_secret_test'}),session={user:owner,complete:true,id:'a'.repeat(64),token:'verified-token'};
 const invoke=action=>engine.fetch(new Request('https://internal/finance',{method:'POST',body:JSON.stringify({session,action,args:[]})}));
 assert.equal((await invoke('apiBackup')).status,502);assert.equal((await invoke('apiBootstrap')).status,200);assert.ok(calls.every(url=>url.startsWith('https://project.supabase.co/')));
 }finally{globalThis.fetch=old;}
});


test('transaction due dates persist independently and filter by due date and statement date',()=>{
 const {snapshot,statement}=sample();let d=createDomain(snapshot,owner),r=row(d,'Transactions');
 d.call('apiSave',['Transactions',{id:r.id,dueDate:'2026-10-05',statementId:statement},r._token,randomUUID()]);
 d=createDomain(apply(snapshot,d),owner);const updated=row(d,'Transactions');assert.equal(updated.dueDate,'2026-10-05');assert.equal(updated.amountMinor,r.amountMinor);assert.equal(row(d,'Statements').dueDate,'2026-09-30');
 assert.equal(d.call('apiList',['Transactions',{dateBasis:'dueDate',from:'2026-10-01'},0,'dueDate:asc']).total,1);
 assert.equal(d.call('apiList',['Transactions',{statementDate:'2026-09-03'},0,'dueDate:asc']).total,1);
 assert.equal(d.call('apiList',['Transactions',{statementDate:'2026-09-04'},0,'dueDate:asc']).total,0);
 assert.throws(()=>d.call('apiSave',['Transactions',{id:updated.id,dueDate:'2026-02-30'},updated._token,randomUUID()]),/VALIDATION/);
});
test('installment linking preserves charge values and safely replays',()=>{
 let {snapshot,account,card}=sample(),d=createDomain(snapshot,owner);
 d.call('apiSave',['InstallmentPlans',{accountId:account,cardId:card,reference:'Example plan',startDate:'2026-09-01',monthlyMinor:10000,currency:'PHP',count:12,status:'ACTIVE'},'',randomUUID()]);
 snapshot=apply(snapshot,d);d=createDomain(snapshot,owner);const r=row(d,'Transactions'),plan=row(d,'InstallmentPlans'),id=randomUUID(),payload={planId:plan.id,items:[{id:r.id,token:r._token,number:1}]};
 const result=d.call('apiSave',['InstallmentLinks',payload,'',id]);assert.equal(result.rows[0].installmentPlanId,plan.id);assert.equal(result.rows[0].type,'INSTALLMENT');assert.equal(result.rows[0].amountMinor,r.amountMinor);assert.equal(result.rows[0].transactionDate,r.transactionDate);
 const after=apply(snapshot,d);d=createDomain(after,owner);assert.equal(d.call('apiSave',['InstallmentLinks',payload,'',id]).replayed,true);
 d=createDomain(snapshot,owner);assert.throws(()=>d.call('apiSave',['InstallmentLinks',{...payload,items:[{...payload.items[0],number:13}]},'',randomUUID()]),/length/);assert.equal(d.changes().length,0);
 assert.throws(()=>d.call('apiSave',['InstallmentLinks',{...payload,items:[{...payload.items[0],token:'f'.repeat(64)}]},'',randomUUID()]),/CONFLICT/);assert.equal(d.changes().length,0);
});

test('installment batch rejects duplicate numbers atomically',()=>{
 let {snapshot,account,card}=sample(),d=createDomain(snapshot,owner);
 d.call('apiSave',['InstallmentPlans',{accountId:account,cardId:card,reference:'Plan',startDate:'2026-09-01',monthlyMinor:10000,currency:'PHP',count:12,status:'ACTIVE'},'',randomUUID()]);snapshot=apply(snapshot,d);d=createDomain(snapshot,owner);
 d.call('apiSave',['Transactions',{accountId:account,cardId:card,transactionDate:'2026-10-01',description:'Next charge',amountMinor:10000,currency:'PHP',type:'PURCHASE',reviewStatus:'VERIFIED',status:'ACTIVE'},'',randomUUID()]);snapshot=apply(snapshot,d);d=createDomain(snapshot,owner);
 const plan=row(d,'InstallmentPlans'),rows=d.call('apiList',['Transactions',{},0,'transactionDate:asc']).rows;
 const payload={planId:plan.id,items:rows.map(r=>({id:r.id,token:r._token,number:1}))};assert.throws(()=>d.call('apiSave',['InstallmentLinks',payload,'',randomUUID()]),/distinct/);assert.equal(d.changes().length,0);
 payload.items[1].number=2;const result=d.call('apiSave',['InstallmentLinks',payload,'',randomUUID()]);assert.equal(result.rows.length,2);assert.equal(result.rows.reduce((sum,r)=>sum+r.amountMinor,0),20000);
});

test('overview includes past-due outstanding statements before future dates',()=>{
 const {snapshot}=sample();snapshot.tables.Statements[0].dueDate='2020-01-01';const d=createDomain(snapshot,owner),overview=d.call('apiBootstrap',[]).overview;
 assert.equal(overview.upcoming.length,1);assert.equal(overview.upcoming[0].dueDate,'2020-01-01');assert.equal(overview.upcoming[0].remainingMinor,10000);
});

test('CSV import retains Payment Due Date on the transaction',()=>{
 const {snapshot,card}=sample(),d=createDomain(snapshot,owner);
 const csv=['Source Hash,Source Row,Bank,Card,Last Four,Billing Cycle,Statement Date,Payment Due Date,Transaction Date,Posting Date,Description,Amount,Source Reference',['a'.repeat(64),'1','Example','Card','0123','','','2026-10-10','2026-09-10','2026-09-11','Imported charge','25.00','import-test'].join(',')].join('\n');
 const mappings={'Example | Card | 0123':{cardId:card,currency:'PHP'}},preview=d.call('apiImportPreview',[csv,mappings]);assert.equal(preview.counts.ACCEPTED,1);
 d.call('apiImportCommit',[csv,mappings,preview.token,[0],randomUUID()]);const imported=d.changes().find(c=>c.entity==='Transactions').after;assert.equal(imported.dueDate,'2026-10-10');assert.equal(imported.amountMinor,2500);
});
