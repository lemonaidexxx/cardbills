import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {hmac} from '../worker/index.mjs';

const owner='11111111-1111-4111-8111-111111111111';
const factor='22222222-2222-4222-8222-222222222222';
const env={APP_ORIGIN:'https://cardbills.example.test',SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_example',SUPABASE_SECRET_KEY:'sb_secret_example',OWNER_USER_ID:owner,OWNER_EMAIL:'owner@example.test',OWNER_USERNAME:'owner',SESSION_KEY:'a'.repeat(64),BRIDGE_SECRET:'b'.repeat(64),APPS_SCRIPT_URL:'https://script.google.com/macros/s/example/exec',ALLOW_ENROLLMENT:'false',ASSETS:{fetch:async()=>new Response('workspace')}};
const reply=(data,status=200)=>new Response(status===204?null:JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const tokens=new Map();
const token=aal=>{if(!tokens.has(aal))tokens.set(aal,'header.'+Buffer.from(JSON.stringify({sub:owner,iss:env.SUPABASE_URL+'/auth/v1',aud:'authenticated',exp:Math.floor(Date.now()/1000)+3600,aal})).toString('base64url')+'.signature');return tokens.get(aal);};
function provider(t, options={}) {
  const rows=new Map();const seen=[];
  let factors=options.unenrolled?[]:[{id:factor,factor_type:'totp',status:'verified',friendly_name:'Authenticator'}];
  const state={rows,seen,authDown:false,rateAllowed:true,bridgeCalls:0};
  t.mock.method(globalThis,'fetch',async(input,init={})=>{
    const url=new URL(String(input));const method=init.method||'GET';const body=init.body?JSON.parse(init.body):null;
    seen.push({path:url.pathname,method,headers:init.headers});
    if(url.hostname==='script.google.com'){
      state.bridgeCalls++;
      assert.equal(await hmac(env.BRIDGE_SECRET,body.payload),body.signature);
      assert.equal(JSON.parse(body.payload).actor,owner);
      return reply({ok:true,data:{checked:true}});
    }
    if(url.pathname==='/rest/v1/rpc/cardbills_take_attempt')return reply(state.rateAllowed);
    if(url.pathname==='/rest/v1/cardbills_sessions'){
      assert.equal(init.headers.apikey,env.SUPABASE_SECRET_KEY);
      assert.equal(init.headers.Authorization,undefined);
      const id=(url.searchParams.get('id')||'').replace('eq.','');
      if(method==='POST'){rows.set(body.id,body);return new Response(null,{status:201});}
      if(method==='DELETE'){rows.delete(id);return reply(null,204);}
      return reply(rows.has(id)?[rows.get(id)]:[]);
    }
    if(url.pathname.startsWith('/auth/v1/')&&state.authDown)return reply({error:'temporarily unavailable'},503);
    if(url.pathname==='/auth/v1/token')return body.password==='correct-password'?reply({access_token:token('aal1')}):reply({error:'invalid'},400);
    if(url.pathname==='/auth/v1/user'){
      if(![token('aal1'),token('aal2')].includes((init.headers.Authorization||'').replace('Bearer ','')))return reply({},401);
      return reply({id:options.otherOwner?'33333333-3333-4333-8333-333333333333':owner,email_confirmed_at:'2026-01-01',factors});
    }
    if(url.pathname==='/auth/v1/factors'&&method==='POST'){
      factors=[{id:factor,factor_type:'totp',status:'unverified'}];
      return reply({id:factor,totp:{qr_code:'data:image/svg+xml,<svg/>',secret:'SYNTHETIC-SETUP-KEY'}});
    }
    if(url.pathname===`/auth/v1/factors/${factor}/challenge`)return reply({id:'challenge'});
    if(url.pathname===`/auth/v1/factors/${factor}/verify`){
      if(body.code!=='123456')return reply({error:'invalid code'},400);
      factors=[{id:factor,factor_type:'totp',status:'verified'}];
      return reply({access_token:token(options.noUpgrade?'aal1':'aal2')});
    }
    throw Error('Unexpected mocked request: '+url.pathname);
  });
  state.request=(path,body,cookie,settings={})=>worker.fetch(new Request(env.APP_ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{Origin:env.APP_ORIGIN,'Content-Type':'application/json','Sec-Fetch-Site':'same-origin'}),...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),{...env,...settings});
  state.login=async()=>{const r=await state.request('/api/login',{username:'owner',password:'correct-password'});assert.equal(r.status,200);return r.headers.get('Set-Cookie').split(';')[0];};
  return state;
}

test('password login, MFA, signed RPC and logout complete with mocked providers',async t=>{
  const p=provider(t);const initial=await p.login();
  assert.equal(p.rows.size,1);
  const row=[...p.rows.values()][0];assert.equal(row.token_box.includes(token('aal1')),false);assert.equal(initial.includes(row.id),false);
  let r=await p.request('/api/session',undefined,initial);assert.equal((await r.json()).complete,false);
  r=await p.request('/api/rpc',{action:'apiBootstrap',args:[]},initial);assert.equal(r.status,403);assert.equal(p.bridgeCalls,0);
  r=await p.request('/app',undefined,initial);assert.equal(r.status,303);
  r=await p.request('/api/verify',{factorId:factor,code:'123456'},initial);assert.equal(r.status,200);
  const cookie=r.headers.get('Set-Cookie');assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);const upgraded=cookie.split(';')[0];assert.notEqual(upgraded,initial);assert.equal(p.rows.size,1);
  r=await p.request('/api/session',undefined,initial);assert.equal((await r.json()).signedIn,false);
  r=await p.request('/api/rpc',{action:'apiBootstrap',args:[]},upgraded);assert.equal(r.status,200);assert.deepEqual(await r.json(),{data:{checked:true}});
  r=await p.request('/api/logout',{},upgraded);assert.equal(r.status,200);assert.equal(p.rows.size,0);
  r=await p.request('/api/rpc',{action:'apiBootstrap',args:[]},upgraded);assert.equal(r.status,401);
});

test('incorrect password creates no application session',async t=>{
  const p=provider(t);const r=await p.request('/api/login',{username:'owner',password:'incorrect'});assert.equal(r.status,401);assert.equal(p.rows.size,0);
});
test('a different verified account is rejected',async t=>{
  const p=provider(t,{otherOwner:true});const r=await p.request('/api/login',{username:'owner',password:'correct-password'});assert.equal(r.status,401);assert.equal(p.rows.size,0);
});
test('incorrect MFA code retains only the restricted session',async t=>{
  const p=provider(t);const cookie=await p.login();let r=await p.request('/api/verify',{factorId:factor,code:'999999'},cookie);assert.equal(r.status,401);r=await p.request('/api/rpc',{action:'apiBootstrap',args:[]},cookie);assert.equal(r.status,403);assert.equal(p.bridgeCalls,0);
});
test('MFA provider must actually upgrade assurance level',async t=>{
  const p=provider(t,{noUpgrade:true});const cookie=await p.login();const r=await p.request('/api/verify',{factorId:factor,code:'123456'},cookie);assert.equal(r.status,403);assert.equal(p.rows.size,1);
});
test('provider outage fails closed for financial requests',async t=>{
  const p=provider(t);const cookie=await p.login();p.authDown=true;const r=await p.request('/api/rpc',{action:'apiBootstrap',args:[]},cookie);assert.equal(r.status,503);assert.equal(p.bridgeCalls,0);
});
test('expired application sessions fail closed',async t=>{
  const p=provider(t);const cookie=await p.login();[...p.rows.values()][0].expires_at='2000-01-01';const r=await p.request('/api/rpc',{action:'apiBootstrap',args:[]},cookie);assert.equal(r.status,401);assert.equal(p.bridgeCalls,0);
});
test('closed enrollment rejects a new authenticator',async t=>{
  const p=provider(t,{unenrolled:true});const cookie=await p.login();const r=await p.request('/api/enroll',{},cookie);assert.equal(r.status,403);
});
test('approved owner enrollment returns a setup key and remains MFA restricted',async t=>{
  const p=provider(t,{unenrolled:true});const cookie=await p.login();let r=await p.request('/api/enroll',{},cookie,{ALLOW_ENROLLMENT:'true'});assert.equal(r.status,200);assert.equal((await r.json()).id,factor);r=await p.request('/api/rpc',{action:'apiBootstrap',args:[]},cookie);assert.equal(r.status,403);
});
test('registered authenticator blocks repeat enrollment',async t=>{
  const p=provider(t);const cookie=await p.login();const r=await p.request('/api/enroll',{},cookie,{ALLOW_ENROLLMENT:'true'});assert.equal(r.status,403);
});
test('rate limits prevent a new password request',async t=>{
  const p=provider(t);p.rateAllowed=false;const r=await p.request('/api/login',{username:'owner',password:'correct-password'});assert.equal(r.status,429);assert.equal(p.rows.size,0);assert.equal(p.seen.some(x=>x.path==='/auth/v1/token'),false);
});
