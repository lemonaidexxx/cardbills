import {createHash} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {formatLocal} from './platform.mjs';
const encoder=new TextEncoder();
const cachedTokens=new Map();
const hash=x=>createHash('sha256').update(x).digest('hex');
const base64url=b=>Buffer.from(b).toString('base64url');
function credentials(env){let value;try{value=JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON||'');}catch{throw Error('SETUP: Add the Google service account secret for Calendar and Sheet backups.');}if(value.type!=='service_account'||!value.client_email?.endsWith('.iam.gserviceaccount.com')||!value.private_key?.includes('BEGIN PRIVATE KEY'))throw Error('SETUP: Check the Google service account secret.');return value;}
async function googleToken(env,service){
 const c=credentials(env),keyId=hash(c.client_email+c.private_key_id+service),cachedToken=cachedTokens.get(keyId);
 if(cachedToken&&cachedToken.until>Date.now()+60000)return cachedToken.token;
 const scope=service==='sheets'?'https://www.googleapis.com/auth/spreadsheets':'https://www.googleapis.com/auth/calendar';
 const now=Math.floor(Date.now()/1000),head=base64url(JSON.stringify({alg:'RS256',typ:'JWT'})),payload=base64url(JSON.stringify({iss:c.client_email,scope,aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
 const key=await crypto.subtle.importKey('pkcs8',Buffer.from(c.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,''),'base64'),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
 const content=head+'.'+payload,signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,encoder.encode(content));
 const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:content+'.'+base64url(signature)}),signal:AbortSignal.timeout(20000)});
 const body=await response.json();if(!response.ok||!body.access_token)throw Error('SETUP: Google authorization failed. Check the service account and enabled APIs.');
 cachedTokens.set(keyId,{token:body.access_token,until:Date.now()+Number(body.expires_in||3600)*1000});return body.access_token;
}
async function call(env,service,path,method='GET',body){
 const bases={calendar:'https://www.googleapis.com/calendar/v3/',sheets:'https://sheets.googleapis.com/v4/'};
 if(!bases[service]||path.includes('://'))throw Error('VALIDATION: Invalid Google operation.');
 let response;try{response=await fetch(bases[service]+path,{method,headers:{Authorization:'Bearer '+await googleToken(env,service),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});}catch(e){if(/^(SETUP|VALIDATION):/.test(e.message))throw e;throw Error((service==='sheets'?'BACKUP':'CALENDAR')+': Google response was interrupted. Retry to check its result.');}
 if(response.status===404&&method==='GET')return null;
 const data=await response.json().catch(()=>({}));
 if(!response.ok){const error=Error((service==='sheets'?'BACKUP':'CALENDAR')+': Google rejected the request. Check sharing permissions and API configuration.');error.googleStatus=response.status;throw error;}
 return data;
}
const eventPath=(cal,id)=>'calendars/'+encodeURIComponent(cal)+'/events/'+encodeURIComponent(id);
async function findLinked(env,cal,marker){let token='',found=[];do{const q=new URLSearchParams({q:marker,maxResults:'100',showDeleted:'false',singleEvents:'true',...(token?{pageToken:token}:{})});const result=await call(env,'calendar','calendars/'+encodeURIComponent(cal)+'/events?'+q);found.push(...(result?.items||[]).filter(e=>String(e.description||'').replace(/<[^>]*>/g,'\n').split(/\r?\n/).map(x=>x.trim()).includes(marker)));token=result?.nextPageToken||'';if(found.length>1)throw Error('CALENDAR: Duplicate linked events require review.');}while(token);return found[0]||null;}
export async function syncCalendar(env,domain,snapshot,force=true){
 const {settings,plans}=domain.calendarPlans();if(settings.SyncEnabled!=='true')return {processed:0,failed:0,remaining:0,message:'Synchronization is disabled.'};
 let processed=0,failed=0,remaining=0;const deadline=Date.now()+18000;
 for(const {statement:s,plan:p,marker,entity='Statements'}of plans){
  if(p.skip)continue;if(!force&&s.nextRetry&&Date.parse(s.nextRetry)>Date.now()){remaining++;continue;}if(s.eventId&&s.fingerprint===p.fingerprint&&!s.syncError&&Date.now()-Date.parse(s.syncedAt||'1970-01-01')<86400000)continue;
  if(processed+failed>=4||Date.now()>deadline){remaining++;continue;}
  try{
   let event=s.eventId?await call(env,'calendar',eventPath(p.cal,s.eventId)):await findLinked(env,p.cal,marker);
   if(event){const own=domain.calendarOwned(event,s);const markerMatch=String(event.description||'').replace(/<[^>]*>/g,'\n').split(/\r?\n/).map(x=>x.trim()).includes(marker);const date=event.start?.dateTime?formatLocal(new Date(event.start.dateTime),settings.Timezone,'yyyy-MM-dd'):event.start?.date;
    if(event.status==='cancelled'||event.recurringEventId||(event.attendees||[]).length||!own&&(!markerMatch||event.visibility!=='private'||date!==s.dueDate))throw Error('CALENDAR: Existing event ownership needs review.');p.id=event.id;
    await call(env,'calendar',eventPath(p.cal,p.id)+'?sendUpdates=none','PATCH',p.body);
   }else{
    try{await call(env,'calendar','calendars/'+encodeURIComponent(p.cal)+'/events?sendUpdates=none','POST',{id:p.id,...p.body});}
    catch(error){if(error.googleStatus!==409)throw error;const recovered=await call(env,'calendar',eventPath(p.cal,p.id));if(!domain.calendarOwned(recovered,s))throw error;await call(env,'calendar',eventPath(p.cal,p.id)+'?sendUpdates=none','PATCH',p.body);}
   }
   const now=new Date().toISOString();domain.writeCalendar(s,{...s,calendarId:p.cal,eventId:p.id,syncedAt:now,fingerprint:p.fingerprint,syncError:'',attempts:0,nextRetry:'',dueDate:p.dueDate||s.dueDate,revision:Number(s.revision)+1,updatedAt:now},entity);processed++;
  }catch{failed++;domain.writeCalendar(s,{...s,syncError:'Calendar synchronization needs review.',attempts:Number(s.attempts||0)+1,nextRetry:new Date(Date.now()+120000).toISOString(),revision:Number(s.revision)+1,updatedAt:new Date().toISOString()},entity);}
 }
 domain.property('LAST_SYNC',new Date().toISOString());return {processed,failed,remaining,message:failed?'Some Calendar entries need review.':remaining?'More entries remain in the synchronization queue.':'Calendar synchronization completed.'};
}
export async function backupSheet(env,domain,snapshot){
 const id=snapshot.sourceSheetId;if(!/^[A-Za-z0-9_-]{20,}$/.test(id||''))throw Error('SETUP: Select the backup spreadsheet.');
 const metadata=await call(env,'sheets','spreadsheets/'+encodeURIComponent(id)+'?fields=sheets.properties');if(!metadata)throw Error('SETUP: The backup spreadsheet is unavailable.');
 const tables=domain.snapshot(),schema=domain.inspect().schema,requests=[];let nextSheetId=Math.max(0,...metadata.sheets.map(s=>s.properties.sheetId))+1;
 for(const [entity,rows]of Object.entries(tables)){
  const name='CC_'+entity;let match=metadata.sheets.find(s=>s.properties.title===name);if(!match&&['LoanCalendar','Loans','LoanSchedules','LoanPayments','LoanAllocations'].includes(entity)){const properties={sheetId:nextSheetId++,title:name,gridProperties:{rowCount:1000,columnCount:30}};requests.push({addSheet:{properties}});match={properties};}if(!match)throw Error('SCHEMA: Backup table '+name+' is missing.');
  const properties=match.properties,headers=['id','revision','createdAt','updatedAt',...schema[entity].split(' ')],last=Math.max(1,...rows.map((r,i)=>r._slot||i+2));
  if(properties.gridProperties.rowCount<last||properties.gridProperties.columnCount<headers.length)requests.push({updateSheetProperties:{properties:{sheetId:properties.sheetId,gridProperties:{rowCount:Math.max(last,properties.gridProperties.rowCount),columnCount:Math.max(headers.length,properties.gridProperties.columnCount)}},fields:'gridProperties.rowCount,gridProperties.columnCount'}});
  const cells=Array.from({length:Math.max(last,properties.gridProperties.rowCount)},()=>({values:headers.map(()=>({}))}));
  const cell=v=>v===null||v===undefined||v===''?{}:{userEnteredValue:typeof v==='number'?{numberValue:v}:{stringValue:String(v)}};
  cells[0]={values:headers.map(cell)};rows.forEach((r,i)=>cells[(r._slot||i+2)-1]={values:headers.map(k=>cell(r[k]))});
  requests.push({updateCells:{range:{sheetId:properties.sheetId,startRowIndex:0,endRowIndex:Math.max(last,properties.gridProperties.rowCount),startColumnIndex:0,endColumnIndex:headers.length},rows:cells,fields:'userEnteredValue'}});
 }
 await call(env,'sheets','spreadsheets/'+encodeURIComponent(id)+':batchUpdate','POST',{requests});
 domain.property('LAST_BACKUP',new Date().toISOString());domain.property('LAST_BACKUP_VERSION',String(snapshot.version));domain.property('BACKUP_ERROR','');return {id,message:'Daily backup completed.',databaseVersion:snapshot.version};
}
export async function googleAction(env,domain,snapshot,action,args){
 if(action==='apiSyncPreview'){const {plans}=domain.calendarPlans();return plans.map(({statement:s,plan:p,entity='Statements',label})=>({id:s.id,entity,label:label||'',dueDate:p.dueDate||s.dueDate,action:p.skip?(p.reason||'SKIP'):p.disabled?'HISTORY / SILENT':s.eventId?'UPDATE':'CREATE / LINK'}));}
 if(action==='apiBackup')return backupSheet(env,domain,snapshot);
 if(action==='apiSync')return syncCalendar(env,domain,snapshot);
 const settings=domain.inspect().settings;
 if(action==='apiEnableCalendarSync')return enableCalendarSync(env,domain,snapshot);
 if(action==='apiActivateIntegrations')return activateIntegrations(env,domain,snapshot);
 if(action==='apiEnableSheetBackups')return activateSheetBackups(env,domain,snapshot);
 if(action==='apiCalendarTest'){const c=await call(env,'calendar','calendars/'+encodeURIComponent(settings.CalendarId));if(!c)throw Error('CALENDAR: Share the selected calendar with the Google service account.');return {connected:true,timeZone:c.timeZone};}
 if(action==='apiCalendars'){const c=await call(env,'calendar','calendars/'+encodeURIComponent(settings.CalendarId||env.OWNER_EMAIL));return c?[{id:c.id,label:c.summary||c.id}]:[];}
 if(action==='apiCreateCalendar'){const c=await call(env,'calendar','calendars','POST',{summary:'BillBills reminders',timeZone:settings.Timezone});await call(env,'calendar','calendars/'+encodeURIComponent(c.id)+'/acl?sendNotifications=false','POST',{role:'owner',scope:{type:'user',value:env.OWNER_EMAIL}});return {id:c.id,label:c.summary};}
 if(action==='apiCalendarMigrationPreview'){
  const target=String(args[0]||'');if(!target||target.length>300)throw Error('VALIDATION: Choose a calendar.');const c=await call(env,'calendar','calendars/'+encodeURIComponent(target));if(!c)throw Error('CALENDAR: Target calendar is unavailable.');
  return {target,token:hash(JSON.stringify({target,version:snapshot.version,old:settings.CalendarId})),eventsToRetire:['Statements','LoanCalendar'].reduce((n,e)=>n+(snapshot.tables[e]||[]).filter(s=>s.eventId&&(!s.calendarId||s.calendarId===settings.CalendarId)).length,0),message:'Move future synchronization to '+(c.summary||target)+'. Existing linked events will be retained with reminders disabled.'};
 }
 if(action==='apiCalendarMigrate')return beginCalendarMigration(env,domain,snapshot,args);
 if(action==='apiCalendarRecover')return resumeCalendarMigration(env,domain,snapshot,args[0]);
 throw Error('VALIDATION: Unsupported Google operation.');
}
export async function runGoogleAutomation(env,domain,snapshot){
 let sync={processed:0,failed:0,remaining:0};const settings=domain.inspect().settings;
 if(settings.SyncEnabled==='true')sync=await syncCalendar(env,domain,snapshot,false);
 if(backupDue(settings,snapshot.properties))try{await backupSheet(env,domain,snapshot);}catch(error){domain.property('BACKUP_ERROR',String(error.message));sync.backupFailed=true;}
 return sync;
}

export function backupDue(settings,properties,now=Date.now()){
 const last=Date.parse(properties.LAST_BACKUP||''),days=Number(settings.BackupDays||1);
 return settings.BackupEnabled==='true'&&(!Number.isFinite(last)||now-last>=Math.max(1,Number.isFinite(days)?days:1)*86400000);
}

export async function activateSheetBackups(env,domain,snapshot){
 const sheet=await call(env,'sheets','spreadsheets/'+encodeURIComponent(snapshot.sourceSheetId)+'?fields=spreadsheetId');
 if(!sheet)throw Error('SETUP: Share the backup Sheet with the Google service account as an editor.');
 if((snapshot.tables.Operations||[]).some(o=>!['DONE','CANCELLED'].includes(o.state)))throw Error('RECOVERY: Resolve pending operations first.');
 const changes=[],now=new Date().toISOString();
 for(const [key,value]of Object.entries({BackupEnabled:'true',BackupDays:'1',SyncEnabled:'false'})){
  const found=(snapshot.tables.Settings||[]).find(r=>r.key===key);if(!found)throw Error('SCHEMA: Required backup setting is missing.');
  const before={...found};delete before._slot;
  if(before.value!==value)changes.push({entity:'Settings',before,after:{...before,value,revision:Number(before.revision)+1,updatedAt:now}});
 }
 if(changes.length)domain.integrationCommit(changes,crypto.randomUUID(),'ENABLE_SHEETS_BACKUPS');
 domain.property('DATABASE_AUTOMATION','true');
 return {enabled:true,backupSheet:snapshot.sourceSheetId,message:'Daily Sheets backups enabled. Calendar synchronization is disabled.'};
}

async function beginCalendarMigration(env,domain,snapshot,args){
 const [target,token,id]=args,settings=domain.inspect().settings;
 if(token!==hash(JSON.stringify({target,version:snapshot.version,old:settings.CalendarId})))throw Error('CONFLICT: Calendar selection changed. Preview again.');
 if((snapshot.tables.Operations||[]).some(o=>!['DONE','CANCELLED'].includes(o.state)))throw Error('RECOVERY: Resolve the pending operation first.');
 if(target===settings.CalendarId)return {changed:false};
 const destination=await call(env,'calendar','calendars/'+encodeURIComponent(target));if(!destination)throw Error('CALENDAR: Target calendar is unavailable.');
 const operation=domain.integrationOperation(id,'DATABASE_CALENDAR_MIGRATION',{target,old:settings.CalendarId,remaining:['Statements','LoanCalendar'].flatMap(entity=>(snapshot.tables[entity]||[]).filter(s=>s.eventId&&(!s.calendarId||s.calendarId===settings.CalendarId)).map(s=>({entity,id:s.id})))});
 return {pending:true,id:operation.id,message:'Calendar migration is prepared. Use Resume in Diagnostics and recovery.'};
}
async function resumeCalendarMigration(env,domain,snapshot,id){
 const operation=(snapshot.tables.Operations||[]).find(o=>o.id===id&&o.kind==='DATABASE_CALENDAR_MIGRATION');if(!operation||operation.state==='DONE')return {done:true};
 const before={...operation};delete before._slot;
 const payload=JSON.parse(before.payload),remaining=[...payload.remaining];let processed=0;
 for(const statementId of remaining.slice(0,4)){
  const entity=typeof statementId==='string'?'Statements':statementId.entity;const s=(snapshot.tables[entity]||[]).find(s=>s.id===(typeof statementId==='string'?statementId:statementId.id));if(!s)throw Error('CALENDAR: Linked statement is missing.');
  const event=await call(env,'calendar',eventPath(s.calendarId||payload.old,s.eventId));
  if(event){if(!domain.calendarOwned(event,s)||(event.attendees||[]).length)throw Error('CALENDAR: Event ownership requires review.');await call(env,'calendar',eventPath(s.calendarId||payload.old,s.eventId)+'?sendUpdates=none','PATCH',{reminders:{useDefault:false,overrides:[]}});}
  remaining.shift();processed++;
 }
 const now=new Date().toISOString();
 if(remaining.length){domain.integrationWrite('Operations',before,{...before,payload:JSON.stringify({...payload,remaining}),revision:Number(before.revision)+1,updatedAt:now});return {pending:true,id,processed,remaining:remaining.length};}
 const clean=r=>{const x={...r};delete x._slot;return x;};
 const setting=clean((snapshot.tables.Settings||[]).find(r=>r.key==='CalendarId'));
 const changes=[{entity:'Settings',before:setting,after:{...setting,value:payload.target,revision:Number(setting.revision)+1,updatedAt:now}},...(snapshot.tables.Statements||[]).filter(s=>s.eventId).map(s=>{const b=clean(s);return {entity:'Statements',before:b,after:{...b,calendarId:'',eventId:'',syncedAt:'',fingerprint:'',syncError:'',attempts:0,nextRetry:'',revision:Number(b.revision)+1,updatedAt:now}};})];
 domain.integrationWrite('Operations',before,{...before,state:'DONE',payload:JSON.stringify({...payload,remaining:[]}),revision:Number(before.revision)+1,updatedAt:now});
 domain.integrationCommit(changes,crypto.randomUUID(),'CALENDAR_SELECTION');return {done:true,processed};
}

async function activateIntegrations(env,domain,snapshot){
 const settings=domain.inspect().settings,target=settings.CalendarId||env.OWNER_EMAIL;
 const calendar=await call(env,'calendar','calendars/'+encodeURIComponent(target));
 const sheet=await call(env,'sheets','spreadsheets/'+encodeURIComponent(snapshot.sourceSheetId)+'?fields=spreadsheetId');
 if(!calendar||!sheet)throw Error('SETUP: Share the selected calendar and backup Sheet with the service account.');
 if((snapshot.tables.Operations||[]).some(o=>!['DONE','CANCELLED'].includes(o.state)))throw Error('RECOVERY: Resolve pending operations first.');
 const now=new Date().toISOString(),changes=[],clean=r=>{const v={...r};delete v._slot;return v;};
 const values={CalendarId:target,SyncEnabled:'true',IncludeHistorical:'true',BackupEnabled:'true'};
 for(const [key,value]of Object.entries(values)){
  const found=(snapshot.tables.Settings||[]).find(r=>r.key===key);if(!found)throw Error('SCHEMA: Required integration setting is missing.');
  const before=clean(found);if(before.value!==value)changes.push({entity:'Settings',before,after:{...before,value,revision:Number(before.revision)+1,updatedAt:now}});
 }
 for(const found of snapshot.tables.Statements||[]){const before=clean(found);if(before.status==='OPEN'&&before.calendarMode==='OFF')changes.push({entity:'Statements',before,after:{...before,calendarMode:'ON',revision:Number(before.revision)+1,updatedAt:now}});}
 if(changes.length)domain.integrationCommit(changes,crypto.randomUUID(),'ENABLE_INTEGRATIONS');
 domain.property('DATABASE_AUTOMATION','true');
 return {enabled:true,calendar:target,backupSheet:snapshot.sourceSheetId,message:'Calendar and scheduled Sheet backups enabled.'};
}

async function enableCalendarSync(env,domain,snapshot){
 const settings=domain.inspect().settings,target=settings.CalendarId;
 if(!target)throw Error('CALENDAR: Select and share a calendar first.');
 const calendar=await call(env,'calendar','calendars/'+encodeURIComponent(target));if(!calendar)throw Error('CALENDAR: Share the selected calendar with the service account.');
 let acl;try{acl=await call(env,'calendar','calendars/'+encodeURIComponent(target)+'/acl');}catch(e){if(e.googleStatus!==403)throw e;}const own=(acl?.items||[]).some(r=>r.scope?.value===credentials(env).client_email&&r.role==='owner');
 if(calendar.summary==='BillsBills reminders'&&own)await call(env,'calendar','calendars/'+encodeURIComponent(target),'PATCH',{summary:'BillBills reminders'});
 if((snapshot.tables.Operations||[]).some(o=>!['DONE','CANCELLED'].includes(o.state)))throw Error('RECOVERY: Resolve pending operations first.');
 const changes=[],now=new Date().toISOString();for(const [key,value]of Object.entries({SyncEnabled:'true',IncludeHistorical:'true'})){const found=snapshot.tables.Settings.find(r=>r.key===key);if(!found)throw Error('SCHEMA: Calendar setting is missing.');const before={...found};delete before._slot;if(before.value!==value)changes.push({entity:'Settings',before,after:{...before,value,revision:Number(before.revision)+1,updatedAt:now}});}
 if(changes.length)domain.integrationCommit(changes,crypto.randomUUID(),'ENABLE_CALENDAR_SYNC');domain.property('DATABASE_AUTOMATION','true');return {enabled:true,message:'BillBills Calendar synchronization enabled for statements and loans.'};
}
