const BB_WORKFLOW_REVISION = 'workspace-20260913-1';
const BB_REVIEW_BATCH_REVISION = 'review-batch-20260913-1';

function billsTagOptions_(db) {
  const options = new Map();
  const add = value => { const name = String(value || '').trim(); if (name && !options.has(name.toLowerCase())) options.set(name.toLowerCase(), name); };
  db.Labels.filter(r => r.key.startsWith('field.tag.')).forEach(r => add(r.value));
  db.Transactions.forEach(r => String(r.tags || '').split(',').forEach(add));
  return [...options.values()].sort((a,b) => a.localeCompare(b));
}

function billsPaymentSources_(db) {
  return {
    payments: db.BankPayments.filter(p => p.status === 'CONFIRMED').map(p => ({id:p.id,accountId:p.accountId,currency:p.currency,date:p.date,amountMinor:Number(p.amountMinor),availableMinor:Number(p.amountMinor)-sum_(db.PaymentAllocations.filter(a=>a.paymentId===p.id&&a.status==='ACTIVE'),'amountMinor'),reference:p.reference})),
    transactions: db.Transactions.filter(t => t.type === 'BANK_PAYMENT' && t.status === 'ACTIVE' && Number(t.amountMinor) < 0 && !db.BankPayments.some(p=>p.matchedTransactionId===t.id&&p.status!=='REVERSED')).map(t=>({id:t.id,accountId:t.accountId,currency:t.currency,date:t.transactionDate,amountMinor:-Number(t.amountMinor),description:t.description}))
  };
}

function billsBootstrap(view) {
  return guard_(() => {
    const db=load_(),issues=review_(db),configuration=configuration_(db),diagnostics=diagnostics_(db);
    configuration.labels['app.title']='BillBills'; configuration.labels['app.subtitle']='';
    diagnostics.workflowRevision=BB_WORKFLOW_REVISION;diagnostics.reviewBatchRevision=BB_REVIEW_BATCH_REVISION;
    diagnostics.triggers=ScriptApp.getProjectTriggers().filter(t=>['onSheetEdit_','reconcile_','reconcileBillsBills_'].includes(t.getHandlerFunction())).map(t=>({handler:t.getHandlerFunction(),id:t.getUniqueId()}));
    return {version:CC_VERSION,today:today_(db),schema:CC_SCHEMA,enums:CC_ENUMS,required:CC_REQUIRED,currencies:CC_CURRENCY,configuration,settings:clientSettings_(db),lookups:lookups_(db),overview:overview_(db,issues),issues:issues.slice(0,200),diagnostics,workflowRevision:BB_WORKFLOW_REVISION,reviewBatchRevision:BB_REVIEW_BATCH_REVISION,tagOptions:billsTagOptions_(db),paymentSources:billsPaymentSources_(db),currentPage:view&&view.entity?billsListView_(db,issues,view.entity,view.filters,view.page,view.sort):null};
  },true);
}

function billsListView_(db,issues,entity,filters,page,sort) {
  const f=Object.assign({},filters||{}),review=f.reviewStatus;
  delete f.reviewStatus;
  if(review&&!CC_ENUMS['Transactions.reviewStatus'].includes(review))fail_('VALIDATION: Choose a supported review status.');
  publicEntity_(entity);
  const rows=filtered_(entity,db,f,sort||'updatedAt:desc').filter(r=>!review||r.reviewStatus===review),p=Math.max(0,Math.floor(Number(page)||0));
  return {rows:rows.slice(p*40,p*40+40),total:rows.length,page:p,issues:issues.filter(x=>x.entity===entity).slice(0,100),summary:entity==='Shares'&&!issues.some(x=>x.severity==='ERROR')?collectionSummary_(rows):null};
}

function billsList(entity,filters,page,sort) {
  return guard_(()=>{const db=load_();return billsListView_(db,review_(db),entity,filters,page,sort);},true);
}

function billsChanged_(db,changes,opId,kind) {
  const next=domainClone_(db),oldErrors=new Set(review_(db).filter(x=>x.severity==='ERROR').map(issueKey_));
  changes.forEach(c=>{immutableLedger_(c.entity,c.before,c.after);next[c.entity]=next[c.entity].filter(r=>r.id!==c.after.id).concat(c.after);});
  const touched=new Set(changes.map(c=>c.entity+'|'+c.after.id));
  if(review_(next).some(x=>x.severity==='ERROR'&&(!oldErrors.has(issueKey_(x))||touched.has(x.entity+'|'+x.id))))fail_('VALIDATION: Check the selected type, amount, date and linked records.');
  configuration_(next);
  commit_(db,changes,opId,kind);props_().setProperty('SYNC_DIRTY','true');
}

function billsResult_(db,entity,id,replayed) {
  const issues=review_(db),record=db[entity].find(r=>r.id===id);
  return {id,replayed:!!replayed,row:record?decorate_(entity,record,db):null,overview:overview_(db,issues),issues:issues.slice(0,200),tagOptions:billsTagOptions_(db),paymentSources:billsPaymentSources_(db)};
}

function billsSave(entity,input,expectedToken,requestId) {
  if(entity==='InstallmentLinks')return billsSaveInstallmentLinks_(input,requestId);
  if(entity==='TransactionReviewBatch')return billsSaveReviewBatch_(input,requestId);
  if(!['TransactionReview','StatementPayment','TagOption'].includes(entity))return apiSave(entity,input,expectedToken,requestId);
  return guard_(()=>{
    if(!input||typeof input!=='object'||Array.isArray(input))fail_('VALIDATION: Provide the selected record.');
    const db=load_(),opId=validRequest_(requestId),prior=db.Operations.find(o=>o.id===opId);
    if(prior){
      if(prior.state!=='DONE')fail_('RECOVERY: Resume the pending operation.');
      const expectedKind={TransactionReview:'TRANSACTION_REVIEW',StatementPayment:'STATEMENT_PAYMENT',TagOption:'TAG_OPTION'}[entity];
      if(prior.kind!==expectedKind)fail_('CONFLICT: Operation identifier belongs to another action.');
      if(entity==='TagOption')return {tagOptions:billsTagOptions_(db),replayed:true};
      const actualEntity=entity==='TransactionReview'?'Transactions':'Statements',actualId=entity==='TransactionReview'?input.id:input.statementId;
      if(!JSON.parse(prior.payload).some(c=>c.entity===actualEntity&&c.after.id===actualId))fail_('CONFLICT: Operation identifier belongs to another record.');
      return billsResult_(db,actualEntity,actualId,true);
    }
    ensureRecovered_(db);
    if(entity==='TagOption'){
      const name=String(input.name||'').trim();
      if(!name||name.length>60||/[,\r\n\x00-\x1f]/.test(name))fail_('VALIDATION: Enter a tag of 1 to 60 characters without commas or line breaks.');
      const key='field.tag.'+hash_(name.toLowerCase()).slice(0,24),existing=db.Labels.find(r=>r.key===key);
      if(existing)return {tagOptions:billsTagOptions_(db)};
      if(db.Labels.filter(r=>r.key.startsWith('field.tag.')).length>=500)fail_('LIMIT: Up to 500 saved tag options.');
      billsChanged_(db,[{entity:'Labels',before:null,after:prepare_('Labels',{key,value:name},null)}],opId,'TAG_OPTION');
      return {tagOptions:billsTagOptions_(load_())};
    }
    if(entity==='TransactionReview'){
      const before=db.Transactions.find(r=>r.id===input.id);
      if(!before||token_(before)!==expectedToken)fail_('CONFLICT: Transaction changed. Refresh before saving.');
      if(!CC_ENUMS['Transactions.type'].includes(input.type)||!CC_ENUMS['Transactions.reviewStatus'].includes(input.reviewStatus))fail_('VALIDATION: Select a transaction type and review status.');
      const rawTags=String(input.tags||'').split(',').map(s=>s.trim()).filter(Boolean),tags=[...new Map(rawTags.map(s=>[s.toLowerCase(),s])).values()];
      if(tags.length>30||tags.some(t=>t.length>60||/[\r\n\x00-\x1f]/.test(t)))fail_('VALIDATION: Choose up to 30 tags of 60 characters each.');
      const after=prepare_('Transactions',{type:input.type,reviewStatus:input.reviewStatus,tags:tags.join(', ')},before);
      billsChanged_(db,[{entity:'Transactions',before,after}],opId,'TRANSACTION_REVIEW');
      return billsResult_(load_(),'Transactions',after.id,false);
    }
    const before=db.Statements.find(s=>s.id===input.statementId);
    if(!before||token_(before)!==expectedToken)fail_('CONFLICT: Statement changed. Refresh before saving.');
    const modes=['FULL','PARTIAL','VERIFY_UNPAID','VERIFY_NO_DUE','REVIEW'];
    if(!modes.includes(input.mode))fail_('VALIDATION: Choose a payment action.');
    const totals=statementTotals_(before,db),changes=[];
    if(input.mode==='VERIFY_UNPAID'){
      if(before.balanceMinor===''||Number(before.balanceMinor)<=0||db.PaymentAllocations.some(a=>a.statementId===before.id&&a.status==='ACTIVE'))fail_('VALIDATION: Review existing allocations and the positive statement balance first.');
    } else if(input.mode==='VERIFY_NO_DUE'){
      if(before.balanceMinor===''||Number(before.balanceMinor)>0)fail_('VALIDATION: A zero or credit statement balance is required.');
    } else if(input.mode==='FULL'||input.mode==='PARTIAL'){
      const amount=input.amountMinor;
      if(before.status!=='OPEN'||totals.remainingMinor===''||!Number.isSafeInteger(amount)||amount<=0||amount>totals.remainingMinor)fail_('VALIDATION: Enter a positive payment within the remaining statement amount.');
      if(input.mode==='FULL'&&amount!==totals.remainingMinor)fail_('CONFLICT: The remaining amount changed. Refresh before recording full payment.');
      if(input.mode==='PARTIAL'&&amount>=totals.remainingMinor)fail_('VALIDATION: Choose paid in full when paying the entire remaining amount.');
      let payment;
      if(input.source==='PAYMENT'){
        payment=db.BankPayments.find(p=>p.id===input.paymentId&&p.status==='CONFIRMED');
        if(!payment)fail_('VALIDATION: Select a confirmed bank payment.');
      }else if(input.source==='TRANSACTION'){
        const t=db.Transactions.find(t=>t.id===input.transactionId&&t.type==='BANK_PAYMENT'&&t.status==='ACTIVE'&&Number(t.amountMinor)<0);
        if(!t||db.BankPayments.some(p=>p.matchedTransactionId===t.id&&p.status!=='REVERSED'))fail_('CONFLICT: Select an unmatched bank-payment transaction.');
        payment=prepare_('BankPayments',{accountId:t.accountId,date:t.transactionDate,amountMinor:-Number(t.amountMinor),currency:t.currency,status:'CONFIRMED',reference:String(input.reference||''),notes:'',matchedTransactionId:t.id},null);
        changes.push({entity:'BankPayments',before:null,after:payment});
      }else if(input.source==='NEW'){
        if(!dateValid_(input.date)||input.date>today_(db))fail_('VALIDATION: Enter the actual payment date, today or earlier.');
        payment=prepare_('BankPayments',{accountId:before.accountId,date:input.date,amountMinor:amount,currency:before.currency,status:'CONFIRMED',reference:String(input.reference||''),notes:'',matchedTransactionId:''},null);
        changes.push({entity:'BankPayments',before:null,after:payment});
      }else fail_('VALIDATION: Choose where this payment is recorded.');
      if(payment.accountId!==before.accountId||payment.currency!==before.currency)fail_('VALIDATION: Payment must match the statement account and currency.');
      const reserved=sum_(db.PaymentAllocations.filter(a=>a.paymentId===payment.id&&a.status==='ACTIVE'),'amountMinor');
      if(amount>Number(payment.amountMinor)-reserved)fail_('VALIDATION: The payment has insufficient unallocated funds.');
      changes.push({entity:'PaymentAllocations',before:null,after:prepare_('PaymentAllocations',{paymentId:payment.id,statementId:before.id,amountMinor:amount,status:'ACTIVE'},null)});
    }
    const after=prepare_('Statements',{reconciliation:input.mode==='REVIEW'?'UNVERIFIED':'VERIFIED'},before);
    changes.push({entity:'Statements',before,after});
    billsChanged_(db,changes,opId,'STATEMENT_PAYMENT');
    return billsResult_(load_(),'Statements',after.id,false);
  },true);
}

function billsSaveInstallmentLinks_(input,requestId){
 return guard_(()=>{
  if(!input||typeof input.planId!=='string'||!Array.isArray(input.items)||!input.items.length||input.items.length>10)fail_('VALIDATION: Select a plan and up to 10 charges per batch.');
  const db=load_(),opId=validRequest_(requestId),items=input.items,seen=new Set(),numbers=new Set();
  for(const item of items){if(!item||typeof item.id!=='string'||seen.has(item.id)||!/^[a-f0-9]{64}$/i.test(item.token||'')||!Number.isInteger(item.number)||item.number<1||numbers.has(item.number))fail_('VALIDATION: Select distinct charges and installment numbers.');seen.add(item.id);numbers.add(item.number);}
  const prior=db.Operations.find(o=>o.id===opId);
  if(prior){const changes=JSON.parse(prior.payload);if(prior.kind!=='INSTALLMENT_LINKS'||changes.length!==items.length||items.some(i=>!changes.some(c=>c.after.id===i.id&&token_(c.before)===i.token&&c.after.installmentPlanId===input.planId&&c.after.installmentNumber===i.number)))fail_('CONFLICT: Retry the original installment selections.');if(prior.state!=='DONE')fail_('RECOVERY: Resume the pending operation.');return billsReviewBatchResult_(db,items,true,true);}
  ensureRecovered_(db);
  const plan=db.InstallmentPlans.find(p=>p.id===input.planId&&p.status!=='ARCHIVED');if(!plan)fail_('VALIDATION: Choose an existing active or completed installment plan.');
  const changes=items.map(item=>{
   const before=db.Transactions.find(t=>t.id===item.id);
   if(!before||token_(before)!==item.token)fail_('CONFLICT: A selected charge changed. Refresh and review it before linking.');
   if(before.status!=='ACTIVE'||Number(before.amountMinor)<=0||!['UNKNOWN','PURCHASE','INSTALLMENT'].includes(before.type))fail_('VALIDATION: Select active purchase or installment charges, not payments or financed principal.');
   if(before.accountId!==plan.accountId||before.currency!==plan.currency||plan.cardId&&before.cardId!==plan.cardId)fail_('VALIDATION: Charges must match the plan account, currency and card.');
   if(before.installmentPlanId&&before.installmentPlanId!==plan.id)fail_('CONFLICT: A charge already belongs to another plan.');
   if(item.number>Number(plan.count))fail_('VALIDATION: Installment number exceeds the plan length.');
   if(db.Transactions.some(t=>!seen.has(t.id)&&t.status==='ACTIVE'&&t.type==='INSTALLMENT'&&t.installmentPlanId===plan.id&&Number(t.installmentNumber)===item.number))fail_('CONFLICT: That installment number already has a linked charge.');
   return {entity:'Transactions',before,after:prepare_('Transactions',{installmentPlanId:plan.id,installmentNumber:item.number,type:'INSTALLMENT'},before)};
  });
  if(JSON.stringify(changes).length>44000)fail_('LIMIT: Link fewer charges in this batch.');
  billsChanged_(db,changes,opId,'INSTALLMENT_LINKS');return billsReviewBatchResult_(load_(),items,true,false);
 },true);
}

function billsCalendarMarker_(s) {
  return 'BillsBills link: '+hash_(props_().getProperty('SPREADSHEET_ID')+'|'+s.id).slice(0,40);
}

function billsEventPlan_(s,db,settings) {
  const p=eventPlan_(s,db,settings),past=s.dueDate<today_(db);
  p.body.summary=p.body.summary.replace(/^Card payment/, 'BillsBills');
  p.body.description='Statement due-date record. Payment status is maintained in BillsBills.\n'+billsCalendarMarker_(s);
  p.body.visibility='private';p.body.transparency='transparent';
  if(past)p.body.reminders={useDefault:false,overrides:[]};
  p.skip=!s.eventId&&(s.calendarMode!=='ON'||s.status==='ARCHIVED'||past&&settings.IncludeHistorical!=='true');
  p.fingerprint=hash_(JSON.stringify(p.body));return p;
}

function billsAdoptEvent_(s,p) {
  let page,found=[];
  do{
    const options={q:billsCalendarMarker_(s),maxResults:100,showDeleted:false,singleEvents:true};
    if(page)options.pageToken=page;
    const response=Calendar.Events.list(p.cal,options);
    found=found.concat((response.items||[]).filter(e=>String(e.description||'').replace(/<[^>]*>/g,'\n').replace(/&nbsp;/gi,' ').split(/\r?\n/).map(line=>line.trim()).includes(billsCalendarMarker_(s))));
    page=response.nextPageToken;
    if(found.length>1)fail_('CALENDAR: Duplicate linked events need review.');
  }while(page);
  if(!found.length)return null;
  const event=found[0];
  const date=event.start&&event.start.dateTime?Utilities.formatDate(new Date(event.start.dateTime),p.body.start.timeZone,'yyyy-MM-dd'):event.start&&event.start.date;
  if(date!==s.dueDate||(event.attendees||[]).length||event.visibility!=='private'||event.recurringEventId)fail_('CALENDAR: Linked event details need review.');
  Calendar.Events.patch({extendedProperties:p.body.extendedProperties},p.cal,event.id,{sendUpdates:'none'});
  return event.id;
}

function billsSync_(db,force) {
  const settings=settings_(db);validateSettings_(settings);ensureRecovered_(db);
  if(settings.SyncEnabled!=='true')return {processed:0,failed:0,remaining:0,message:'Synchronization is disabled.'};
  if(review_(db).some(x=>x.severity==='ERROR'))fail_('REVIEW: Repair invalid records before synchronization.');
  let processed=0,failed=0,remaining=0;const deadline=Date.now()+15000;
  const candidates=db.Statements.filter(s=>s.calendarMode!=='OFF'||s.eventId).sort((a,b)=>String(a.syncedAt).localeCompare(String(b.syncedAt)));
  for(let s of candidates){
    let p;try{p=billsEventPlan_(s,db,settings);}catch(_){failed++;continue;}
    if(p.skip)continue;
    if(s.eventId&&s.fingerprint===p.fingerprint&&!s.syncError&&Date.now()-Date.parse(s.syncedAt||'1970-01-01')<86400000)continue;
    if(processed+failed>=4||Date.now()>deadline){remaining++;continue;}
    if(!force&&s.nextRetry&&Date.parse(s.nextRetry)>Date.now()){remaining++;continue;}
    try{
      if(!s.eventId){
        const adopted=billsAdoptEvent_(s,p);if(adopted)p.id=adopted;
        const reserved=Object.assign({},s,{calendarId:p.cal,eventId:p.id});write_('Statements',s,reserved);s=reserved;SpreadsheetApp.flush();
      }
      const ev=calendarGet_(p.cal,p.id);
      if(ev&&(!eventOwned_(ev,s)||ev.status==='cancelled'))fail_('CALENDAR: Check event ownership or deletion.');
      if(ev)Calendar.Events.patch(p.body,p.cal,p.id,{sendUpdates:'none'});
      else try{Calendar.Events.insert(Object.assign({id:p.id},p.body),p.cal,{sendUpdates:'none'});}catch(error){const recovered=calendarGet_(p.cal,p.id);if(!eventOwned_(recovered,s))throw error;Calendar.Events.patch(p.body,p.cal,p.id,{sendUpdates:'none'});}
      write_('Statements',s,Object.assign({},s,{calendarId:p.cal,eventId:p.id,syncedAt:now_(),fingerprint:p.fingerprint,syncError:'',attempts:0,nextRetry:'',revision:Number(s.revision)+1,updatedAt:now_()}));processed++;
    }catch(_){failed++;const attempts=Number(s.attempts||0)+1;write_('Statements',s,Object.assign({},s,{syncError:'Calendar sync needs review: date, owner, linked event or permission.',attempts,nextRetry:new Date(Date.now()+120000).toISOString()}));}
  }
  props_().setProperty('LAST_SYNC',now_());
  if(!remaining&&!failed)props_().deleteProperty('SYNC_DIRTY');
  return {processed,failed,remaining,message:failed?'Review the reported Calendar errors.':remaining?'More statements are waiting.':'All selected statement events are synchronized.'};
}

function billsSync() {return guard_(()=>billsSync_(load_(),true));}
function billsSyncPreview() {return guard_(()=>{const db=load_();return db.Statements.filter(s=>s.calendarMode!=='OFF'||s.eventId).map(s=>{try{const p=billsEventPlan_(s,db,settings_(db));return {id:s.id,dueDate:s.dueDate,action:p.skip?'SKIP':p.disabled?'HISTORY / SILENT':s.eventId?'UPDATE':'CREATE / LINK'};}catch(_){return {id:s.id,action:'REVIEW'};}});});}
function billsStopAutomation() {return guard_(()=>{ScriptApp.getProjectTriggers().filter(t=>['onSheetEdit_','reconcile_','reconcileBillsBills_'].includes(t.getHandlerFunction())).forEach(t=>ScriptApp.deleteTrigger(t));props_().deleteProperty('TRIGGER_IDS');return {stopped:true};});}
function billsInstallTriggers() {return guard_(()=>{billsStopAutomation();const a=ScriptApp.newTrigger('onSheetEdit_').forSpreadsheet(book_()).onEdit().create(),b=ScriptApp.newTrigger('reconcileBillsBills_').timeBased().everyMinutes(15).create();props_().setProperty('TRIGGER_IDS',JSON.stringify([a.getUniqueId(),b.getUniqueId()]));return {installed:2};});}
function reconcileBillsBills_(event) {triggerOwner_(event);try{locked_(()=>{reconcileSheetEdits_();const db=load_();billsSync_(db,false);const s=settings_(db);if(s.BackupEnabled==='true'&&Date.now()-Date.parse(props_().getProperty('LAST_BACKUP')||'1970-01-01')>=Number(s.BackupDays)*86400000)backup_(db);});props_().deleteProperty('AUTOMATION_ERROR');}catch(_){props_().setProperty('AUTOMATION_ERROR','Review pending operations and Calendar settings.');}}

function activateBillsBills() {
  owner_();
  return guard_(()=>{
    const db=load_();ensureRecovered_(db);
    const target=settings_(db).CalendarId||String(props_().getProperty('OWNER_EMAIL')||'').trim();
    Calendar.Calendars.get(target);
    if(db.Statements.some(s=>s.calendarId&&s.calendarId!==target))fail_('CALENDAR: Migrate the existing calendar before activating.');
    const changes=[];
    [['CalendarId',target],['IncludeHistorical','true'],['SyncEnabled','true']].forEach(([key,value])=>{const before=db.Settings.find(r=>r.key===key);if(!before||before.value!==value)changes.push({entity:'Settings',before:before||null,after:prepare_('Settings',{key,value},before)});});
    [['app.title','BillsBills'],['app.subtitle','']].forEach(([key,value])=>{const before=db.Labels.find(r=>r.key===key);if(!before||before.value!==value)changes.push({entity:'Labels',before:before||null,after:prepare_('Labels',{key,value},before)});});
    db.Statements.filter(s=>dateValid_(s.dueDate)&&s.status==='OPEN'&&s.calendarMode!=='ON').forEach(before=>changes.push({entity:'Statements',before,after:prepare_('Statements',{calendarMode:'ON'},before)}));
    for(let i=0;i<changes.length;i+=8)billsChanged_(load_(),changes.slice(i,i+8),id_(),'WORKSPACE_ACTIVATION');
    billsInstallTriggers();
    const result=billsSync_(load_(),true);console.log(JSON.stringify({revision:BB_WORKFLOW_REVISION,calendar:target,...result}));return result;
  },true);
}

function billsReviewBatchItems_(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['items','includeSummary'].includes(k))||!Array.isArray(input.items)||input.items.length<1||input.items.length>10||typeof input.includeSummary!=='boolean')fail_('VALIDATION: Save a batch of 1 to 10 transaction classifications.');
  const seen=new Set();
  return input.items.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!['id','token','type','reviewStatus','tags'].includes(k))||typeof item.id!=='string'||!item.id||seen.has(item.id)||!/^[a-f0-9]{64}$/i.test(item.token||''))fail_('VALIDATION: Check the transaction identifiers and revisions.');
    seen.add(item.id);
    if(!CC_ENUMS['Transactions.type'].includes(item.type)||!CC_ENUMS['Transactions.reviewStatus'].includes(item.reviewStatus)||typeof item.tags!=='string')fail_('VALIDATION: Choose a transaction type, review status and tags.');
    const tags=[...new Map(item.tags.split(',').map(t=>t.trim()).filter(Boolean).map(t=>[t.toLowerCase(),t])).values()];
    if(tags.length>30||tags.some(t=>t.length>60||/[\r\n\x00-\x1f]/.test(t)))fail_('VALIDATION: Choose up to 30 tags of 60 characters each.');
    return {id:item.id,token:item.token,type:item.type,reviewStatus:item.reviewStatus,tags:tags.join(', ')};
  });
}

function billsReviewBatchResult_(db,items,includeSummary,replayed) {
  const result={reviewBatchRevision:BB_REVIEW_BATCH_REVISION,replayed:!!replayed,rows:items.map(item=>db.Transactions.find(t=>t.id===item.id)).filter(Boolean).map(row=>decorate_('Transactions',row,db))};
  if(includeSummary){
    const issues=review_(db);
    Object.assign(result,{overview:overview_(db,issues),issues:issues.slice(0,200),tagOptions:billsTagOptions_(db),paymentSources:billsPaymentSources_(db)});
  }
  return result;
}

function billsSaveReviewBatch_(input,requestId) {
  return guard_(()=>{
    const items=billsReviewBatchItems_(input),opId=validRequest_(requestId),db=load_(),prior=db.Operations.find(o=>o.id===opId);
    if(prior){
      if(prior.kind!=='TRANSACTION_REVIEW_BATCH')fail_('CONFLICT: This save identifier belongs to another action.');
      const changes=JSON.parse(prior.payload).filter(c=>c.entity==='Transactions');
      if(changes.length!==items.length||items.some(item=>!changes.some(c=>c.before&&c.after.id===item.id&&token_(c.before)===item.token&&c.after.type===item.type&&c.after.reviewStatus===item.reviewStatus&&c.after.tags===item.tags)))fail_('CONFLICT: Retry the original batch without changing its selections.');
      if(prior.state!=='DONE')fail_('RECOVERY: Resume the pending operation, then retry Save changes.');
      return billsReviewBatchResult_(db,items,input.includeSummary,true);
    }
    ensureRecovered_(db);
    const changes=[],byId=new Map(db.Transactions.map(t=>[t.id,t])),labels=new Map(db.Labels.map(t=>[t.key,t])),newLabels=new Map();
    for(const item of items){
      const before=byId.get(item.id);
      if(!before||token_(before)!==item.token)fail_('CONFLICT: A transaction changed. Keep or discard your pending selections, refresh the records, and review the changed transaction.');
      const after=prepare_('Transactions',{type:item.type,reviewStatus:item.reviewStatus,tags:item.tags},before);
      changes.push({entity:'Transactions',before,after});
      for(const name of item.tags.split(',').map(t=>t.trim()).filter(Boolean)){
        const key='field.tag.'+hash_(name.toLowerCase()).slice(0,24);
        if(labels.has(key)&&String(labels.get(key).value).toLowerCase()!==name.toLowerCase())fail_('CONFLICT: A saved tag name needs review.');
        if(!labels.has(key)&&!newLabels.has(key))newLabels.set(key,{entity:'Labels',before:null,after:prepare_('Labels',{key,value:name},null)});
      }
    }
    if(db.Labels.filter(r=>r.key.startsWith('field.tag.')).length+newLabels.size>500)fail_('LIMIT: Up to 500 saved tag options.');
    changes.push(...newLabels.values());
    if(JSON.stringify(changes).length>44000)fail_('LIMIT: These records exceed the batch size. Save fewer selections together.');
    billsChanged_(db,changes,opId,'TRANSACTION_REVIEW_BATCH');
    return billsReviewBatchResult_(load_(),items,input.includeSummary,false);
  },true);
}
