import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { configuration, requireSameOrigin, readJson, hmac, seal, unseal, claimsAfterVerification, cookieToken, harden } from '../worker/index.mjs';

const env = { APP_ORIGIN:'https://cardbills.example.test',SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'anon',SUPABASE_SECRET_KEY:'service',OWNER_USER_ID:'11111111-1111-4111-8111-111111111111',OWNER_EMAIL:'owner@example.test',OWNER_USERNAME:'owner',SESSION_KEY:'a'.repeat(64),BRIDGE_SECRET:'b'.repeat(64),APPS_SCRIPT_URL:'https://script.google.com/macros/s/example/exec' };
const post = (origin=env.APP_ORIGIN,type='application/json',body='{}') => new Request(env.APP_ORIGIN+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':type,'Sec-Fetch-Site':origin===env.APP_ORIGIN?'same-origin':'cross-site'},body});

test('configuration rejects missing values', () => assert.throws(() => configuration({}), /settings/));
test('configuration rejects untrusted backend hosts', () => assert.throws(() => configuration({...env,APPS_SCRIPT_URL:'https://other.example.test/exec'})));
test('configuration accepts complete deployment values', () => assert.doesNotThrow(() => configuration(env)));
test('same-origin JSON mutations are accepted', () => assert.doesNotThrow(() => requireSameOrigin(post(),env)));
test('cross-origin mutations are rejected', () => assert.throws(() => requireSameOrigin(post('https://other.example.test'),env)));
test('form encoded mutations are rejected', () => assert.throws(() => requireSameOrigin(post(env.APP_ORIGIN,'application/x-www-form-urlencoded'),env)));
test('JSON request limits are enforced', async () => { await assert.rejects(readJson(post(env.APP_ORIGIN,'application/json','{"long":"1234567890"}'),8)); });
test('malformed JSON is rejected', async () => { await assert.rejects(readJson(post(env.APP_ORIGIN,'application/json','{'),20)); });
test('array request bodies are rejected', async () => { await assert.rejects(readJson(post(env.APP_ORIGIN,'application/json','[]'),20)); });
test('session identifiers accept one well-formed cookie', () => { assert.equal(cookieToken(new Request(env.APP_ORIGIN,{headers:{Cookie:'__Host-cardbills='+ 'a'.repeat(64)}})),'a'.repeat(64)); assert.equal(cookieToken(new Request(env.APP_ORIGIN,{headers:{Cookie:'__Host-cardbills=bad'}})),null); });
test('ambiguous duplicate session cookies are rejected', () => { assert.equal(cookieToken(new Request(env.APP_ORIGIN,{headers:{Cookie:`__Host-cardbills=${'a'.repeat(64)}; __Host-cardbills=${'b'.repeat(64)}`}})),null); });
test('session encryption round trips', async () => { const box=await seal('synthetic-token','session-one',env);assert.equal(await unseal(box,'session-one',env),'synthetic-token');assert.equal(box.includes('synthetic-token'),false); });
test('session encryption binds ciphertext to its identifier', async () => { const box=await seal('synthetic-token','session-one',env);await assert.rejects(unseal(box,'session-two',env)); });
test('session ciphertext tampering is rejected', async () => { const box=await seal('synthetic-token','session-one',env);await assert.rejects(unseal(box.slice(0,-4)+'AAAA','session-one',env)); });
test('HMAC uses a deterministic SHA-256 signature', async () => { assert.equal(await hmac('key','message'),'6e9ef29b75fffc5b7abae527d58fdadb2fe42e7219011976917343065f58ed4a'); });
test('verified token claims remain restricted to the owner', () => { const user={id:env.OWNER_USER_ID,email_confirmed_at:'2026-01-01'};const claims={sub:env.OWNER_USER_ID,iss:env.SUPABASE_URL+'/auth/v1',aud:'authenticated',exp:Date.now()/1000+300,aal:'aal2'};const token='x.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.x';assert.equal(claimsAfterVerification(token,user,env).aal,'aal2');assert.throws(()=>claimsAfterVerification(token,{...user,id:'other'},env)); });
test('expired verified token claims are rejected', () => { const token='x.'+Buffer.from(JSON.stringify({sub:env.OWNER_USER_ID,iss:env.SUPABASE_URL+'/auth/v1',aud:'authenticated',exp:1})).toString('base64url')+'.x';assert.throws(()=>claimsAfterVerification(token,{id:env.OWNER_USER_ID,email_confirmed_at:'2026-01-01'},env)); });
test('responses carry privacy and browser security headers', () => { const r=harden(new Response('ok'));assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal(r.headers.get('X-Frame-Options'),'DENY');assert.match(r.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/); });
test('unconfigured deployments fail closed', async () => { const r=await worker.fetch(new Request(env.APP_ORIGIN+'/api/session'),{});assert.equal(r.status,503); });
test('unauthenticated financial RPC is rejected', async () => { const r=await worker.fetch(new Request(env.APP_ORIGIN+'/api/rpc',{method:'POST',headers:{Origin:env.APP_ORIGIN,'Content-Type':'application/json'},body:'{"action":"apiBootstrap","args":[]}'}),env);assert.equal(r.status,401); });
