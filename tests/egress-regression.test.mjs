import test from 'node:test';
import assert from 'node:assert/strict';
import {BillsBillsEngine} from '../worker/finance.mjs';
import {databaseRpc} from '../worker/database.mjs';
import {serviceRestriction} from '../worker/service-errors.mjs';

const env={OWNER_USER_ID:'11111111-1111-4111-8111-111111111111',SUPABASE_URL:'https://example.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_test',GOOGLE_SERVICE_ACCOUNT_JSON:'configured'};
function scheduled(t,properties,settings){
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    calls.push(String(url));assert.equal(init.method,'GET');assert.equal(init.headers.apikey,env.SUPABASE_SECRET_KEY);
    const path=new URL(url);assert.equal(path.searchParams.get('owner_id'),'eq.'+env.OWNER_USER_ID);
    if(path.pathname.endsWith('/bb_workspaces'))return Response.json([{properties}]);
    if(path.pathname.endsWith('/bb_records')){assert.equal(path.searchParams.get('entity'),'eq.Settings');assert.equal(path.searchParams.get('limit'),'3');return Response.json(Object.entries(settings).map(([key,value])=>({key,value})));}
    throw Error('Unexpected full financial snapshot');
  });
  const engine=new BillsBillsEngine({},env),jobs=[];
  engine.backup=async()=>{jobs.push('backup');return Response.json({done:true});};
  engine.legacyAutomation=async()=>{jobs.push('calendar');return Response.json({done:true});};
  return {engine,calls,jobs};
}
test('disabled automation downloads no financial records or settings',async t=>{
  const p=scheduled(t,{DATABASE_AUTOMATION:'false'},{});assert.equal((await (await p.engine.automate()).json()).skipped,true);assert.equal(p.calls.length,1);assert.deepEqual(p.jobs,[]);
});
test('completed nightly jobs use only bounded metadata reads on subsequent ticks',async t=>{
  const p=scheduled(t,{DATABASE_AUTOMATION:'true',LAST_SYNC:new Date().toISOString(),LAST_BACKUP:new Date().toISOString()},{Timezone:'Asia/Manila',SyncEnabled:'true',BackupEnabled:'true'});
  await p.engine.automate();await p.engine.automate();assert.equal(p.calls.length,4);assert.deepEqual(p.jobs,[]);
});
test('only due jobs run, and calendar failure does not block backup',async t=>{
  const p=scheduled(t,{DATABASE_AUTOMATION:'true',LAST_SYNC:new Date().toISOString()},{Timezone:'Asia/Manila',SyncEnabled:'true',BackupEnabled:'true'});
  await p.engine.automate();assert.deepEqual(p.jobs,['backup']);
});
test('failed calendar job retains independent due backup',async t=>{
  const p=scheduled(t,{DATABASE_AUTOMATION:'true'},{Timezone:'Asia/Manila',SyncEnabled:'true',BackupEnabled:'true'});
  p.engine.legacyAutomation=async()=>{p.jobs.push('calendar');throw Error('Provider unavailable');};
  await p.engine.automate();assert.deepEqual(p.jobs,['calendar','backup']);
});
test('quota failures are actionable and never expose provider text',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({message:'restricted exceed_egress_quota private credential'},{status:402}));
  await assert.rejects(databaseRpc(env,'bb_snapshot',{}),e=>e.status===503&&/data-transfer quota exceeded/.test(e.message)&&!e.message.includes('private credential'));
  assert.match(serviceRestriction(402,{}),/restricted/);assert.equal(serviceRestriction(401,{}),null);
});
