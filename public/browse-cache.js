'use strict';
function createBrowseCache(now=()=>Date.now()){
 let snapshot=null;
 const supported=new Set(['Transactions','Accounts','Cards','Statements','People','SavedViews','Labels','ReportConfig']);
 const dates={Transactions:['transactionDate','postingDate'],Statements:['statementDate','dueDate']};
 return {
  clear(){snapshot=null;},
  load(value){if(value?.tables&&value.loadedAt)snapshot=value;},
  patch(rows,issues){if(!snapshot)return;for(const row of rows||[]){const i=snapshot.tables.Transactions?.findIndex(r=>r.id===row.id);if(i>=0)snapshot.tables.Transactions[i]=row;}if(issues)snapshot.issues=issues;},
  list(entity,filters={},page=0,sort='updatedAt:desc'){
   if(!snapshot||now()-snapshot.loadedAt>120000||!supported.has(entity)||!snapshot.tables[entity])return null;
   if(!filters||typeof filters!=='object'||Array.isArray(filters))return null;
   const allowed=['q','personId','tag','status','reviewStatus','requestStatus','settlement','expectedState','from','to','currency','dateBasis','accountId','cardId','statementId','transactionId','shareId','type','spending','undated','installmentPlanId'];
   if(Object.keys(filters).some(k=>!allowed.includes(k)||typeof filters[k]!=='string'||filters[k].length>300))return null;
   const basis=filters.dateBasis||(dates[entity]||['updatedAt'])[0];if(!(dates[entity]||['updatedAt']).includes(basis))return null;
   const parts=sort.split(':');if(parts.length!==2||!['asc','desc'].includes(parts[1]))return null;
   const validDate=v=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
   if(filters.from&&!validDate(filters.from)||filters.to&&!validDate(filters.to)||filters.from&&filters.to&&filters.from>filters.to)return null;
   const rows=snapshot.tables[entity].filter(r=>{
    if(filters.spending==='true'&&(r.status!=='ACTIVE'||!['PURCHASE','FEE','INTEREST','CASH_ADVANCE','INSTALLMENT'].includes(r.type)))return false;
    if(filters.undated==='true'&&r.postingDate)return false;
    if(filters.q&&!String([r.description,r.originalDescription,r.notes,r.name,r.nickname,r.reference].join(' ')).toLowerCase().includes(filters.q.toLowerCase()))return false;
    if(filters.personId&&(entity==='Transactions'?!(snapshot.tables.Shares||[]).some(s=>s.transactionId===r.id&&s.personId===filters.personId&&s.status==='ACTIVE'):r.personId!==filters.personId))return false;
    if(filters.tag&&!String(r.tags||'').split(',').map(t=>t.trim().toLowerCase()).includes(filters.tag.toLowerCase()))return false;
    if(['status','reviewStatus','requestStatus','settlement','expectedState','currency','accountId','cardId','statementId','transactionId','shareId','type','installmentPlanId'].some(k=>filters[k]&&String(r[k]||'')!==filters[k]))return false;
    const date=r[basis]||'';return !(filters.from&&date<filters.from||filters.to&&date>filters.to);
   }).sort((a,b)=>{const x=a[parts[0]],y=b[parts[0]],c=typeof x==='number'&&typeof y==='number'?x-y:String(x||'').localeCompare(String(y||''));return (parts[1]==='asc'?1:-1)*c||a.id.localeCompare(b.id);});
   const p=Math.max(0,Math.floor(Number(page)||0));return {rows:rows.slice(p*40,p*40+40),total:rows.length,page:p,issues:(snapshot.issues||[]).filter(i=>i.entity===entity).slice(0,100),summary:null};
  }
 };
}
if(typeof window!=='undefined'){
 const original=window.fetch.bind(window),cache=createBrowseCache();let latestBoot=null;
 const reads=new Set(['apiBootstrap','apiList','apiImportLookups','apiReport','apiPackageReceipt','apiInstallmentSchedule','apiImportPreview','apiImportPage','apiImportStatus','apiSyncPreview','apiCalendarTest','apiCalendars','apiSyncStatus','apiExportDatabase']);
 window.fetch=async function(input,options){
  const url=typeof input==='string'?new URL(input,location.href):input instanceof URL?input:new URL(input.url),same=url.origin===location.origin;
  let payload;
  if(same&&url.pathname==='/api/rpc'&&typeof options?.body==='string')try{payload=JSON.parse(options.body);}catch{}
  if(same&&url.pathname==='/api/logout')cache.clear();
  if(payload?.action==='apiList'){const value=cache.list(...payload.args);if(value)return new Response(JSON.stringify({data:value}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
  const classification=payload?.action==='apiSave'&&['TransactionReview','TransactionReviewBatch'].includes(payload.args?.[0]);
  if(payload&&!reads.has(payload.action)&&!classification)cache.clear();
  const response=await original(input,options);
  if(response.status===401||response.status===403)cache.clear();
  if(payload&&response.ok)try{const value=(await response.clone().json()).data;if(payload.action==='apiBootstrap'){cache.load(value?.browseSnapshot);latestBoot=value;}if(classification)cache.patch(value?.rows||(value?.row?[value.row]:[]),value?.issues);}catch{cache.clear();}
  return response;
 };
 window.addEventListener('pagehide',()=>cache.clear());
 function integrationPanel(){
  if(latestBoot?.storage!=='supabase'||document.getElementById('title')?.textContent!=='Settings and Integration'||document.getElementById('database-controls'))return;
  const content=document.getElementById('content');if(!content)return;
  const panel=document.createElement('section');panel.id='database-controls';panel.className='card';
  const heading=document.createElement('h2');heading.textContent='Database and backups';panel.append(heading);
  const status=document.createElement('p');status.textContent='Supabase | '+latestBoot.databaseRevision+' | version '+latestBoot.databaseVersion;panel.append(status);
  const feedback=document.createElement('p');feedback.setAttribute('role','status');
  async function request(action){const response=await original('/api/rpc',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,args:[]})});const body=await response.json();if(!response.ok)throw Error(body.error||'Request failed.');return body.data;}
  const exportButton=document.createElement('button');exportButton.type='button';exportButton.className='secondary';exportButton.textContent='Download database backup';
  exportButton.addEventListener('click',async()=>{exportButton.disabled=true;try{const data=await request('apiExportDatabase'),url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='BillsBills_Backup_'+new Date().toISOString().slice(0,10)+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);feedback.textContent='Private backup prepared.';}catch(error){feedback.textContent=error.message;}finally{exportButton.disabled=false;}});
  const enable=document.createElement('button');enable.type='button';enable.className='secondary';enable.textContent='Enable Calendar and Sheet backups';
  enable.addEventListener('click',async()=>{if(!confirm('Enable Calendar synchronization and Sheet backups? Stop the old Apps Script automation before continuing.'))return;enable.disabled=true;try{const result=await request('apiActivateIntegrations');cache.clear();feedback.textContent=result.message;document.getElementById('refresh')?.click();}catch(error){feedback.textContent=error.message;}finally{enable.disabled=false;}});
  const toolbar=document.createElement('div');toolbar.className='toolbar';toolbar.append(exportButton,enable);panel.append(toolbar,feedback);content.append(panel);
 }
 new MutationObserver(integrationPanel).observe(document.body,{childList:true,subtree:true});

}
