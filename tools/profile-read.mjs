import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {createDomain} from '../worker/domain.generated.mjs';
const snapshot=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const owner={id:snapshot.ownerId||'11111111-1111-4111-8111-111111111111',email:snapshot.ownerEmail};snapshot.ownerId=owner.id;
for(const entity of ['SheetBaseline','AuditHistory','ImportRows'])delete snapshot.tables[entity];
snapshot.tables.Operations=(snapshot.tables.Operations||[]).filter(r=>!['DONE','CANCELLED'].includes(r.state));
const results=[];
for(let i=0;i<5;i++){
 const d=createDomain(snapshot,owner),start=performance.now(),boot=d.call('apiBootstrap',[]),bootstrapMs=performance.now()-start;
 const browseStart=performance.now(),browse={loadedAt:Date.now(),tables:d.browse(),issues:d.inspect().issues},browseMs=performance.now()-browseStart;
 const listStart=performance.now(),page=d.call('apiList',['Transactions',{},0,'updatedAt:desc']),listMs=performance.now()-listStart;
 results.push({bootstrapMs:Math.round(bootstrapMs),removedBrowseMs:Math.round(browseMs),listMs:Math.round(listMs),oldBootstrapBytes:Buffer.byteLength(JSON.stringify({...boot,browseSnapshot:browse})),newBootstrapBytes:Buffer.byteLength(JSON.stringify(boot)),pageRows:page.rows.length});
}
console.log(JSON.stringify({measurement:'Local CPU and payload only; excludes network and authentication',samples:results},null,2));
