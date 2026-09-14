function bridgeEqual_(a,b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff=0; for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i); return diff===0;
}

function bridgeRequest_(event) {
  if(!event || !event.postData || typeof event.postData.contents!=='string' || event.postData.contents.length>1500000)fail_('ACCESS_DENIED: Invalid request.');
  let envelope;try{envelope=JSON.parse(event.postData.contents);}catch(_){fail_('ACCESS_DENIED: Invalid request.');}
  const secret=props_().getProperty('BRIDGE_SECRET');
  if(!/^[a-f0-9]{64}$/i.test(secret||'')||typeof envelope.payload!=='string'||!/^[a-f0-9]{64}$/.test(envelope.signature||''))fail_('ACCESS_DENIED: Invalid request.');
  const signature=Utilities.computeHmacSha256Signature(envelope.payload,secret,Utilities.Charset.UTF_8).map(b=>('0'+((b+256)%256).toString(16)).slice(-2)).join('');
  if(!bridgeEqual_(signature,envelope.signature))fail_('ACCESS_DENIED: Invalid request.');
  let request;try{request=JSON.parse(envelope.payload);}catch(_){fail_('ACCESS_DENIED: Invalid request.');}
  if(request.version!==1||!Number.isSafeInteger(request.timestamp)||Math.abs(Date.now()-request.timestamp)>90000||!/^[a-f0-9]{32}$/.test(request.nonce||'')||!Array.isArray(request.args)||request.args.length>8)fail_('ACCESS_DENIED: Invalid request.');
  if(!props_().getProperty('OWNER_USER_ID')||request.actor!==props_().getProperty('OWNER_USER_ID'))fail_('ACCESS_DENIED: Invalid request.');
  const effective=String(Session.getEffectiveUser().getEmail()||'').toLowerCase(),owner=String(props_().getProperty('OWNER_EMAIL')||'').toLowerCase();
  if(!owner||effective!==owner)fail_('ACCESS_DENIED: Check the deployment owner.');
  const prefix='BRIDGE_NONCE_',key=prefix+request.nonce,all=props_().getProperties();
  if(all[key])fail_('ACCESS_DENIED: Request already used.');
  Object.keys(all).filter(k=>k.startsWith(prefix)&&Number(all[k])<Date.now()-180000).forEach(k=>props_().deleteProperty(k));
  props_().setProperty(key,String(request.timestamp));
  return request;
}

function doPost(event) {
  let output;
  try {
    output=locked_(()=>{
      const request=bridgeRequest_(event);
      const actions={apiIdentity,apiImportLookups,apiResolveMissing,apiBootstrap,apiList,apiSave,apiReport,apiRecover,apiInstallmentSchedule,apiSettings,apiBackup,apiCalendarTest,apiCalendars,apiCreateCalendar,apiSyncPreview,apiSync,apiCalendarMigrationPreview,apiCalendarMigrate,apiImportPreview,apiImportCommit,apiImportStage,apiImportValidate,apiImportPage,apiImportStatus,apiImportSelect,apiImportPause,apiImportBatchCommit,repairSettings,installTriggers,stopAutomation,apiPackageCommit,apiPackageReceipt};
      if(!Object.prototype.hasOwnProperty.call(actions,request.action))fail_('ACCESS_DENIED: Unsupported operation.');
      CC_BRIDGE_ACTOR=request.actor;
      try{return {ok:true,data:actions[request.action](...request.args)};}finally{CC_BRIDGE_ACTOR='';}
    });
  }catch(e){
    const message=String(e.message||'');
    output={ok:false,error:/^(VALIDATION|CONFLICT|SCHEMA|SETUP|BUSY|REVIEW|CALENDAR|IMPORT|RECOVERY|LIMIT):/.test(message)?message:'ACCESS_DENIED: Request rejected.'};
  }
  return ContentService.createTextOutput(JSON.stringify(output)).setMimeType(ContentService.MimeType.JSON);
}

function packageRecord_(entity,input) {
  if(!['Accounts','Cards','Statements','Transactions'].includes(entity)||!input||typeof input!=='object'||Array.isArray(input)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id||''))fail_('IMPORT: Invalid package record.');
  const columns=columns_(entity),record=meta_({},input.id);
  columns.forEach(k=>{if(record[k]===undefined)record[k]='';});
  Object.keys(input).forEach(k=>{
    if(k==='id')return;
    if(!columns.includes(k)||CC_COMMON.includes(k)||CC_TECH.includes(k)&&!['sourceKey','sourceRef'].includes(k))fail_('IMPORT: Protected package field.');
    const value=input[k];
    if(value!==null&&typeof value!=='string'&&typeof value!=='number'||String(value||'').length>3000)fail_('IMPORT: Invalid package field.');
    record[k]=value===null?'':value;
  });
  if(entity==='Transactions'&&!/^[a-f0-9]{64}:[0-9]+$/.test(record.sourceKey))fail_('IMPORT: Invalid source identity.');
  ['description','originalDescription','nickname','notes','cardholder','product','reference'].forEach(k=>{if(typeof record[k]==='string'&&/(?:\d[ -]?){13,19}/.test(record[k]))fail_('IMPORT: Use masked card identifiers.');});
  return record;
}

function apiPackageCommit(items,requestId) {
  return guard_(()=>{
    if(!Array.isArray(items)||items.length<1||items.length>15)fail_('IMPORT: Use a batch of 1 to 15 records.');
    const db=load_(),op=validRequest_(requestId),prior=db.Operations.find(x=>x.id===op);
    if(prior){if(prior.state!=='DONE')fail_('RECOVERY: Resume the pending operation.');return {replayed:true,inserted:0};}
    ensureRecovered_(db);
    const working=domainClone_(db),changes=[],sources=new Set(db.Transactions.map(t=>t.sourceKey).filter(Boolean));
    for(const item of items){
      const entity=item.entity,record=packageRecord_(entity,item.record);
      const existing=working[entity].find(x=>x.id===record.id);
      if(existing){
        if(Object.keys(item.record).some(k=>String(existing[k]??'')!==String(record[k]??'')))fail_('CONFLICT: Package record differs from the existing record.');
        continue;
      }
      if(entity==='Transactions'&&sources.has(record.sourceKey))fail_('CONFLICT: This source row already has a transaction.');
      if(entity==='Accounts'&&working.Accounts.some(x=>x.bank===record.bank&&x.nickname===record.nickname))fail_('CONFLICT: Billing account already exists.');
      if(entity==='Statements'&&working.Statements.some(x=>x.accountId===record.accountId&&x.statementDate===record.statementDate))fail_('CONFLICT: Statement already exists.');
      if(entity==='Cards'&&working.Cards.some(x=>x.accountId===record.accountId&&x.lastFour===record.lastFour))fail_('CONFLICT: Card already exists.');
      working[entity].push(record);changes.push({entity,before:null,after:record});
      if(entity==='Transactions')sources.add(record.sourceKey);
    }
    if(review_(working).some(x=>x.severity==='ERROR'))fail_('IMPORT: Review the package fields and relationships.');
    if(!changes.length)return {inserted:0};
    const count=changes.filter(x=>x.entity==='Transactions').length;
    changes.push({entity:'ImportHistory',before:null,after:meta_({sourceHash:hash_(JSON.stringify(items)),outcome:'COMMITTED',accepted:count,rejected:0,suspect:0,skipped:items.length-changes.length,summary:'Reviewed package import.'})});
    commit_(db,changes,op,'PACKAGE_IMPORT');
    return {inserted:changes.length-1,transactions:count};
  });
}

function apiPackageReceipt(sourceHash) {
  return guard_(()=>{
    if(!/^[a-f0-9]{64}$/.test(sourceHash||''))fail_('IMPORT: Invalid source hash.');
    const rows=load_().Transactions.filter(t=>t.sourceKey.startsWith(sourceHash+':'));
    const debits=rows.filter(t=>Number(t.amountMinor)>0),credits=rows.filter(t=>Number(t.amountMinor)<0);
    return {transactions:rows.length,debits:debits.length,credits:credits.length,debitMinor:sum_(debits,'amountMinor'),creditMinor:sum_(credits,'amountMinor'),netMinor:sum_(rows,'amountMinor'),currencies:[...new Set(rows.map(t=>t.currency))]};
  },true,true);
}
