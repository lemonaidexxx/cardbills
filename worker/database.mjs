export class DatabaseError extends Error {
  constructor(message,status=503){super(message);this.status=status;}
}
const known=/^(ACCESS_DENIED|VALIDATION|CONFLICT|SCHEMA|SETUP|REVIEW|IMPORT|RECOVERY|LIMIT):/;
export async function databaseRpc(env,name,params,userToken=null){
  if(!/^bb_[a-z_]+$/.test(name))throw new DatabaseError('VALIDATION: Unsupported database operation.',400);
  const key=userToken?env.SUPABASE_PUBLISHABLE_KEY:env.SUPABASE_SECRET_KEY;
  const headers={'Content-Type':'application/json',apikey:key};
  if(userToken)headers.Authorization='Bearer '+userToken;
  else if(!key?.startsWith('sb_secret_'))headers.Authorization='Bearer '+key;
  let response,body;
  try{response=await fetch(env.SUPABASE_URL+'/rest/v1/rpc/'+name,{method:'POST',headers,body:JSON.stringify(params),signal:AbortSignal.timeout(25000)});body=await response.json();}
  catch{throw new DatabaseError('RECOVERY: Database response was interrupted. Retry the same saved operation.');}
  if(!response.ok){
    const message=String(body?.message||'');
    if(known.test(message))throw new DatabaseError(message,message.startsWith('ACCESS_DENIED')?403:409);
    if(['PGRST202','42P01'].includes(body?.code))throw new DatabaseError('SETUP: Install the Supabase financial database schema.');
    if(['23505','23503','23514'].includes(body?.code))throw new DatabaseError('VALIDATION: The database rejected a duplicate or inconsistent record.',409);
    throw new DatabaseError('REVIEW: The database request could not be confirmed.');
  }
  return body;
}
