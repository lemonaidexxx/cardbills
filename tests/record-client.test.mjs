import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8').split('(() => {')[0];
function client(send){const context=vm.createContext({setTimeout});vm.runInContext(source,context);return context.createRecordClient(send);}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('independent reads run together and duplicate reads share a request',async()=>{
 const calls=[],done=[];const call=client(payload=>new Promise(resolve=>{calls.push(JSON.parse(payload));done.push(resolve);}));
 const first=call('apiList',['Transactions']),duplicate=call('apiList',['Transactions']),second=call('apiList',['Cards']);
 assert.equal(calls.length,2);done[1]('cards');assert.equal(await second,'cards');done[0]('transactions');assert.equal(await first,'transactions');assert.equal(await duplicate,'transactions');
});
test('writes form a barrier between reads and preserve submission order',async()=>{
 const calls=[],done=[];const call=client(payload=>new Promise(resolve=>{calls.push(JSON.parse(payload).action);done.push(resolve);}));
 const jobs=[call('apiList',[]),call('apiSave',['first']),call('apiSave',['second']),call('apiBootstrap',[])];
 assert.deepEqual(calls,['apiList']);done.shift()(1);await tick();assert.deepEqual(calls,['apiList','apiSave']);done.shift()(2);await tick();assert.equal(calls.length,3);done.shift()(3);await tick();assert.equal(calls.at(-1),'apiBootstrap');done.shift()(4);await Promise.all(jobs);
});
test('obsolete queued reads are skipped and failures release the queue',async()=>{
 let finish,keep=true;const calls=[];const call=client(payload=>{const name=JSON.parse(payload).action;calls.push(name);return name==='apiSave'?new Promise(resolve=>finish=resolve):Promise.reject(Error('failed'));});
 const save=call('apiSave'),stale=call('apiList',[],()=>keep);keep=false;finish();await save;assert.equal(await stale,null);assert.deepEqual(calls,['apiSave']);await assert.rejects(call('apiBootstrap'),/failed/);await assert.rejects(call('apiList'),/failed/);
});

test('due countdown uses calendar dates and distinguishes unpaid overdue dates',()=>{const c=vm.createContext({});vm.runInContext(source,c);assert.equal(c.statementDueLabel('2027-01-01','2026-12-31'),'Due in 1 day');assert.equal(c.statementDueLabel('2026-03-01','2026-02-27'),'Due in 2 days');assert.equal(c.statementDueLabel('2026-09-14','2026-09-14'),'Due today');assert.equal(c.statementDueLabel('2026-09-13','2026-09-14'),'Past due');});

 test('bulk drafts preserve untouched fields and prior edits until acknowledged',()=>{
 const c=vm.createContext({});vm.runInContext(source,c);const drafts=c.createTransactionDrafts(),row={id:'a',_token:'original',type:'PURCHASE',reviewStatus:'REVIEW',tags:'Travel',category:'Food',dueDate:'2026-10-01',notes:'Original'};
 drafts.track(row);drafts.stage(row,{type:'FEE'});drafts.stage(row,{dueDate:'',notes:'Updated'});
 const item=drafts.batches()[0][0];assert.equal(item.type,'FEE');assert.equal(item.category,'Food');assert.equal(item.tags,'Travel');assert.equal(item.dueDate,'');assert.equal(item.notes,'Updated');assert.equal(item.token,'original');assert.equal(row.notes,'Original');
 drafts.accept([{...row,notes:'Updated',_token:'saved'}]);assert.equal(drafts.size(),0);assert.equal(row.notes,'Updated');
 });
