import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const require=createRequire(path.resolve(process.argv[2]||'node_modules/playwright/package.json'));
const {chromium}=require('playwright');
const fixture=JSON.parse(execFileSync(process.execPath,['tests/browser-fixture.mjs'],{encoding:'utf8'}));

fixture.boot.lookups.Statements.forEach(s=>s.statementDate='2026-09-09');
fixture.boot.lookups.InstallmentPlans=[{id:'test-plan',label:'Example installment plan',accountId:fixture.boot.lookups.Accounts[0].id,currency:'PHP',status:'ACTIVE',count:12}];
fixture.boot.storage='supabase';fixture.boot.databaseVersion=42;
fixture.boot.diagnostics.lastBackupVersion='41';fixture.boot.diagnostics.googleConfigured=true;
const output=fs.mkdtempSync(path.join(os.tmpdir(),'cardbills-browser-'));
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||undefined,headless:true});
const checks=[];
try{for(const [mode,width,height]of [['desktop',1440,1000],['tablet',820,1180],['mobile',390,844]]){
 const page=await browser.newPage({viewport:{width,height}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 async function load(file,script){
  const html=fs.readFileSync('public/'+file,'utf8').replace(/<link\b[^>]*>/g,'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
  await page.setContent(html);await page.addStyleTag({content:fs.readFileSync('public/styles.css','utf8')});
  await page.evaluate(data=>{crypto.randomUUID=()=> '11111111-1111-4111-8111-'+String(Math.floor(Math.random()*1e12)).padStart(12,'0');window.fetch=async(url,options={})=>{let result={signedIn:false};if(url==='/api/rpc'){const req=JSON.parse(options.body);result={data:req.action==='apiBootstrap'?data.boot:req.action==='apiList'?data.lists[req.args[0]]:[]};}return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}});};},fixture);
  await page.addScriptTag({content:fs.readFileSync('public/'+script,'utf8')});
 }
 const noOverflow=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),mode+' overflow');
 const nav=async name=>{if(width<=700)await page.locator('#nav-toggle').click();await page.locator('#nav').getByRole('button',{name,exact:true}).click();};
 await load('login.html','login.js');await page.locator('#username:focus').waitFor();await page.locator('#password').fill('synthetic-password');await page.locator('#show-password').click();assert.equal(await page.locator('#password').getAttribute('type'),'text');await noOverflow();await page.screenshot({path:path.join(output,'login-'+mode+'.png'),fullPage:true});
 await load('app.html','app.js');await page.getByRole('heading',{name:'Recent transactions',exact:true}).waitFor();await noOverflow();await page.screenshot({path:path.join(output,'overview-'+mode+'.png'),fullPage:true});
 await nav('Activity');await page.getByRole('button',{name:'Import reviewed package',exact:true}).click();assert.ok(await page.locator('#dialog').evaluate(e=>e.open));await page.keyboard.press('Escape');assert.ok(!await page.locator('#dialog').evaluate(e=>e.open));
 assert.equal(await page.getByText('Filters and sorting',{exact:true}).count(),0);await page.locator('[data-sort-key="amountMinor"]').click();await page.locator('th[aria-sort="ascending"]:has([data-sort-key="amountMinor"])').waitFor();await page.locator('[data-sort-key="amountMinor"]').press('Enter');await page.locator('th[aria-sort="descending"]:has([data-sort-key="amountMinor"])').waitFor();await page.getByLabel('Card',{exact:true}).selectOption(fixture.boot.lookups.Cards[0].id);
 await page.getByLabel('Account',{exact:true}).selectOption(fixture.boot.lookups.Accounts[0].id);await page.getByLabel('Statement date',{exact:true}).selectOption('2026-09-09');
 await page.getByRole('button',{name:'Groceries',exact:true}).first().click();await page.getByRole('button',{name:'Link installment charges',exact:true}).click();assert.deepEqual(errors,[]);await page.getByLabel('Installment plan ID',{exact:true}).selectOption('test-plan');await page.getByRole('checkbox').first().check();await page.getByRole('spinbutton').first().fill('1');await noOverflow();await page.screenshot({path:path.join(output,'installments-'+mode+'.png'),fullPage:true});await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Edit record',exact:true}).click();await page.locator('#edit-dueDate').fill('2026-10-05');assert.equal(await page.locator('#edit-dueDate').getAttribute('type'),'date');await page.keyboard.press('Escape');await page.keyboard.press('Escape');
 await nav('Accounts');const account=page.getByRole('button',{name:'Everyday account',exact:true});await account.click();assert.ok(await page.locator('#context-drawer').evaluate(e=>e.open));await page.screenshot({path:path.join(output,'drawer-'+mode+'.png'),fullPage:true});await page.keyboard.press('Escape');assert.ok(!await page.locator('#context-drawer').evaluate(e=>e.open));assert.ok(await account.evaluate(e=>e===document.activeElement));
 for(const [group,subsections]of Object.entries({Activity:['Review','Saved Views'],Accounts:['Statements','Bank Payments','Installments'],Collections:['Money Owed','People','Repayments'],Settings:['Workspace and Backups','Configuration']})){
  await nav(group);for(const name of subsections){await page.locator('#subnav').getByRole('button',{name,exact:true}).click();await page.locator('#title').filter({hasText:name}).waitFor();await noOverflow();}
 }
 await nav('Activity');await page.locator('#subnav').getByRole('button',{name:'Review',exact:true}).click();await page.getByRole('button',{name:'Review merge',exact:true}).first().click();await page.getByRole('button',{name:'Continue to confirmation',exact:true}).click();await page.getByRole('button',{name:'Confirm merge',exact:true}).waitFor();await noOverflow();await page.screenshot({path:path.join(output,'duplicate-confirm-'+mode+'.png'),fullPage:true});await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await nav('Settings');await page.getByRole('button',{name:'Enable Sheets backups',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Synchronize all statements',exact:true}).count(),0);await page.screenshot({path:path.join(output,'settings-'+mode+'.png'),fullPage:true});
 assert.deepEqual(errors,[]);checks.push(mode+' auth, navigation, drawers, focus return, import dialog and all section layouts');await page.close();
}}finally{await browser.close();}
console.log(JSON.stringify({checks,output,data:'Synthetic records only'},null,2));
