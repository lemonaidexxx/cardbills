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
    return {version:CC_VERSION,today:today_(db),schema:CC_SCHEMA,enums:CC_ENUMS,required:CC_REQUIRED,currencies:CC_CURRENCY,configuration,settings:clientSettings_(db),lookups:lookups_(db),overview:{...overview_(db,issues),charts:billsCharts_(db,{})},issues:issues.slice(0,200),diagnostics,workflowRevision:BB_WORKFLOW_REVISION,reviewBatchRevision:BB_REVIEW_BATCH_REVISION,tagOptions:billsTagOptions_(db),paymentSources:billsPaymentSources_(db),currentPage:view&&view.entity?billsListView_(db,issues,view.entity,view.filters,view.page,view.sort):null};
  },true);
}

function billsListView_(db,issues,entity,filters,page,sort) {
  const f=Object.assign({},filters||{}),review=f.reviewStatus;
  delete f.reviewStatus;
  if(review&&!CC_ENUMS['Transactions.reviewStatus'].includes(review))fail_('VALIDATION: Choose a supported review status.');
  publicEntity_(entity);
  const rows=filtered_(entity,db,f,sort||'updatedAt:desc').filter(r=>!review||r.reviewStatus===review),p=Math.max(0,Math.floor(Number(page)||0));
  return {rows:rows.slice(p*40,p*40+40).map(r=>entity==='Transactions'?{...r,assignedShares:db.Shares.filter(s=>s.transactionId===r.id&&s.status==='ACTIVE').map(s=>({id:s.id,personId:s.personId,amountMinor:s.amountMinor}))}:r),total:rows.length,page:p,issues:issues.filter(x=>x.entity===entity).slice(0,100),summary:entity==='Shares'&&!issues.some(x=>x.severity==='ERROR')?collectionSummary_(rows):null};
}

function billsList(entity,filters,page,sort) {
  return guard_(()=>{const db=load_();if(entity==='LoanDashboard')return loanDashboard_(db,filters||{});if(entity==='OverviewCharts')return billsCharts_(db,filters||{});if(entity==='DuplicateReview')return billsDuplicates_(db,page);return billsListView_(db,review_(db),entity,filters,page,sort);},true);
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
  if(['Loans','LoanSchedules','LoanPayment','ReverseLoanPayment','ShareBatch'].includes(entity))return billsLedgerAction_(entity,input,expectedToken,requestId);
  if(['LoanPayments','LoanAllocations'].includes(entity))fail_('VALIDATION: Use Record payment or Reverse payment.');
  if(entity==='DuplicateResolution')return billsResolveDuplicate_(input,requestId);
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
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!['id','token','type','reviewStatus','tags','category','dueDate','notes'].includes(k))||typeof item.id!=='string'||!item.id||seen.has(item.id)||!/^[a-f0-9]{64}$/i.test(item.token||''))fail_('VALIDATION: Check the transaction identifiers and revisions.');
    seen.add(item.id);
    if(!CC_ENUMS['Transactions.type'].includes(item.type)||!CC_ENUMS['Transactions.reviewStatus'].includes(item.reviewStatus)||typeof item.tags!=='string')fail_('VALIDATION: Choose a transaction type, review status and tags.');
    const tags=[...new Map(item.tags.split(',').map(t=>t.trim()).filter(Boolean).map(t=>[t.toLowerCase(),t])).values()];
    if(tags.length>30||tags.some(t=>t.length>60||/[\r\n\x00-\x1f]/.test(t)))fail_('VALIDATION: Choose up to 30 tags of 60 characters each.');
    const extra={};for(const key of ['category','dueDate','notes'])if(Object.prototype.hasOwnProperty.call(item,key)){if(typeof item[key]!=='string')fail_('VALIDATION: Invalid '+key);extra[key]=item[key];}return {id:item.id,token:item.token,type:item.type,reviewStatus:item.reviewStatus,tags:tags.join(', '),...extra};
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
      if(changes.length!==items.length||items.some(item=>!changes.some(c=>c.before&&c.after.id===item.id&&token_(c.before)===item.token&&c.after.type===item.type&&c.after.reviewStatus===item.reviewStatus&&c.after.tags===item.tags&&['category','dueDate','notes'].every(k=>!(k in item)||c.after[k]===item[k]))))fail_('CONFLICT: Retry the original batch without changing its selections.');
      if(prior.state!=='DONE')fail_('RECOVERY: Resume the pending operation, then retry Save changes.');
      return billsReviewBatchResult_(db,items,input.includeSummary,true);
    }
    ensureRecovered_(db);
    const changes=[],byId=new Map(db.Transactions.map(t=>[t.id,t])),labels=new Map(db.Labels.map(t=>[t.key,t])),newLabels=new Map();
    for(const item of items){
      const before=byId.get(item.id);
      if(!before||token_(before)!==item.token)fail_('CONFLICT: A transaction changed. Keep or discard your pending selections, refresh the records, and review the changed transaction.');
      const {id,token,...patch}=item;const after=prepare_('Transactions',patch,before);
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

function duplicateKey_(r){return JSON.stringify([r.accountId,r.cardId||'',r.currency,Number(r.amountMinor),r.transactionDate,String(r.description||'').trim().replace(/\s+/g,' ').toLowerCase()]);}
function duplicateFingerprint_(rows){return hash_(JSON.stringify(rows.slice().sort((a,b)=>a.id.localeCompare(b.id)).map(r=>[r.id,token_(r)])));}
function duplicateBlockers_(db,rows){const reasons=[];for(const r of rows){if(db.Shares.some(s=>s.transactionId===r.id))reasons.push('Linked share or repayment: '+r.id);if(db.BankPayments.some(p=>p.matchedTransactionId===r.id))reasons.push('Linked bank payment: '+r.id);if(r.installmentPlanId||db.InstallmentPlans.some(p=>p.originTransactionId===r.id))reasons.push('Linked installment plan: '+r.id);}if(rows[0].statementId!==rows[1].statementId)reasons.push('Different statement links require reconciliation.');return reasons;}
function billsDuplicates_(db,page){const groups=new Map(),kept=new Set(JSON.parse(props_().getProperty('DUPLICATE_KEEP')||'[]'));for(const r of db.Transactions.filter(r=>r.status==='ACTIVE').sort((a,b)=>a.id.localeCompare(b.id))){const key=duplicateKey_(r);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}const p=Math.max(0,Math.floor(Number(page)||0)),rows=[];let total=0;for(const group of groups.values())for(let i=0;i<group.length;i++)for(let j=i+1;j<group.length;j++){const pair=[group[i],group[j]],fingerprint=duplicateFingerprint_(pair);if(kept.has(fingerprint))continue;if(total>=p*20&&rows.length<20)rows.push({fingerprint,records:pair.map(r=>decorate_('Transactions',r,db)),blockers:duplicateBlockers_(db,pair)});total++;}return {rows,total,page:p};}
function billsResolveDuplicate_(input,requestId){return guard_(()=>{
 if(!input||!['keep','merge'].includes(input.mode)||!Array.isArray(input.ids)||input.ids.length!==2||input.ids[0]===input.ids[1])fail_('VALIDATION: Choose two duplicate candidates.');
 const db=load_(),opId=validRequest_(requestId),kind='DUPLICATE_'+input.mode.toUpperCase()+'_'+hash_(JSON.stringify(input)),prior=db.Operations.find(o=>o.id===opId);
 if(prior){if(prior.kind!==kind||prior.state!=='DONE')fail_('CONFLICT: Retry the original duplicate decision.');return {replayed:true};}
 ensureRecovered_(db);const rows=input.ids.map(id=>db.Transactions.find(r=>r.id===id));if(rows.some(r=>!r||r.status!=='ACTIVE')||duplicateKey_(rows[0])!==duplicateKey_(rows[1])||duplicateFingerprint_(rows)!==input.fingerprint)fail_('CONFLICT: These records changed. Refresh duplicate review.');
 if(input.mode==='keep'){const kept=JSON.parse(props_().getProperty('DUPLICATE_KEEP')||'[]');if(!kept.includes(input.fingerprint))kept.push(input.fingerprint);if(kept.length>400)fail_('LIMIT: Duplicate decision storage needs review before adding more decisions.');commit_(db,[],opId,kind);props_().setProperty('DUPLICATE_KEEP',JSON.stringify(kept));return {kept:true};}
 if(input.confirmed!==true)fail_('VALIDATION: Confirm the merge first.');const blockers=duplicateBlockers_(db,rows);if(blockers.length)fail_('VALIDATION: '+blockers.join(' '));
 const survivor=rows.find(r=>r.id===input.survivorId),duplicate=rows.find(r=>r.id!==input.survivorId);if(!survivor)fail_('VALIDATION: Choose the surviving record.');
 const allowed=['description','originalDescription','postingDate','dueDate','type','category','tags','notes','reviewStatus'];if(!input.fields||Array.isArray(input.fields)||Object.keys(input.fields).some(k=>!allowed.includes(k)))fail_('VALIDATION: Unsupported merge fields.');
 const after=prepare_('Transactions',input.fields,survivor),voided=prepare_('Transactions',{status:'VOID'},duplicate);billsChanged_(db,[{entity:'Transactions',before:survivor,after},{entity:'Transactions',before:duplicate,after:voided}],opId,kind);return billsResult_(load_(),'Transactions',survivor.id,false);
},true);}

function billsCharts_(db,filters){
 const end=filters.endMonth||today_(db).slice(0,7);if(!/^\d{4}-\d{2}$/.test(end)||!dateValid_(end+'-01'))fail_('VALIDATION: Invalid chart month.');
 const months=[];for(let i=11;i>=0;i--)months.push(new Date(Date.UTC(Number(end.slice(0,4)),Number(end.slice(5,7))-1-i,1)).toISOString().slice(0,7));
 const currentMonth=today_(db).slice(0,7);const currencies={};for(const currency of [...new Set(db.Accounts.map(a=>a.currency))])currencies[currency]={months:months.map(month=>({month,amountMinor:0})),cards:[],types:[],currentCards:[],undatedCount:0};
 const invalid=review_(db).some(i=>i.severity==='ERROR');if(invalid)return {endMonth:end,currentMonth,currencies,invalid};
 for(const t of db.Transactions){if(t.status!=='ACTIVE'||!['PURCHASE','FEE','INTEREST','CASH_ADVANCE','INSTALLMENT'].includes(t.type))continue;const group=currencies[t.currency]||(currencies[t.currency]={months:months.map(month=>({month,amountMinor:0})),cards:[],types:[],currentCards:[],undatedCount:0});if(!t.postingDate){group.undatedCount++;continue;}if(t.postingDate.slice(0,7)===currentMonth){let card=group.currentCards.find(c=>c.id===(t.cardId||''));if(!card){card={id:t.cardId||'',amountMinor:0};group.currentCards.push(card);}card.amountMinor=addMinor_(card.amountMinor,t.amountMinor);}const month=group.months.find(m=>m.month===t.postingDate.slice(0,7));if(!month)continue;month.amountMinor=addMinor_(month.amountMinor,t.amountMinor);for(const [key,id]of [['cards',t.cardId||''],['types',t.type]]){let item=group[key].find(v=>v.id===id);if(!item){item={id,amountMinor:0};group[key].push(item);}item.amountMinor=addMinor_(item.amountMinor,t.amountMinor);}}
 return {endMonth:end,currentMonth,currencies,invalid};
}

function loanInstallments_(db,loan){
 if(!dateValid_(loan.firstDueDate)||!Number.isInteger(Number(loan.termMonths))||loan.termMonths<1||loan.termMonths>600||!Number.isInteger(Number(loan.dueDay))||loan.dueDay<1||loan.dueDay>31)fail_('VALIDATION: Check loan dates, due day and term (1 to 600 months).');const rows=[],start=new Date(loan.firstDueDate+'T00:00:00Z');for(let n=1;n<=Number(loan.termMonths);n++){const month=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+n-1,1)),day=Math.min(Number(loan.dueDay),new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth()+1,0)).getUTCDate()),dueDate=new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth(),day)).toISOString().slice(0,10);const segment=db.LoanSchedules.find(s=>s.loanId===loan.id&&s.status==='ACTIVE'&&s.startDate<=dueDate&&s.endDate>=dueDate),amountMinor=segment?Number(segment.monthlyMinor):null,paidMinor=sum_(db.LoanAllocations.filter(a=>a.loanId===loan.id&&Number(a.installmentNumber)===n&&a.status==='ACTIVE'&&db.LoanPayments.some(p=>p.id===a.loanPaymentId&&p.status==='CONFIRMED')),'amountMinor');rows.push({number:n,dueDate,amountMinor,paidMinor,remainingMinor:amountMinor===null?null:amountMinor-paidMinor,status:amountMinor===null?'Amount not set':paidMinor===amountMinor?'Paid':dueDate<today_(db)?'Past due':paidMinor?'Partially paid':dueDate===today_(db)?'Due today':'Upcoming'});}return rows;
}
function loanRecordIssues_(entity,r,db,add){
 if(entity==='Loans'){if(!Number.isInteger(Number(r.dueDay))||r.dueDay<1||r.dueDay>31)add('Monthly due day must be 1 to 31');if(!Number.isInteger(Number(r.termMonths))||r.termMonths<1||r.termMonths>600)add('Loan term must be 1 to 600 months');if(r.principalMinor!==''&&Number(r.principalMinor)<0)add('Original principal must not be negative');if(dateValid_(r.firstDueDate)&&Number(r.firstDueDate.slice(8))!==Math.min(Number(r.dueDay),new Date(Date.UTC(+r.firstDueDate.slice(0,4),+r.firstDueDate.slice(5,7),0)).getUTCDate()))add('First due date must match the monthly due day');}
 if(entity==='LoanSchedules'&&r.status==='ACTIVE'){if(Number(r.monthlyMinor)<=0)add('Monthly payment must be positive');if(r.endDate<r.startDate)add('Schedule end precedes its start');if(db.LoanSchedules.some(s=>s.id!==r.id&&s.loanId===r.loanId&&s.status==='ACTIVE'&&s.startDate<=r.endDate&&s.endDate>=r.startDate))add('Payment schedule periods overlap');}
 if(entity==='LoanPayments'&&Number(r.amountMinor)<=0)add('Payment must be positive');
 if(entity==='LoanAllocations'){if(Number(r.amountMinor)<=0)add('Allocation must be positive');const p=db.LoanPayments.find(p=>p.id===r.loanPaymentId),loan=db.Loans.find(l=>l.id===r.loanId);if(p&&p.loanId!==r.loanId)add('Payment belongs to another loan');if(!Number.isInteger(Number(r.installmentNumber))||r.installmentNumber<1||loan&&r.installmentNumber>loan.termMonths)add('Invalid installment number');}
}
function loanDashboard_(db,f){const loans=db.Loans.filter(l=>!f.loanId||l.id===f.loanId);return {loans:loans.map(l=>({...l,_token:token_(l),installments:loanInstallments_(db,l)})),schedules:db.LoanSchedules.filter(s=>!f.loanId||s.loanId===f.loanId).map(s=>({...s,_token:token_(s)})),payments:db.LoanPayments.filter(p=>!f.loanId||p.loanId===f.loanId).map(p=>({...p,_token:token_(p),allocations:db.LoanAllocations.filter(a=>a.loanPaymentId===p.id)}))};}
function billsLedgerAction_(entity,input,expectedToken,requestId){return guard_(()=>{
 if(!input||typeof input!=='object')fail_('VALIDATION: Provide record details.');const db=load_(),opId=validRequest_(requestId),kind=entity+'_'+hash_(JSON.stringify({input,expectedToken})),prior=db.Operations.find(o=>o.id===opId);if(prior){if(prior.kind!==kind||prior.state!=='DONE')fail_('CONFLICT: Retry the original operation.');return {replayed:true};}ensureRecovered_(db);const changes=[];
 if(entity==='Loans'||entity==='LoanSchedules'){const before=input.id?db[entity].find(r=>r.id===input.id):null;if(input.id&&(!before||token_(before)!==expectedToken))fail_('CONFLICT: Record changed.');const {initialMonthlyMinor,initialMonths,...record}=input;const after=prepare_(entity,record,before);loanRecordIssues_(entity,after,db,message=>fail_('VALIDATION: '+message));changes.push({entity,before,after});if(entity==='Loans'&&!before&&initialMonthlyMinor!==undefined){if(!Number.isSafeInteger(Number(initialMonthlyMinor))||initialMonthlyMinor<=0||!Number.isInteger(Number(initialMonths))||initialMonths<1||initialMonths>Number(after.termMonths))fail_('VALIDATION: Check fixed monthly amount and period.');const rows=loanInstallments_(db,after);changes.push({entity:'LoanSchedules',before:null,after:prepare_('LoanSchedules',{loanId:after.id,startDate:rows[0].dueDate,endDate:rows[Number(initialMonths)-1].dueDate,monthlyMinor:initialMonthlyMinor,status:'ACTIVE'},null)});}const next=domainClone_(db);next[entity]=next[entity].filter(r=>r.id!==after.id).concat(after);const loans=entity==='Loans'?[after]:next.Loans.filter(l=>l.id===after.loanId||l.id===before?.loanId);for(const loan of loans){const old=db.Loans.find(l=>l.id===loan.id);if(!old)continue;const previous=loanInstallments_(db,old),future=loanInstallments_(next,loan);for(const installment of previous.filter(i=>i.paidMinor>0)){const current=future.find(i=>i.number===installment.number);if(!current||current.dueDate!==installment.dueDate||current.amountMinor!==installment.amountMinor)fail_('VALIDATION: Schedule changes cannot alter installments with recorded payments.');}}}
 if(entity==='LoanPayment'){const loan=db.Loans.find(l=>l.id===input.loanId);if(!loan||loan.status==='ARCHIVED'||token_(loan)!==expectedToken)fail_('CONFLICT: Loan changed.');if(!Array.isArray(input.allocations)||!input.allocations.length||input.allocations.length>24)fail_('VALIDATION: Allocate the payment to 1 to 24 installments.');const amount=Number(input.amountMinor);if(!Number.isSafeInteger(amount)||amount<=0||input.allocations.reduce((s,a)=>s+Number(a.amountMinor),0)!==amount)fail_('VALIDATION: Allocations must equal the payment.');const schedule=loanInstallments_(db,loan),seen=new Set();for(const a of input.allocations){const i=schedule.find(i=>i.number===Number(a.number));if(!i||seen.has(i.number)||!Number.isSafeInteger(Number(a.amountMinor))||a.amountMinor<=0||i.remainingMinor===null||a.amountMinor>i.remainingMinor)fail_('VALIDATION: Choose distinct installments with known remaining amounts; allocate overpayments explicitly.');seen.add(i.number);}const payment=prepare_('LoanPayments',{loanId:loan.id,date:input.date,amountMinor:amount,currency:loan.currency,reference:input.reference||'',notes:input.notes||'',status:'CONFIRMED'},null);changes.push({entity:'LoanPayments',before:null,after:payment});for(const a of input.allocations)changes.push({entity:'LoanAllocations',before:null,after:prepare_('LoanAllocations',{loanId:loan.id,loanPaymentId:payment.id,installmentNumber:a.number,amountMinor:a.amountMinor,status:'ACTIVE'},null)});}
 if(entity==='ReverseLoanPayment'){const before=db.LoanPayments.find(p=>p.id===input.id);if(!before||token_(before)!==expectedToken||before.status!=='CONFIRMED')fail_('CONFLICT: Payment changed or already reversed.');changes.push({entity:'LoanPayments',before,after:prepare_('LoanPayments',{status:'REVERSED'},before)});for(const a of db.LoanAllocations.filter(a=>a.loanPaymentId===before.id&&a.status==='ACTIVE'))changes.push({entity:'LoanAllocations',before:a,after:prepare_('LoanAllocations',{status:'REVERSED'},a)});}
 if(entity==='ShareBatch'){const tx=db.Transactions.find(t=>t.id===input.transactionId);if(!tx||token_(tx)!==expectedToken)fail_('CONFLICT: Transaction changed.');if(!Array.isArray(input.items)||!input.items.length||input.items.length>30)fail_('VALIDATION: Provide 1 to 30 shares.');const seen=new Set();for(const item of input.items){if(item.id&&seen.has(item.id))fail_('VALIDATION: Duplicate share.');if(item.id)seen.add(item.id);const before=item.id?db.Shares.find(s=>s.id===item.id&&s.transactionId===tx.id):null;if(item.id&&(!before||token_(before)!==item.token))fail_('CONFLICT: A share changed.');if(before&&before.personId!==item.personId&&db.Repayments.some(r=>r.shareId===before.id&&r.status!=='REVERSED'))fail_('VALIDATION: Shares with repayments cannot be reassigned to another person.');changes.push({entity:'Shares',before,after:prepare_('Shares',{transactionId:tx.id,personId:item.personId,amountMinor:item.amountMinor,currency:tx.currency,status:'ACTIVE',requestStatus:before?.requestStatus||'NOT_REQUESTED',notes:before?.notes||''},before)});}}
 if(!changes.length)fail_('VALIDATION: No changes.');if(JSON.stringify(changes).length>44000)fail_('LIMIT: Save fewer items.');billsChanged_(db,changes,opId,kind);return {saved:true,id:changes[0].after.id};
},true);}
