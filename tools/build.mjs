import fs from 'node:fs';
import './build-domain.mjs';
const root=new URL('../',import.meta.url);
let source=fs.readFileSync(new URL('worker/auth-source.mjs',root),'utf8');
function replace(from,to){if(!source.includes(from))throw Error('Authentication build anchor changed.');source=source.replace(from,to);}
replace("const required = ['APP_ORIGIN','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','SUPABASE_SECRET_KEY','OWNER_USER_ID','OWNER_EMAIL','OWNER_USERNAME','SESSION_KEY','BRIDGE_SECRET','APPS_SCRIPT_URL'];", "if (env.DATA_BACKEND && !['sheets','supabase'].includes(env.DATA_BACKEND)) throw new HttpError(503, 'Check DATA_BACKEND.');\n  const required = ['APP_ORIGIN','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','SUPABASE_SECRET_KEY','OWNER_USER_ID','OWNER_EMAIL','OWNER_USERNAME','SESSION_KEY'].concat(env.DATA_BACKEND === 'supabase' ? [] : ['BRIDGE_SECRET','APPS_SCRIPT_URL']);");
replace("|| !/^https:\\/\\/script\\.google\\.com\\/macros\\/s\\/[A-Za-z0-9_-]+\\/exec$/.test(env.APPS_SCRIPT_URL)", "|| (env.DATA_BACKEND !== 'supabase' && !/^https:\\/\\/script\\.google\\.com\\/macros\\/s\\/[A-Za-z0-9_-]+\\/exec$/.test(env.APPS_SCRIPT_URL))");
replace("|| !/^[a-f0-9]{64}$/i.test(env.BRIDGE_SECRET)", "|| (env.DATA_BACKEND !== 'supabase' && !/^[a-f0-9]{64}$/i.test(env.BRIDGE_SECRET))");
replace("return json({ data: await bridge(env, session, body.action, body.args) });", `if (env.DATA_BACKEND === 'supabase') {
        if (!env.FINANCE_ENGINE) throw new HttpError(503, 'Complete the database engine deployment.');
        if (!rpcMethods.has(body.action) && !['apiExportDatabase','apiSyncStatus','apiActivateIntegrations','apiEnableSheetBackups','apiEnableCalendarSync'].includes(body.action)) throw new HttpError(400, 'Choose a supported operation.');
        const stub=env.FINANCE_ENGINE.get(env.FINANCE_ENGINE.idFromName(env.OWNER_USER_ID));
        return harden(await stub.fetch('https://internal/finance',{method:'POST',body:JSON.stringify({session,action:body.action,args:body.args})}));
      }
      return json({ data: await bridge(env, session, body.action, body.args) });`);
replace("'/styles.css','/favicon.svg'", "'/styles.css','/browse-cache.js','/favicon.svg','/fonts/Poppins-Regular.ttf','/fonts/Poppins-Medium.ttf','/fonts/Poppins-SemiBold.ttf','/fonts/Poppins-Bold.ttf','/fonts/OFL.txt'");
replace("if (url.pathname === '/health') return json({ status: 'running' });","if (url.pathname === '/health') return json({ status: 'running', release: FINANCIAL_REVISION, financialBackend: env.DATA_BACKEND === 'supabase' ? 'supabase' : 'sheets' });");
replace("export default {\n  async fetch",`export default {
  async scheduled(event,env,ctx) {
    if (env.DATA_BACKEND !== 'supabase' || !env.FINANCE_ENGINE || !env.GOOGLE_SERVICE_ACCOUNT_JSON) return;
    const stub=env.FINANCE_ENGINE.get(env.FINANCE_ENGINE.idFromName(env.OWNER_USER_ID));
    ctx.waitUntil(stub.fetch('https://internal/finance',{method:'POST',body:JSON.stringify({kind:'automation'})}).then(async r=>{if(!r.ok)throw Error('Scheduled integration needs review.');}));
  },
  async fetch`);
fs.writeFileSync(new URL('worker/runtime.generated.mjs',root),"import {FINANCIAL_REVISION} from './finance.mjs';\n"+source);
const htmlPath=new URL('public/app.html',root);let html=fs.readFileSync(htmlPath,'utf8');
html=html.replace(/<script defer src="\/browse-cache\.js[^\"]*"><\/script>/g,'');
fs.writeFileSync(htmlPath,html);
