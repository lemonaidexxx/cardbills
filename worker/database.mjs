import {serviceRestriction} from './service-errors.mjs';
export class DatabaseError extends Error {
  constructor(message,status=503){super(message);this.status=status;}
}
const known=/^(ACCESS_DENIED|VALIDATION|CONFLICT|SCHEMA|SETUP|REVIEW|IMPORT|RECOVERY|LIMIT):/;
export async function databaseRpc(env,name,params,userToken=null){
  if(!/^bb_[a-z_]+$/.test(name))throw new DatabaseError('VALIDATION: Unsupported database operation.',400);
  return databaseRequest(env,'rpc/'+name,'POST',params,userToken);
}
async function databaseRequest(env,path,method,params,userToken=null){
  const key=userToken?env.SUPABASE_PUBLISHABLE_KEY:env.SUPABASE_SECRET_KEY;
  const headers={'Content-Type':'application/json',apikey:key};
  if(userToken)headers.Authorization='Bearer '+userToken;
  else if(!key?.startsWith('sb_secret_'))headers.Authorization='Bearer '+key;
  let response,body;
  try{response=await fetch(env.SUPABASE_URL+'/rest/v1/'+path,{method,headers,...(params===undefined?{}:{body:JSON.stringify(params)}),signal:AbortSignal.timeout(25000)});body=await response.json();}
  catch{throw new DatabaseError('RECOVERY: Database response was interrupted. Retry the same saved operation.');}
  if(!response.ok){
    const restriction=serviceRestriction(response.status,body);
    if(restriction)throw new DatabaseError(restriction);
    const message=String(body?.message||'');
    if(known.test(message))throw new DatabaseError(message,message.startsWith('ACCESS_DENIED')?403:409);
    if(['PGRST202','42P01'].includes(body?.code))throw new DatabaseError('SETUP: Install the Supabase financial database schema.');
    if(['23505','23503','23514'].includes(body?.code))throw new DatabaseError('VALIDATION: The database rejected a duplicate or inconsistent record.',409);
    throw new DatabaseError('REVIEW: The database request could not be confirmed.');
  }
  return body;
}

// Scheduled ticks need only flags and completion dates, never financial history.
export async function automationState(env){
  const owner=encodeURIComponent(env.OWNER_USER_ID);
  const rows=await databaseRequest(env,'bb_workspaces?owner_id=eq.'+owner+'&state=eq.READY&select=properties&limit=1','GET');
  if(rows.length!==1)throw new DatabaseError('SETUP: Workspace is not ready.');
  const properties=rows[0].properties||{};
  if(properties.DATABASE_AUTOMATION!=='true')return {properties,settings:{}};
  const settings=await databaseRequest(env,'bb_records?owner_id=eq.'+owner+'&entity=eq.Settings&data->>key=in.(Timezone,SyncEnabled,BackupEnabled)&select=data->>key,data->>value&limit=3','GET');
  return {properties,settings:Object.fromEntries(settings.map(row=>[row.key,row.value]))};
}
