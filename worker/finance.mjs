import {createHash, randomUUID} from 'node:crypto';
import {createDomain} from './domain.generated.mjs';
import {databaseRpc,DatabaseError} from './database.mjs';
import {googleAction,runGoogleAutomation,backupSheet,backupDue} from './google.mjs';

export const FINANCIAL_REVISION='billbills-20260914-12';
const readActions=new Set(['apiIdentity','apiBootstrap','apiList','apiImportLookups','apiPackageReceipt','apiInstallmentSchedule','apiReport','apiImportPreview','apiImportPage','apiImportStatus','apiSyncPreview','apiCalendars','apiCalendarTest','apiSyncStatus','apiExportDatabase','apiCalendarMigrationPreview']);
const googleActions=new Set(['apiBackup','apiCalendarTest','apiCalendars','apiCreateCalendar','apiSync','apiSyncPreview','apiCalendarMigrationPreview','apiCalendarMigrate','apiActivateIntegrations','apiEnableSheetBackups']);
const explicitIds={apiSave:3,apiSettings:2,apiPackageCommit:1,apiResolveMissing:3,apiImportCommit:4,apiCalendarMigrate:2};
const sha=value=>createHash('sha256').update(value).digest('hex');
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});

export class BillsBillsEngine {
  constructor(state,env){this.state=state;this.env=env;this.queue=Promise.resolve();this.pending=0;this.readCache=null;this.snapshotLoads=new Map();}
  async fetch(request){
    try{
      if(request.method!=='POST')return reply({error:'Use a supported request.'},405);
      const data=await request.json();
      if(data.kind==='automation'){
        if(this.env.DATA_BACKEND!=='supabase')return reply({skipped:true});
        return await this.automate();
      }
      const {session,action,args}=data;
      if(!session?.complete||session.user?.id!==this.env.OWNER_USER_ID||!/^[a-f0-9]{64}$/.test(session.id||'')||typeof session.token!=='string')return reply({error:'Complete owner and authenticator verification.'},403);
      if(!Array.isArray(args)||args.length>8||typeof action!=='string')return reply({error:'VALIDATION: Unsupported operation.'},400);
      if(action==='apiBackup')return await this.backup(session);
      const run=()=>this.operation(session,action,args);
      return readActions.has(action)?await run():await this.serial(run);
    }catch(error){
      const text=String(error.message||'');
      return reply({error:/^(ACCESS_DENIED|VALIDATION|CONFLICT|SCHEMA|SETUP|REVIEW|IMPORT|RECOVERY|LIMIT|CALENDAR|BACKUP|BUSY):/.test(text)?text:'REVIEW: The operation could not be completed.'},error.status||400);
    }
  }
  async serial(run){
    if(this.pending>=20)throw new DatabaseError('BUSY: Wait for the current save to finish.',429);
    this.pending++;
    const job=this.queue.then(run,run);this.queue=job.catch(()=>{});
    try{return await job;}finally{this.pending--;}
  }
  async operation(session,action,args){
    const env=this.env,mutating=!readActions.has(action),index=explicitIds[action],provided=index!==undefined?args[index]:null;
    if(provided!==null&&provided!==undefined&&!/^[A-Za-z0-9_-]{16,100}$/.test(provided))throw Error('VALIDATION: Missing operation identifier.');
    const id=mutating?(provided||randomUUID()):'',hash=sha(JSON.stringify({action,args}));
    const full=action.startsWith('apiImport')||['apiBackup','apiRecover','apiResolveMissing','apiExportDatabase'].includes(action);
    const cacheable=!mutating&&!full&&!googleActions.has(action)&&action!=='apiSyncStatus';
    let snapshot,cache,key;
    if(cacheable){
      // A fresh owner/MFA-protected version check precedes every cache hit.
      const head=await databaseRpc(env,'bb_read_version',{},session.token);
      if(head.ownerId!==session.user.id)throw Error('ACCESS_DENIED: Workspace owner mismatch.');
      const stamp=head.version+':'+head.day;
      if(this.readCache?.stamp===stamp)cache=this.readCache;
      else {
        let load=this.snapshotLoads.get(stamp);
        if(!load){load=databaseRpc(env,'bb_snapshot',{p_full:false,p_request_id:'',p_hash:''},session.token);this.snapshotLoads.set(stamp,load);}
        try{snapshot=await load;}finally{if(this.snapshotLoads.get(stamp)===load)this.snapshotLoads.delete(stamp);}
        cache={stamp:snapshot.version+':'+head.day,snapshot,results:new Map()};
        if(!this.readCache||Number(snapshot.version)>=Number(this.readCache.snapshot.version))this.readCache=cache;
      }
      snapshot=cache.snapshot;key=JSON.stringify({action,args});
      if(cache.results.has(key))return reply({data:cache.results.get(key)});
    }else snapshot=await databaseRpc(env,'bb_snapshot',{p_full:full,p_request_id:id,p_hash:hash},session.token);
    if(snapshot.replayed)return reply({data:snapshot.result});
    if(snapshot.ownerId!==session.user.id)throw Error('ACCESS_DENIED: Workspace owner mismatch.');
    const domain=createDomain(snapshot,{id:session.user.id,email:session.user.email||env.OWNER_EMAIL});
    let result;
    if(action==='apiExportDatabase')result={format:'billsbills-supabase-backup-v1',ownerEmail:env.OWNER_EMAIL,sourceSheetId:snapshot.sourceSheetId,version:snapshot.version,properties:snapshot.properties,tables:snapshot.tables,exportedAt:new Date().toISOString()};
    else if(action==='apiSyncStatus')result={databaseRevision:FINANCIAL_REVISION,version:snapshot.version,googleConfigured:!!env.GOOGLE_SERVICE_ACCOUNT_JSON,lastSync:snapshot.properties.LAST_SYNC||'',lastBackup:snapshot.properties.LAST_BACKUP||'',lastBackupVersion:snapshot.properties.LAST_BACKUP_VERSION||'',backupError:snapshot.properties.BACKUP_ERROR||'',backupRunning:!!this.backupJob};
    else if(action==='installTriggers'||action==='stopAutomation')result=domain.automate(action==='installTriggers');
    else if(action==='apiRecover'&&(snapshot.tables.Operations||[]).some(o=>o.id===args[0]&&o.kind==='DATABASE_CALENDAR_MIGRATION'))result=await googleAction(env,domain,snapshot,'apiCalendarRecover',args);
    else if(googleActions.has(action))result=await googleAction(env,domain,snapshot,action,args);
    else result=domain.call(action,args);
    if(action==='apiBootstrap'){
      result.storage='supabase';result.databaseRevision=FINANCIAL_REVISION;result.databaseVersion=snapshot.version;
      result.diagnostics.googleConfigured=!!env.GOOGLE_SERVICE_ACCOUNT_JSON;
      result.diagnostics.lastBackupVersion=snapshot.properties.LAST_BACKUP_VERSION||'';
      result.diagnostics.backupError=snapshot.properties.BACKUP_ERROR||'';
      result.diagnostics.backupRunning=!!this.backupJob;
      result.diagnostics.triggers=snapshot.properties.DATABASE_AUTOMATION==='true'?[{handler:'Cloudflare scheduled backup',id:'cloudflare'}]:[];
    }
    const changes=domain.changes(),properties=domain.properties();
    if(changes.length||mutating&&JSON.stringify(properties)!==JSON.stringify(snapshot.properties)){
      if(!mutating)throw Error('REVIEW: A read operation attempted to change records.');
      const stableResult=JSON.parse(JSON.stringify(result));
      result=await databaseRpc(env,'bb_commit',{p_owner:session.user.id,p_session:session.id,p_version:snapshot.version,p_id:id,p_hash:hash,p_changes:changes,p_properties:properties,p_result:stableResult,p_mode:'user'});
      this.readCache=null;
    }
    if(cache){if(cache.results.size>=64)cache.results.delete(cache.results.keys().next().value);cache.results.set(key,JSON.parse(JSON.stringify(result)));}
    return reply({data:result});
  }
  async backup(session=null){
    // Authorize each caller even when joining an existing backup.
    const env=this.env,snapshot=await databaseRpc(env,session?'bb_snapshot':'bb_worker_snapshot',session?{p_full:true}:{p_owner:env.OWNER_USER_ID,p_full:true},session?.token);
    if(session&&snapshot.ownerId!==session.user.id)throw Error('ACCESS_DENIED: Workspace owner mismatch.');
    if(!session&&snapshot.properties.DATABASE_AUTOMATION!=='true')return reply({skipped:true});
    if(this.backupJob)return this.backupJob.then(r=>r.clone());
    const domain=createDomain(snapshot,{id:env.OWNER_USER_ID,email:env.OWNER_EMAIL});
    if(!session&&!backupDue(domain.inspect().settings,snapshot.properties))return reply({skipped:true});
    const job=(async()=>{
      let result,error;
      try{result=await backupSheet(env,domain,snapshot);}catch(e){error=e;domain.property('BACKUP_ERROR',/^(SETUP|SCHEMA|BACKUP):/.test(e.message)?e.message:'BACKUP: Backup failed. Check Sheet sharing and retry.');}
      // Network work happens outside the financial save queue. Merge only backup
      // metadata into a fresh version, preserving every concurrent record save.
      await this.serial(async()=>{
        const current=await databaseRpc(env,session?'bb_snapshot':'bb_worker_snapshot',session?{p_full:false}:{p_owner:env.OWNER_USER_ID,p_full:false},session?.token);
        const properties={...current.properties},updated=domain.properties();
        for(const key of error?['BACKUP_ERROR']:['LAST_BACKUP','LAST_BACKUP_VERSION','BACKUP_ERROR'])properties[key]=updated[key];
        await databaseRpc(env,'bb_commit',{p_owner:env.OWNER_USER_ID,p_session:session?.id||'',p_version:current.version,p_id:randomUUID(),p_hash:sha(JSON.stringify({backup:snapshot.version,properties})),p_changes:[],p_properties:properties,p_result:result||{backupFailed:true},p_mode:session?'user':'automation'});
      });
      if(error)return reply({error:domain.properties().BACKUP_ERROR},502);
      return reply({data:result});
    })();
    this.backupJob=job;
    try{return (await job).clone();}finally{if(this.backupJob===job)this.backupJob=null;}
  }
  async automate(){
    const env=this.env;if(!env.GOOGLE_SERVICE_ACCOUNT_JSON)return reply({skipped:true});
    const snapshot=await databaseRpc(env,'bb_worker_snapshot',{p_owner:env.OWNER_USER_ID,p_full:false});
    const settings=createDomain(snapshot,{id:env.OWNER_USER_ID,email:env.OWNER_EMAIL}).inspect().settings;
    if(settings.SyncEnabled!=='true')return this.backup();
    return this.serial(()=>this.legacyAutomation());
  }
  async legacyAutomation(){
    const env=this.env;
    if(!env.GOOGLE_SERVICE_ACCOUNT_JSON)return reply({skipped:true});
    const snapshot=await databaseRpc(env,'bb_worker_snapshot',{p_owner:env.OWNER_USER_ID,p_full:true});
    if(snapshot.properties.DATABASE_AUTOMATION!=='true')return reply({skipped:true});
    const domain=createDomain(snapshot,{id:env.OWNER_USER_ID,email:env.OWNER_EMAIL});
    const result=await runGoogleAutomation(env,domain,snapshot);
    if(domain.changes().length||JSON.stringify(domain.properties())!==JSON.stringify(snapshot.properties))await databaseRpc(env,'bb_commit',{p_owner:env.OWNER_USER_ID,p_session:'',p_version:snapshot.version,p_id:randomUUID(),p_hash:sha(JSON.stringify({version:snapshot.version,kind:'automation',result})),p_changes:domain.changes(),p_properties:domain.properties(),p_result:result,p_mode:'automation'});
    return reply({data:result});
  }
}
