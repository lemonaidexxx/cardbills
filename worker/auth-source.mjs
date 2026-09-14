const enc = new TextEncoder();
const cookieName = '__Host-cardbills';
const sessionSeconds = 1800;
const preauthSeconds = 300;
const maxRpcBytes = 1500000;
const rpcMethods = new Set(["apiIdentity", "apiImportLookups", "apiResolveMissing", "apiBootstrap", "apiList", "apiSave", "apiReport", "apiRecover", "apiInstallmentSchedule", "apiSettings", "apiBackup", "apiCalendarTest", "apiCalendars", "apiCreateCalendar", "apiSyncPreview", "apiSync", "apiCalendarMigrationPreview", "apiCalendarMigrate", "apiImportPreview", "apiImportCommit", "apiImportStage", "apiImportValidate", "apiImportPage", "apiImportStatus", "apiImportSelect", "apiImportPause", "apiImportBatchCommit", "repairSettings", "installTriggers", "stopAutomation", "apiPackageCommit", "apiPackageReceipt"]);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const hex = bytes => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
const random = length => hex(crypto.getRandomValues(new Uint8Array(length)));
const sha = async text => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function enrollmentSetting(env) {
  const value = env.ALLOW_ENROLLMENT;
  if (value === undefined || value === null || value === '') return 'missing';
  if (value === true || value === false) return value ? 'enabled' : 'disabled';
  if (typeof value !== 'string') return 'invalid';
  const text = value.trim().toLowerCase();
  return text === 'true' ? 'enabled' : text === 'false' ? 'disabled' : 'invalid';
}

export function configuration(env) {
  const required = ['APP_ORIGIN','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','SUPABASE_SECRET_KEY','OWNER_USER_ID','OWNER_EMAIL','OWNER_USERNAME','SESSION_KEY','BRIDGE_SECRET','APPS_SCRIPT_URL'];
  if (required.some(key => typeof env[key] !== 'string' || !env[key].trim())) throw new HttpError(503, 'Complete the application settings.');
  if (!/^https:\/\/[a-z0-9.-]+$/.test(env.APP_ORIGIN) || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(env.SUPABASE_URL) || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(env.APPS_SCRIPT_URL)) throw new HttpError(503, 'Check the configured service addresses.');
  if (!uuidPattern.test(env.OWNER_USER_ID) || !/^[a-f0-9]{64}$/i.test(env.SESSION_KEY) || !/^[a-f0-9]{64}$/i.test(env.BRIDGE_SECRET)) throw new HttpError(503, 'Check the owner and secret settings.');
  if (!/^[^\s@\"\\]+@[^\s@\"\\]+\.[^\s@\"\\]+$/.test(env.OWNER_EMAIL.trim())) throw new HttpError(503, 'Check OWNER_EMAIL in the Cloudflare Worker settings (AUTH_OWNER_EMAIL).');
}

export function requireSameOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  if (origin !== env.APP_ORIGIN || (site && site !== 'same-origin')) throw new HttpError(403, 'Open the application and submit the form again.');
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) throw new HttpError(415, 'Submit JSON content.');
}

export async function readJson(request, limit) {
  if (Number(request.headers.get('Content-Length') || 0) > limit) throw new HttpError(413, 'Choose a smaller import file.');
  if (!request.body) throw new HttpError(400, 'Request content is required.');
  const reader = request.body.getReader();
  let size = 0; const chunks = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) { await reader.cancel(); throw new HttpError(413, 'Choose a smaller import file.'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, 'Request content is invalid.'); }
}

export async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(value)));
}

async function encryptionKey(env) {
  return crypto.subtle.importKey('raw', Uint8Array.from(env.SESSION_KEY.match(/../g), x => parseInt(x, 16)), 'AES-GCM', false, ['encrypt','decrypt']);
}

export async function seal(value, binding, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(binding) }, await encryptionKey(env), enc.encode(value));
  return `${b64(iv)}.${b64(encrypted)}`;
}

export async function unseal(value, binding, env) {
  const [iv, data] = value.split('.');
  try {
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(binding) }, await encryptionKey(env), unb64(data));
    return new TextDecoder().decode(clear);
  } catch { throw new HttpError(401, 'Sign in to continue.'); }
}

async function remoteJson(url, options, message = 'The service is temporarily unavailable.') {
  const authRequest = new URL(url).pathname.startsWith('/auth/v1/');
  const unavailable = authRequest ? 'The authentication connection failed. Try again shortly (AUTH_CONNECTION).' : message;
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000), redirect: 'manual' }); }
  catch { throw new HttpError(503, unavailable); }
  if (response.status >= 300 && response.status < 400) throw new HttpError(503, authRequest ? 'Check the authentication service address (AUTH_REDIRECT).' : message);
  let data = null;
  if (response.status !== 204) {
    try { const text = await response.text(); data = text.trim() ? JSON.parse(text) : null; }
    catch { throw new HttpError(503, authRequest ? 'The authentication service returned an invalid response (AUTH_RESPONSE).' : message); }
  }
  if (!response.ok) {
    if (response.status === 429) throw new HttpError(429, 'Wait before trying again.');
    if (authRequest) {
      if (response.status >= 500) throw new HttpError(503, 'The authentication service is temporarily unavailable (AUTH_SERVICE).');
      const code = typeof data?.error_code === 'string' ? data.error_code : typeof data?.code === 'string' ? data.code : '';
      if (!code && [401, 403].includes(response.status)) throw new HttpError(503, 'The authentication service rejected the app connection. Check SUPABASE_PUBLISHABLE_KEY (AUTH_APP_ACCESS).');
      if (code === 'invalid_credentials') throw new HttpError(401, 'Check your sign-in details and try again. (AUTH_CREDENTIALS)');
      if (['bad_jwt', 'no_authorization', 'session_not_found', 'session_expired'].includes(code)) throw new HttpError(401, 'The authentication service could not verify the sign-in token (AUTH_TOKEN).');
      if (['email_provider_disabled', 'provider_disabled'].includes(code)) throw new HttpError(503, 'Enable the configured sign-in provider in Supabase (AUTH_PROVIDER).');
      if (code === 'captcha_failed') throw new HttpError(503, 'The sign-in CAPTCHA needs configuration (AUTH_CAPTCHA).');
      if (['mfa_totp_enroll_not_enabled', 'mfa_totp_verify_not_enabled'].includes(code)) throw new HttpError(503, 'Enable authenticator enrollment and verification in Supabase (AUTH_MFA_CONFIG).');
    }
    throw new HttpError(response.status >= 500 ? 503 : 401, message);
  }
  return data;
}

const adminHeaders = env => ({ apikey: env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' });
async function database(env, path, method = 'GET', body) {
  return remoteJson(`${env.SUPABASE_URL}/rest/v1/${path}`, { method, headers: { ...adminHeaders(env), Prefer: 'return=minimal' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function auth(env, path, token, body, method) {
  return remoteJson(`${env.SUPABASE_URL}/auth/v1/${path}`, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, 'Check your sign-in details and try again.');
}

export function claimsAfterVerification(token, user, env) {
  let claims;
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    claims = JSON.parse(new TextDecoder().decode(unb64(part.padEnd(Math.ceil(part.length / 4) * 4, '='))));
  } catch { throw new HttpError(401, 'Sign in to continue.'); }
  if (user.id !== env.OWNER_USER_ID || claims.sub !== env.OWNER_USER_ID || claims.iss !== `${env.SUPABASE_URL}/auth/v1` || claims.aud !== 'authenticated' || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now() || !user.email_confirmed_at) throw new HttpError(401, 'Sign in to continue.');
  if (user.banned_until && Date.parse(user.banned_until) > Date.now()) throw new HttpError(401, 'Sign in to continue.');
  return claims;
}

async function verifyToken(token, env) {
  const user = await auth(env, 'user', token);
  const claims = claimsAfterVerification(token, user, env);
  const factors = (user.factors || []).filter(f => f.factor_type === 'totp');
  return { token, user, claims, factors, complete: claims.aal === 'aal2' && factors.some(f => f.status === 'verified') };
}

function sessionCookie(value, seconds) {
  return `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(seconds))}`;
}
export function cookieToken(request) {
  const matches = (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).filter(x => x.startsWith(`${cookieName}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(cookieName.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

async function createSession(verified, env) {
  const sid = random(32), id = await sha(sid);
  const lifetime = Math.min(verified.complete ? sessionSeconds : preauthSeconds, Math.floor(verified.claims.exp - Date.now() / 1000));
  if (lifetime < 10) throw new HttpError(401, 'Sign in again.');
  await database(env, 'cardbills_sessions', 'POST', { id, user_id: verified.user.id, token_box: await seal(verified.token, id, env), expires_at: new Date(Date.now() + lifetime * 1000).toISOString() });
  return { cookie: sessionCookie(sid, lifetime), id };
}

async function getSession(request, env, requireMfa = false) {
  const sid = cookieToken(request);
  if (!sid) throw new HttpError(401, 'Sign in to continue.');
  const id = await sha(sid);
  const rows = await database(env, `cardbills_sessions?id=eq.${id}&select=id,user_id,token_box,expires_at&limit=1`);
  const row = rows?.[0];
  if (!row || row.user_id !== env.OWNER_USER_ID || Date.parse(row.expires_at) <= Date.now()) throw new HttpError(401, 'Sign in to continue.');
  const token = await unseal(row.token_box, id, env);
  const result = await verifyToken(token, env);
  if (requireMfa && !result.complete) throw new HttpError(403, 'Complete authenticator verification.');
  return { ...result, id };
}

async function rateLimit(request, env, context, limit = 5, seconds = 60) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = await hmac(env.SESSION_KEY, `${context}|${ip}`);
  const result = await remoteJson(`${env.SUPABASE_URL}/rest/v1/rpc/cardbills_take_attempt`, { method: 'POST', headers: adminHeaders(env), body: JSON.stringify({ p_key: key, p_limit: limit, p_seconds: seconds }) });
  if (result !== true) throw new HttpError(429, 'Wait before trying again.');
  if (context === 'login' || context.startsWith('mfa:') || context.startsWith('enroll:')) {
    const ownerKey = await hmac(env.SESSION_KEY, `owner:${context}`);
    const ownerLimit = context === 'login' ? 20 : limit;
    const allowed = await remoteJson(`${env.SUPABASE_URL}/rest/v1/rpc/cardbills_take_attempt`, { method: 'POST', headers: adminHeaders(env), body: JSON.stringify({ p_key: ownerKey, p_limit: ownerLimit, p_seconds: seconds }) });
    if (allowed !== true) throw new HttpError(429, 'Wait before trying again.');
  }
}

export function harden(response, dynamic = true) {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  headers.set('Strict-Transport-Security', 'max-age=31536000');
  if (dynamic) headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}
const json = (body, status = 200, cookie) => harden(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...(cookie ? { 'Set-Cookie': cookie } : {}) } }));
const redirect = path => harden(new Response(null, { status: 303, headers: { Location: path } }));

async function bridge(env, session, action, args) {
  if (!rpcMethods.has(action) || !Array.isArray(args) || args.length > 8) throw new HttpError(400, 'Choose a supported operation.');
  const payload = JSON.stringify({ version: 1, timestamp: Date.now(), nonce: random(16), actor: session.user.id, action, args });
  const signature = await hmac(env.BRIDGE_SECRET, payload);
  let response, result;
  try {
    response = await fetch(env.APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload, signature }), redirect: 'follow', signal: AbortSignal.timeout(28000) });
    result = await response.json();
  } catch { throw new HttpError(503, 'The backend request needs a status check. Refresh before retrying a change.'); }
  if (!response.ok || !result || result.ok !== true) {
    const text = typeof result?.error === 'string' && /^(VALIDATION|CONFLICT|SCHEMA|SETUP|BUSY|REVIEW|CALENDAR|IMPORT|RECOVERY|LIMIT):/.test(result.error) ? result.error : 'The backend connection needs review.';
    throw new HttpError(400, text);
  }
  return result.data;
}

async function handle(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/health') return json({ status: 'running' });
  configuration(env);
  if (url.origin !== env.APP_ORIGIN) throw new HttpError(403, 'Open the configured application address.');
  if (url.pathname === '/api/session' && request.method === 'GET') {
    try {
      const session = await getSession(request, env);
      return json({ signedIn: true, authRevision: 'enrollment-20260913-1', enrollmentSetting: enrollmentSetting(env), complete: session.complete, factors: session.factors.filter(f => f.status === 'verified').map(f => ({ id: f.id, label: f.friendly_name || 'Authenticator' })), enrollmentAllowed: enrollmentSetting(env) === 'enabled' && !session.factors.some(f => f.status === 'verified') });
    } catch (e) { if (e.status === 401) return json({ signedIn: false }, 200, sessionCookie('', 0)); throw e; }
  }
  if (url.pathname.startsWith('/api/')) {
    if (request.method !== 'POST') throw new HttpError(405, 'Use the application form.');
    requireSameOrigin(request, env);
    const body = await readJson(request, url.pathname === '/api/rpc' ? maxRpcBytes : 4096);
    if (url.pathname === '/api/login') {
      await rateLimit(request, env, 'login', 5, 60);
      if (typeof body.username !== 'string' || typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 256 || body.username.length > 100) throw new HttpError(401, 'Check your sign-in details and try again.');
      const login = await auth(env, 'token?grant_type=password', null, { email: env.OWNER_EMAIL.trim().toLowerCase(), password: body.password });
      const verified = await verifyToken(login.access_token, env);
      const userMatch = await hmac(env.SESSION_KEY, body.username.trim().toLowerCase()) === await hmac(env.SESSION_KEY, env.OWNER_USERNAME.trim().toLowerCase());
      if (!userMatch) {
        try { await auth(env, 'logout?scope=local', verified.token, {}, 'POST'); } catch {}
        throw new HttpError(401, 'Your account password was verified. Check OWNER_USERNAME in the Cloudflare Worker settings (AUTH_USERNAME).');
      }
      const existing = cookieToken(request);
      if (existing) await database(env, `cardbills_sessions?id=eq.${await sha(existing)}`, 'DELETE');
      const session = await createSession(verified, env);
      return json({ next: '/login.html' }, 200, session.cookie);
    }
    if (url.pathname === '/api/logout') {
      const sid = cookieToken(request);
      if (sid) await database(env, `cardbills_sessions?id=eq.${await sha(sid)}`, 'DELETE');
      return json({ signedOut: true }, 200, sessionCookie('', 0));
    }
    const session = await getSession(request, env, url.pathname === '/api/rpc');
    if (url.pathname === '/api/enroll') {
      await rateLimit(request, env, `enroll:${session.user.id}`, 3, 300);
      if (enrollmentSetting(env) !== 'enabled' || session.factors.some(f => f.status === 'verified')) throw new HttpError(403, 'Use your registered authenticator.');
      for (const factor of session.factors.filter(f => f.status === 'unverified')) await auth(env, `factors/${factor.id}`, session.token, undefined, 'DELETE');
      const factor = await auth(env, 'factors', session.token, { factor_type: 'totp', friendly_name: 'Cardbills authenticator', issuer: 'Cardbills' });
      return json({ id: factor.id, qr: factor.totp.qr_code, secret: factor.totp.secret });
    }
    if (url.pathname === '/api/verify') {
      await rateLimit(request, env, `mfa:${session.user.id}`, 5, 60);
      if (!uuidPattern.test(body.factorId || '') || !/^\d{6}$/.test(body.code || '') || !session.factors.some(f => f.id === body.factorId)) throw new HttpError(400, 'Enter the six-digit authenticator code.');
      if (session.factors.find(f => f.id === body.factorId).status !== 'verified' && enrollmentSetting(env) !== 'enabled') throw new HttpError(403, 'Use your registered authenticator.');
      const challenge = await auth(env, `factors/${body.factorId}/challenge`, session.token, {});
      const verified = await auth(env, `factors/${body.factorId}/verify`, session.token, { challenge_id: challenge.id, code: body.code });
      const upgraded = await verifyToken(verified.access_token, env);
      if (!upgraded.complete) throw new HttpError(403, 'Complete authenticator verification.');
      const next = await createSession(upgraded, env);
      await database(env, `cardbills_sessions?id=eq.${session.id}`, 'DELETE');
      return json({ next: '/app' }, 200, next.cookie);
    }
    if (url.pathname === '/api/rpc') {
      await rateLimit(request, env, `rpc:${session.user.id}`, 120, 60);
      return json({ data: await bridge(env, session, body.action, body.args) });
    }
    throw new HttpError(404, 'Page not found.');
  }
  if (!['GET','HEAD'].includes(request.method)) throw new HttpError(405, 'Use a supported request.');
  if (url.pathname === '/') return redirect('/login.html');
  if (url.pathname === '/app' || url.pathname === '/app.html') {
    try { await getSession(request, env, true); }
    catch (e) { if ([401,403].includes(e.status)) return redirect('/login.html'); throw e; }
    url.pathname = '/app.html';
    return harden(await env.ASSETS.fetch(new Request(url, request)));
  }
  if (!['/login.html','/login.js','/app.js','/styles.css','/favicon.svg'].includes(url.pathname)) throw new HttpError(404, 'Page not found.');
  return harden(await env.ASSETS.fetch(request));
}

export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (e) { return json({ error: e instanceof HttpError ? e.message : 'The request could not be completed.' }, e instanceof HttpError ? e.status : 500); }
  }
};
