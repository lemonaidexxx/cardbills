const CC_VERSION = 4;
let CC_BRIDGE_ACTOR = "";

let CC_CONTEXT = null;

let CC_LOCK_DEPTH = 0;

let CC_EDIT_ISSUES = [];

const CC_COMMON = ['id', 'revision', 'createdAt', 'updatedAt'];

const CC_SCHEMA = {

  Accounts: 'bank nickname currency status reviewStatus sharedLimitGroup',

  Cards: 'accountId product nickname lastFour cardholder relationship replacesCardId status',

  Transactions: 'accountId cardId statementId transactionDate postingDate dueDate originalDescription description amountMinor currency type category tags notes sourceKey sourceRef reviewStatus installmentPlanId installmentNumber status',

  Statements: 'accountId statementDate periodStart periodEnd dueDate balanceMinor minimumMinor currency status reconciliation calendarMode calendarId eventId syncedAt fingerprint syncError attempts nextRetry',

  BankPayments: 'accountId date amountMinor currency status reference notes matchedTransactionId',

  PaymentAllocations: 'paymentId statementId amountMinor status',

  People: 'name contact notes status',

  Shares: 'transactionId personId amountMinor currency requestStatus requestDate expectedDate notes status',

  Repayments: 'shareId date amountMinor currency type status reference notes',

  InstallmentPlans: 'accountId cardId originTransactionId reference startDate monthlyMinor currency count status notes',

  SavedViews: 'name scope filters sort status',

  Settings: 'key value',

  Labels: 'key value',

  ReportConfig: 'key value',

  SheetBaseline: 'entity recordId payload',

  ImportBatches: 'fingerprint state mappings validation selection progress expiresAt error startRow rowCount groups counts',

  ImportRows: 'batchId rowIndex source result digest',

  ImportHistory: 'sourceHash outcome accepted rejected suspect skipped summary',

  AuditHistory: 'actor action entity recordId summary correlationId',

  Operations: 'kind state payload error'

};

const CC_ENUMS = {

  'Accounts.status': ['ACTIVE','ARCHIVED'], 'Accounts.reviewStatus': ['REVIEW','VERIFIED'],

  'Cards.status': ['ACTIVE','ARCHIVED'], 'Cards.relationship': ['PRIMARY','SUPPLEMENTARY','REPLACEMENT','UNKNOWN'],

  'Transactions.type': ['PURCHASE','FEE','INTEREST','CASH_ADVANCE','BANK_PAYMENT','REFUND','REBATE','TRANSFER','ADJUSTMENT','INSTALLMENT','FINANCED_PRINCIPAL','UNKNOWN'],

  'Transactions.status': ['ACTIVE','VOID'], 'Transactions.reviewStatus': ['REVIEW','VERIFIED','DUPLICATE_CANDIDATE'],

  'Statements.status': ['OPEN','ARCHIVED'], 'Statements.reconciliation': ['UNVERIFIED','VERIFIED'],

  'Statements.calendarMode': ['OFF','ON','PAUSED'],

  'BankPayments.status': ['PENDING','CONFIRMED','REVERSED'], 'PaymentAllocations.status': ['ACTIVE','REVERSED'],

  'People.status': ['ACTIVE','ARCHIVED'], 'Shares.status': ['ACTIVE','VOID'],

  'Shares.requestStatus': ['NOT_REQUESTED','REQUESTED','DISPUTED'],

  'Repayments.type': ['CASH','REFUND_CREDIT','WAIVER','ADJUSTMENT'], 'Repayments.status': ['PENDING','CONFIRMED','REVERSED'],

  'InstallmentPlans.status': ['ACTIVE','COMPLETED','ARCHIVED'], 'SavedViews.status': ['ACTIVE','ARCHIVED'],

  'SavedViews.scope': ['Transactions','Shares','Statements','BankPayments','Repayments']

};

const CC_REQUIRED = {

  Accounts:'bank nickname currency status reviewStatus', Cards:'accountId nickname relationship status',

  Transactions:'accountId transactionDate description amountMinor currency type reviewStatus status',

  Statements:'accountId statementDate currency status reconciliation calendarMode',

  BankPayments:'accountId date amountMinor currency status', PaymentAllocations:'paymentId statementId amountMinor status',

  People:'name status', Shares:'transactionId personId amountMinor currency requestStatus status',

  Repayments:'shareId date amountMinor currency type status', InstallmentPlans:'accountId startDate currency count status',

  SavedViews:'name scope filters sort status', Settings:'key'

};

const CC_SETTINGS = {

  Timezone:'Asia/Manila', DefaultCurrency:'PHP', ReminderTime:'09:00', CalendarId:'', SyncEnabled:'false',

  ReminderMinutes:'1440,0', ShowAmounts:'false', IncludeHistorical:'false', BackupEnabled:'false', BackupDays:'7'

};

const CC_CURRENCY = {PHP:2,USD:2,EUR:2,GBP:2,CNY:2,HKD:2,SGD:2,AUD:2,CAD:2,JPY:0,KRW:0,TWD:2,THB:2,MYR:2,IDR:2,INR:2,AED:2,SAR:2,CHF:2,NZD:2,BHD:3,KWD:3};

const CC_INTERNAL = ['ImportHistory','AuditHistory','Operations','SheetBaseline','ImportBatches','ImportRows'];

const CC_TECH = ['calendarId','eventId','syncedAt','fingerprint','syncError','attempts','nextRetry','sourceKey','sourceRef'];

const CC_MAX_ROWS = 20000;

let CC_BOOK_CACHE = null;

function fail_(code) { throw new Error(code); }

function props_() { return PropertiesService.getScriptProperties(); }

function owner_() {

  const configured = String(props_().getProperty('OWNER_EMAIL') || '').trim().toLowerCase();

  const active = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();

  if (!configured) fail_('ACCESS_DENIED: Set OWNER_EMAIL in Apps Script Project Settings → Script Properties, then run setup again.');

  if (!active) fail_('ACCESS_DENIED: Google did not provide the signed-in user identity. Run setup from the Apps Script editor while signed into the owner account and authorize the project.');

  if (active !== configured) fail_('ACCESS_DENIED: The signed-in Google account does not match OWNER_EMAIL in Script Properties. Correct the property or switch accounts.');

  return active;

}

function guard_(fn, allowInvalid, previewOnly) {
  if (!CC_BRIDGE_ACTOR) owner_();

  return locked_(() => {

  CC_EDIT_ISSUES = [];

  if(!previewOnly&&props_().getProperty('SCHEMA_VERSION')===String(CC_VERSION)) reconcileSheetEdits_();

  if(CC_EDIT_ISSUES.length&&!allowInvalid) fail_('REVIEW: '+CC_EDIT_ISSUES[0].message);

  try { return fn(); } catch (e) {

    const message = String(e.message || '');

    if (/^(ACCESS_DENIED|VALIDATION|CONFLICT|SCHEMA|SETUP|BUSY|REVIEW|CALENDAR|IMPORT|RECOVERY|LIMIT):/.test(message)) throw e;

    fail_('REVIEW: Operation failed. Refresh diagnostics; private provider details were withheld.');

  }

  });

}

function doGet() { return ContentService.createTextOutput(JSON.stringify({service:'Cardbills'})).setMimeType(ContentService.MimeType.JSON); }

function include_(name) { if (!['Styles','Client'].includes(name)) fail_('VALIDATION: Invalid resource.'); return HtmlService.createHtmlOutputFromFile(name).getContent(); }



function apiIdentity() { return guard_(() => ({authorized:true, configured:!!props_().getProperty('SPREADSHEET_ID'), version:CC_VERSION})); }
function apiImportLookups() { return guard_(()=>{const db=load_();return lookups_({Accounts:db.Accounts,Cards:db.Cards,People:[],Transactions:[],Statements:[],BankPayments:[],Shares:[],InstallmentPlans:[]});},true,true); }
function apiResolveMissing(entity,id,mode,requestId) { return guard_(()=>{
  publicEntity_(entity);if(!['accept','restore'].includes(mode))fail_('VALIDATION: Choose accept or restore.');
  const db=load_(),opId=validRequest_(requestId);ensureRecovered_(db);
  if(db.Operations.some(o=>o.id===opId&&o.state==='DONE'))return {replayed:true};
  if(db[entity].some(r=>r.id===id))fail_('CONFLICT: Record exists again. Refresh Review.');
  const b=db.SheetBaseline.find(r=>r.entity===entity&&r.recordId===id);if(!b)fail_('CONFLICT: No saved history for this record.');
  const previous=JSON.parse(b.payload);delete previous._acceptedDeletion;
  if(mode==='restore'){commit_(db,[{entity,before:null,after:previous}],opId,'RESTORE_DELETED');return {restored:true};}
  const references={accountId:'Accounts',cardId:'Cards',statementId:'Statements',paymentId:'BankPayments',transactionId:'Transactions',personId:'People',shareId:'Shares',installmentPlanId:'InstallmentPlans',replacesCardId:'Cards',originTransactionId:'Transactions',matchedTransactionId:'Transactions'};
  const linked=Object.keys(CC_SCHEMA).filter(e=>!CC_INTERNAL.includes(e)).some(e=>db[e].some(r=>Object.entries(references).some(([k,target])=>target===entity&&r[k]===id)));
  if(linked)fail_('VALIDATION: Other records still reference this ID. Restore it, or reassign those records before accepting deletion.');
  const after=Object.assign({},b,{payload:JSON.stringify({...previous,_acceptedDeletion:true}),revision:Number(b.revision)+1,updatedAt:now_()});
  commit_(db,[{entity:'SheetBaseline',before:b,after}],opId,'ACCEPT_DELETED');return {accepted:true};
},true); }
function apiBootstrap(view) { return guard_(() => {

  const db = load_(); const issues = review_(db);

  return {version:CC_VERSION, today:today_(db), schema:CC_SCHEMA, enums:CC_ENUMS, required:CC_REQUIRED, currencies:CC_CURRENCY,

    configuration:configuration_(db), settings:clientSettings_(db), lookups:lookups_(db), overview:overview_(db,issues), issues:issues.slice(0,200), diagnostics:diagnostics_(db),currentPage:view&&view.entity?listView_(db,issues,view.entity,view.filters,view.page,view.sort):null};

}, true); }

function apiList(entity, filters, page, sort) { return guard_(() => {

  publicEntity_(entity); const db=load_(); const issues=review_(db);

  return listView_(db,issues,entity,filters,page,sort);
}, true); }
function listView_(db,issues,entity,filters,page,sort){
  publicEntity_(entity);
  const rows=filtered_(entity,db,filters||{},sort||'updatedAt:desc');

  const p=Math.max(0,Math.floor(Number(page)||0));

  return {rows:rows.slice(p*40,p*40+40),total:rows.length,page:p,issues:issues.filter(x=>x.entity===entity).slice(0,100),summary:entity==='Shares'&&!issues.some(x=>x.severity==='ERROR')?collectionSummary_(rows):null};

}

function apiSave(entity, record, expectedToken, requestId) { return guard_(() => locked_(() => {

  publicEntity_(entity); if (entity==='Settings') fail_('VALIDATION: Use settings controls.');

  const db=load_(); ensureRecovered_(db);

  const opId=validRequest_(requestId); const prior=db.Operations.find(x=>x.id===opId);

  if(prior) { if(prior.state!=='DONE') fail_('RECOVERY: Resume pending operation first.'); return {id:JSON.parse(prior.payload)[0].after.id,replayed:true}; }

  const before=record.id ? db[entity].find(x=>x.id===record.id):null;

  if(record.id&&!before) fail_('CONFLICT: Record no longer exists.');

  if(before && token_(before)!==expectedToken) fail_('CONFLICT: Record changed. Refresh before saving.');

  const after=prepare_(entity,record,before);

  const next=domainClone_(db); next[entity]=next[entity].filter(x=>x.id!==after.id).concat(after);

  const oldIssues=review_(db), newIssues=review_(next);

  const oldKeys=new Set(oldIssues.map(issueKey_));

  if(newIssues.some(x=>x.entity===entity&&x.id===after.id&&x.severity==='ERROR') || newIssues.some(x=>x.severity==='ERROR'&&!oldKeys.has(issueKey_(x)))) fail_('VALIDATION: Change violates a field, relationship, or allocation rule. See Review and field guidance.');

  immutableLedger_(entity,before,after);

  commit_(db,[{entity,before,after}],opId,'SAVE');

  props_().setProperty('SYNC_DIRTY','true');

  return {id:after.id};

})); }

function apiReport(filters, fields) { return guard_(() => {

  const db=load_(); if(review_(db).some(x=>x.severity==='ERROR')) fail_('REVIEW: Repair invalid records before exporting financial totals.');

  const config=configuration_(db).report;

  const allowed=config.fields;

  filters=Object.assign({},config.filters,filters||{});

  if(!Array.isArray(fields)||!fields.length||fields.some(x=>!allowed.includes(x))) fail_('VALIDATION: Choose supported report fields.');

  const rows=filtered_('Shares',db,filters||{},'expectedDate:asc');

  if(rows.length>2000) fail_('LIMIT: Narrow report to 2,000 shares.');

  const people=new Set(rows.map(x=>x.personId));

  if(people.size>1) fail_('VALIDATION: Filter to one person before sharing a report.');

  return {title:config.title,generatedAt:now_(),snapshot:true,fields,rows:rows.map(s=>{

    const t=db.Transactions.find(x=>x.id===s.transactionId)||{};

    const safe={date:t.transactionDate,description:t.description,assigned:formatMoney_(s.amountMinor,s.currency),cashReceived:formatMoney_(s.cashMinor,s.currency),credits:formatMoney_(s.creditMinor,s.currency),remaining:formatMoney_(s.remainingMinor,s.currency),currency:s.currency,requestStatus:s.requestStatus,expectedDate:s.expectedDate};

    return fields.reduce((o,k)=>(o[k]=safe[k]||'',o),{});

  })};

}); }

function columns_(entity) { return CC_COMMON.concat(CC_SCHEMA[entity].split(' ')); }

function book_() { const id=props_().getProperty('SPREADSHEET_ID'); if(!id) fail_('SETUP: Set SPREADSHEET_ID in Script Properties.'); if(!CC_BOOK_CACHE||CC_BOOK_CACHE.getId()!==id)CC_BOOK_CACHE=SpreadsheetApp.openById(id);return CC_BOOK_CACHE; }

function now_() { return new Date().toISOString(); }

function id_() { return Utilities.getUuid(); }

function domainClone_(db){return Object.fromEntries(Object.keys(CC_SCHEMA).map(e=>[e,['ImportRows','ImportBatches'].includes(e)?[]:clone_(db[e])]));}

function clone_(x) { return JSON.parse(JSON.stringify(x)); }

function hash_(x) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(x),Utilities.Charset.UTF_8).map(b=>('0'+((b+256)%256).toString(16)).slice(-2)).join(''); }

function recordText_(r) { const c={}; Object.keys(r).sort().filter(k=>!k.startsWith('_')).forEach(k=>c[k]=r[k]); return JSON.stringify(c); }

function token_(r) { return hash_(recordText_(r)); }

function cellRead_(v,entity,column,tz) {

  if(v instanceof Date) return entity==='Settings'&&column==='value'?v:Utilities.formatDate(v,tz,/Date$|^date$|periodStart|periodEnd|startDate/.test(column)?'yyyy-MM-dd':"yyyy-MM-dd'T'HH:mm:ssXXX");

  return v;

}

function comparable_(v) {return v instanceof Date?v.toISOString():String(v===undefined?'':v);}

function locked_(fn) { if(CC_LOCK_DEPTH)return fn(); const l=LockService.getScriptLock(); if(!l.tryLock(20000)) fail_('BUSY: Another operation is running. Retry shortly.'); try{CC_LOCK_DEPTH++;CC_CONTEXT={tables:{},sheets:{}};return fn();}finally{CC_CONTEXT=null;CC_LOCK_DEPTH--;l.releaseLock();} }

function publicEntity_(e) { if(!Object.prototype.hasOwnProperty.call(CC_SCHEMA,e)||CC_INTERNAL.includes(e)) fail_('VALIDATION: Unsupported table.'); }

function sheet_(entity) {

  if(CC_CONTEXT&&CC_CONTEXT.sheets[entity])return CC_CONTEXT.sheets[entity];

  const sh=book_().getSheetByName('CC_'+entity); if(!sh) fail_('SCHEMA: Missing application table. Run migrateSchema.');

  const actual=sh.getRange(1,1,1,Math.max(sh.getLastColumn(),1)).getValues()[0];

  const required=columns_(entity);

  if(required.some((c,i)=>actual[i]!==c)||new Set(actual).size!==actual.length) fail_('SCHEMA: Unexpected column order or duplicate header. Restore documented schema; custom columns may only be appended.');

  if(CC_CONTEXT)CC_CONTEXT.sheets[entity]=sh;return sh;

}

function table_(entity) {

  if(CC_CONTEXT&&CC_CONTEXT.tables[entity])return CC_CONTEXT.tables[entity];

  const sh=sheet_(entity),cols=columns_(entity),count=Math.max(0,sh.getLastRow()-1);

  if(count>(CC_INTERNAL.includes(entity)?100000:CC_MAX_ROWS))fail_('LIMIT: Table row limit reached. Archive records before continuing.');

  const values=count?sh.getRange(2,1,count,cols.length).getValues():[];

  const formulas=count?sh.getRange(2,1,count,cols.length).getFormulas():[];

  const records=[],byId=new Map();const tz=props_().getProperty('DATA_TIMEZONE')||'Asia/Manila';

  values.forEach((row,i)=>{if(!row.some(v=>v!==''))return;const record=Object.fromEntries(cols.map((c,j)=>[c,cellRead_(row[j],entity,c,tz)]));

    const fs=cols.filter((c,j)=>formulas[i][j]);if(fs.length)record._formulaFields=fs;

    records.push(record);const list=byId.get(record.id)||[];list.push({record,row:i+2});byId.set(record.id,list);

  });

  const result={sh,cols,records,byId,lastRow:count+1};if(CC_CONTEXT)CC_CONTEXT.tables[entity]=result;return result;

}

function load_() {

  if(props_().getProperty('SCHEMA_VERSION')!==String(CC_VERSION))fail_('SCHEMA: Run migrateSchema before using this version.');

  const db={},local={};Object.keys(CC_SCHEMA).forEach(e=>Object.defineProperty(db,e,{enumerable:true,get:()=>{

    if(CC_CONTEXT)return table_(e).records;

    return local[e]||(local[e]=table_(e).records);

  }}));return db;

}

function rememberRow_(t,row,record){

  const old=t.byId.get(record.id)||[];

  if(old.length){const i=t.records.indexOf(old[0].record);if(i>=0)t.records[i]=record;}else t.records.push(record);

  t.byId.set(record.id,[{row,record}]);t.lastRow=Math.max(t.lastRow,row);

}

function room_(sh,lastRow){if(lastRow>sh.getMaxRows())sh.insertRowsAfter(sh.getMaxRows(),lastRow-sh.getMaxRows());}

function sheetValue_(v) { if(v===null||v===undefined)return ''; if(typeof v==='string'&&/^[\s]*[=+\-@]/.test(v))return "'"+v; return v; }

function write_(entity,before,after) {

  const technicalWrite=entity==='Statements'&&before&&Object.keys(after).filter(k=>before[k]!==after[k]).every(k=>CC_COMMON.concat(CC_TECH).includes(k));

  if(technicalWrite)props_().setProperty('CC_WRITE_'+after.id,'pending');

  const t=table_(entity),matches=t.byId.get(after.id)||[];

  if(matches.length>1)fail_('CONFLICT: Duplicate stable ID.');

  let row;

  if(!before){

    if(matches.length){if(token_(matches[0].record)===token_(after)){if(!CC_INTERNAL.includes(entity))saveBaseline_(entity,after);return;}fail_('CONFLICT: Record ID already exists with different content.');}

    if(t.sh.getLastRow()!==t.lastRow)fail_('CONFLICT: Sheet rows changed during append. Refresh.');

    row=t.lastRow+1;room_(t.sh,row);t.sh.getRange(row,1,1,t.cols.length).setValues([t.cols.map(c=>sheetValue_(after[c]))]);

  }else{

    if(!matches.length)fail_('CONFLICT: Record missing.');row=matches[0].row;

    const current=t.sh.getRange(row,1,1,t.cols.length).getValues()[0];

    if(current[0]!==after.id)fail_('CONFLICT: Sheet rows moved during the operation. Refresh.');

    const changed=t.cols.map((c,i)=>({c,i})).filter(({c})=>comparable_(before[c])!==comparable_(after[c]));

    changed.forEach(({c,i})=>{const v=cellRead_(current[i],entity,c,props_().getProperty('DATA_TIMEZONE')||'Asia/Manila');if(comparable_(v)!==comparable_(before[c])&&comparable_(v)!==comparable_(after[c]))fail_('CONFLICT: Sheet changed during update. Review pending operation.');});

    const runs=[];changed.forEach(x=>{let run=runs[runs.length-1];if(!run||run[run.length-1].i+1!==x.i)runs.push(run=[]);run.push(x);});

    runs.forEach(run=>t.sh.getRange(row,run[0].i+1,1,run.length).setValues([run.map(({c})=>sheetValue_(after[c]))]));

  }

  rememberRow_(t,row,after);

  if(!CC_INTERNAL.includes(entity))saveBaseline_(entity,after);

  if(technicalWrite)props_().deleteProperty('CC_WRITE_'+after.id);

}

function baselineChange_(entity,row){

  const id='base-'+hash_(entity+'|'+row.id),found=table_('SheetBaseline').byId.get(id),before=found&&found[0].record;

  const payload=JSON.stringify(Object.fromEntries(columns_(entity).map(k=>[k,row[k]===undefined?'':row[k]])));

  if(payload.length>44000)fail_('LIMIT: Row is too large for recoverable history.');

  if(before&&before.payload===payload)return null;

  return {entity:'SheetBaseline',before:before||null,after:Object.assign({},before||meta_({},id),{entity,recordId:row.id,payload})};

}

function saveBaseline_(entity,row){if(!book_().getSheetByName('CC_SheetBaseline'))return;const c=baselineChange_(entity,row);if(c)write_(c.entity,c.before,c.after);}

function groupedChanges_(changes){

  const groups=new Map();changes.forEach(c=>{const g=groups.get(c.entity)||[];g.push(c);groups.set(c.entity,g);});

  const baselines=[];

  groups.forEach((items,entity)=>{

    const t=table_(entity),pending=[];

    items.forEach(c=>{

      const found=t.byId.get(c.after.id)||[];if(found.length>1)fail_('CONFLICT: Duplicate stable ID.');

      if(c.partial){if(!found.length)fail_('RECOVERY: Batch record missing.');const current=found[0].record;write_(entity,Object.assign({},current,c.before),Object.assign({},current,c.after));return;}

      if(c.before){write_(entity,c.before,c.after);return;}

      if(found.length){

        if(t.cols.some(k=>found[0].record[k]!==''&&comparable_(found[0].record[k])!==comparable_(c.after[k])))fail_('CONFLICT: Recovery row differs from the journal.');

        if(token_(found[0].record)!==token_(c.after))write_(entity,found[0].record,c.after);

      }else pending.push(c.after);

      if(!CC_INTERNAL.includes(entity)){const baseline=baselineChange_(entity,c.after);if(baseline)baselines.push(baseline);}

    });

    if(pending.length){

      if(t.sh.getLastRow()!==t.lastRow)fail_('CONFLICT: Sheet rows changed during grouped append. Refresh.');

      const start=t.lastRow+1;room_(t.sh,start+pending.length-1);

      t.sh.getRange(start,1,pending.length,t.cols.length).setValues(pending.map(r=>t.cols.map(c=>sheetValue_(r[c]))));

      pending.forEach((r,i)=>rememberRow_(t,start+i,r));

    }

  });

  if(baselines.length)groupedChanges_(baselines);

}

function meta_(fields,id) { const n=now_(); return Object.assign({id:id||id_(),revision:1,createdAt:n,updatedAt:n},fields); }

const CC_REPORT_FIELDS = ['date','description','assigned','cashReceived','credits','remaining','currency','requestStatus','expectedDate'];

function seedConfiguration_() {

  const db=load_();

  const defaults={Labels:{'app.title':'Cardbills','app.subtitle':'Statements, payments and collections','button.Refresh data':'Refresh data'},ReportConfig:{title:'Repayment snapshot',fields:CC_REPORT_FIELDS.join(','),filters:'{}'}};

  ['Overview','Transactions','Cards and Accounts','Statements','Bank Payments','Money Owed','People','Repayments','Installments','Saved Views','Review','Settings and Integration','Configuration'].forEach(k=>defaults.Labels['nav.'+k]=k);

  ['+ Add new card…','+ Create new account…','Save and select card','Cancel','Save record','Edit record','Preview report','Generate preview','Download HTML report','Refresh import preview','Import selected rows','Save settings','Test Calendar','Preview synchronization','Synchronize now','Install / repair triggers','Stop automation','Repair reminder time','Create private backup','Select or create calendar','Previous','Next'].forEach(k=>defaults.Labels['button.'+k]=k);

  Object.entries({accountNickname:'Account nickname',description:'Description',nickname:'Nickname',name:'Name',amountMinor:'Amount',balanceMinor:'Official balance',minimumMinor:'Minimum due',monthlyMinor:'Monthly amount',lastFour:'Last four digits',currency:'Currency',category:'Category',tags:'Tags',requestStatus:'Request status',remainingMinor:'Remaining'}).forEach(([k,v])=>defaults.Labels['field.'+k]=v);

  Object.keys(defaults).forEach(e=>Object.keys(defaults[e]).forEach(key=>{

    if(!db[e].some(r=>r.key===key))write_(e,null,meta_({key,value:defaults[e][key]}));

  }));

}

function configuration_(db) {

  const labels={},report={title:'Repayment snapshot',fields:CC_REPORT_FIELDS.slice(),filters:{}};

  ['Labels','ReportConfig'].forEach(e=>{

    const seen=new Set();db[e].forEach(r=>{

      if(typeof r.key!=='string'||!r.key||seen.has(r.key)||typeof r.value!=='string'||r.value.length>3000)fail_('VALIDATION: Invalid or duplicate configuration key in CC_'+e);

      seen.add(r.key);

      if(e==='Labels'){

        if(!/^(app\.(title|subtitle)|nav\..+|field\..+|button\..+)$/.test(r.key))fail_('VALIDATION: Use app.title, app.subtitle, nav.*, field.* or button.* in CC_Labels.');

        labels[r.key]=r.value;

      }else{

        if(!['title','fields','filters'].includes(r.key))fail_('VALIDATION: Unknown report configuration key.');

        if(r.key==='title')report.title=r.value;

        if(r.key==='fields'){

          const fields=r.value.split(',').map(x=>x.trim());

          if(!fields.length||new Set(fields).size!==fields.length||fields.some(f=>!CC_REPORT_FIELDS.includes(f)))fail_('VALIDATION: Unsupported report column.');

          report.fields=fields;

        }

        if(r.key==='filters'){

          let value;try{value=JSON.parse(r.value);}catch(_){fail_('VALIDATION: Report filters must be JSON.');}

          if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!['personId','status','requestStatus','q','from','to','dateBasis'].includes(k))||Object.values(value).some(v=>typeof v!=='string'))fail_('VALIDATION: Unsupported report filter.');

          report.filters=value;

        }

      }

    });

  });return {labels,report};

}

function captureBaselines_(db){Object.keys(CC_SCHEMA).filter(e=>!CC_INTERNAL.includes(e)).forEach(e=>db[e].forEach(r=>{if(!db.SheetBaseline.some(b=>b.entity===e&&b.recordId===r.id))saveBaseline_(e,r);}));}

function reconcileSheetEdits_() {

  CC_EDIT_ISSUES=[];

  const db=load_(),changes=[],properties=props_().getProperties();

  const recordIndex=new Map(),baselineIndex=new Map(),pendingRows=new Set();

  Object.keys(CC_SCHEMA).filter(e=>!CC_INTERNAL.includes(e)).forEach(e=>db[e].forEach(r=>recordIndex.set(e+'|'+r.id,r)));

  db.SheetBaseline.forEach(b=>baselineIndex.set(b.entity+'|'+b.recordId,b));

  db.Operations.filter(op=>op.state!=='DONE'&&op.state!=='CANCELLED'&&op.kind!=='CALENDAR_MIGRATION').forEach(op=>JSON.parse(op.payload).forEach(c=>pendingRows.add(c.entity+'|'+c.after.id)));

  const issue=(entity,id,message)=>CC_EDIT_ISSUES.push({entity,id,message,severity:'ERROR'});

  db.SheetBaseline.forEach(b=>{

    const row=recordIndex.get(b.entity+'|'+b.recordId);

    if(!row&&!JSON.parse(b.payload)._acceptedDeletion)issue(b.entity,b.recordId,'A tracked row was removed or its ID changed. Restore it in Sheets; use status or reversal for removal.');
  });

  Object.keys(CC_SCHEMA).filter(e=>!CC_INTERNAL.includes(e)).forEach(entity=>db[entity].forEach(row=>{

    if(entity==='Statements'&&properties['CC_WRITE_'+row.id])return;

    if(pendingRows.has(entity+'|'+row.id))return;

    const baseline=baselineIndex.get(entity+'|'+row.id);

    const old=baseline?JSON.parse(baseline.payload):null;

    if(old&&recordText_(old)===recordText_(row)){if(old._acceptedDeletion)saveBaseline_(entity,row);return;}
    try{

      if(!row.id)fail_('VALIDATION: New rows require a stable ID. Create rows through the dashboard or spreadsheet menu.');

      if(old){

        if(CC_COMMON.concat(CC_TECH).some(k=>comparable_(row[k])!==comparable_(old[k])))fail_('VALIDATION: Restore edited technical metadata.');

        immutableLedger_(entity,old,row);

        if(entity==='Settings'&&row.key==='CalendarId'&&row.value!==old.value)fail_('VALIDATION: Change Calendar through the migration preview in the dashboard or spreadsheet menu.');

      }

      changes.push({entity,before:row,sourceBefore:old,after:Object.assign({},row,{revision:old?Number(old.revision)+1:1,updatedAt:now_()})});

    }catch(e){issue(entity,row.id,String(e.message));}

  }));

  if(!changes.length)return;

  try{configuration_(db);}catch(e){issue('Labels','',String(e.message));}

  const errors=review_(db).filter(x=>x.severity==='ERROR');

  if(errors.length){errors.forEach(x=>{if(!CC_EDIT_ISSUES.some(y=>y.entity===x.entity&&y.id===x.id&&y.message===x.message))CC_EDIT_ISSUES.push(x);});return;}

  ensureRecovered_(db);

  changes.forEach(c=>commit_(db,[c],id_(),'SHEET_EDIT'));

  props_().setProperty('DATA_TIMEZONE',settings_(load_()).Timezone);

  props_().setProperty('SYNC_DIRTY','true');

}

function configureInstaller_(){

  const active=String(Session.getActiveUser().getEmail()||'').trim().toLowerCase();

  if(!active)fail_('ACCESS_DENIED: Run in the Apps Script editor and authorize your account.');

  if(!props_().getProperty('OWNER_EMAIL'))props_().setProperty('OWNER_EMAIL',active);

  owner_();

  if(!props_().getProperty('SPREADSHEET_ID')){

    const sheet=SpreadsheetApp.getActiveSpreadsheet();

    if(!sheet)fail_('SETUP: Set SPREADSHEET_ID in Script Properties or use a spreadsheet-bound project.');

    props_().setProperty('SPREADSHEET_ID',sheet.getId());

  }

  return setup();

}

function installerDiagnostic_(){

  const result={missingProperties:[],missingTables:[],invalidTables:[],schemaVersion:props_().getProperty('SCHEMA_VERSION')||'unset'};

  ['OWNER_EMAIL','SPREADSHEET_ID'].forEach(k=>{if(!props_().getProperty(k))result.missingProperties.push(k);});

  if(!result.missingProperties.includes('SPREADSHEET_ID'))try{

    Object.keys(CC_SCHEMA).forEach(e=>{if(!book_().getSheetByName('CC_'+e))result.missingTables.push('CC_'+e);else try{sheet_(e);}catch(_){result.invalidTables.push('CC_'+e);}});

  }catch(_){result.spreadsheetError='Cannot open configured spreadsheet. Check ID and installer access.';}

  console.log(JSON.stringify(result));return result;

}

function onOpen(){

  SpreadsheetApp.getUi().createMenu('Card workspace')

    .addItem('Open / edit records','menuWorkspace_').addItem('Validate / refresh','menuReview_')

    .addItem('Report preview','menuReport_').addItem('Import transactions','menuImport_')

    .addItem('Names and report configuration','menuConfiguration_')

    .addItem('Settings, backups and Calendar','menuSettings_').addToUi();

}

function openWorkspaceDialog_(action){owner_();const t=HtmlService.createTemplateFromFile('Index');t.viewClient='Client';t.viewAction=action;SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(1200).setHeight(850),'Card workspace');}

function menuWorkspace_(){openWorkspaceDialog_('records');}

function menuReview_(){openWorkspaceDialog_('review');}

function menuReport_(){openWorkspaceDialog_('report');}

function menuImport_(){openWorkspaceDialog_('import');}

function menuConfiguration_(){openWorkspaceDialog_('configuration');}

function menuSettings_(){openWorkspaceDialog_('settings');}

function validRequest_(s) { if(typeof s!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(s)) fail_('VALIDATION: Missing operation identifier.'); return s; }

function ensureRecovered_(db) { if(db.Operations.some(x=>x.state!=='DONE'&&x.state!=='CANCELLED'))fail_('RECOVERY: Resolve pending operation in Settings before making further changes.'); }

function commit_(db,changes,opId,kind) {

  const payload=JSON.stringify(changes); if(payload.length>44000)fail_('LIMIT: Operation too large; use a smaller import batch.');

  const op=meta_({kind,state:'PENDING',payload,error:''},opId); write_('Operations',null,op);

  applyOperation_(op);

}

function applyOperation_(op) {

  try {

    groupedChanges_(JSON.parse(op.payload));

    const audits=JSON.parse(op.payload).filter(c=>!CC_INTERNAL.includes(c.entity)).map((c,i)=>{

      const audit=meta_({actor:CC_BRIDGE_ACTOR||Session.getActiveUser().getEmail()||'owner-automation',action:op.kind,entity:c.entity,recordId:c.after.id,summary:'Updated fields: '+Object.keys(c.after).filter(k=>!CC_COMMON.includes(k)&&(!c.before||c.before[k]!==c.after[k])).join(', '),correlationId:op.id},'audit-'+op.id+'-'+i);

      audit.createdAt=op.createdAt; audit.updatedAt=op.createdAt;return {entity:'AuditHistory',before:null,after:audit};

    });

    groupedChanges_(audits);

    write_('Operations',op,Object.assign({},op,{state:'DONE',error:''}));

  }catch(e){fail_('RECOVERY: Operation is pending. Resume it in Settings; do not re-enter the same financial change.');}

}

function apiRecover(operationId) { return guard_(()=>locked_(()=>{

  const db=load_(), op=db.Operations.find(x=>x.id===operationId);

  if(!op||op.state==='DONE')return {done:true};

  if(op.kind==='CALENDAR_MIGRATION')return migrateCalendarApply_(op,db);

  applyOperation_(op); return {done:true};

})); }

function setup() { owner_(); return locked_(()=>setup_()); }

function migrateSchema() { return setup(); }

function setup_() {

  const b=book_(), version=Number(props_().getProperty('SCHEMA_VERSION')||0);
  if (!version) b.setSpreadsheetTimeZone('Asia/Manila');

  if(version>CC_VERSION)fail_('SCHEMA: Installed schema is newer than this code.');

  Object.keys(CC_SCHEMA).forEach(e=>{if(b.getSheetByName('CC_'+e))sheet_(e);});

  Object.keys(CC_SCHEMA).forEach(e=>{

    if(b.getSheetByName('CC_'+e))return;

    const sh=b.insertSheet('CC_'+e),cols=columns_(e);

    sh.getRange(1,1,1,cols.length).setValues([cols]).setFontWeight('bold').setBackground('#e8e2f8'); sh.setFrozenRows(1);

    cols.forEach((c,i)=>{

      if(!/Minor$|^revision$|^count$|^installmentNumber$|^attempts$/.test(c))sh.getRange(2,i+1,sh.getMaxRows()-1,1).setNumberFormat('@');

      if(CC_COMMON.includes(c)||CC_TECH.includes(c)||CC_INTERNAL.includes(e))sh.getRange(1,i+1,sh.getMaxRows(),1).protect().setDescription('Technical column: edit through application').setWarningOnly(true);

      if(CC_ENUMS[e+'.'+c])sh.getRange(2,i+1,sh.getMaxRows()-1,1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(CC_ENUMS[e+'.'+c],true).setAllowInvalid(false).build());

    });

  });

  props_().setProperty('SCHEMA_VERSION',String(CC_VERSION));

  const db=load_(); Object.keys(CC_SETTINGS).forEach(key=>{

    if(!db.Settings.some(x=>x.key===key))write_('Settings',null,meta_({key,value:CC_SETTINGS[key]}));

  });

  props_().setProperty('DATA_TIMEZONE',settings_(load_()).Timezone);

  seedConfiguration_();

  captureBaselines_(load_());

  return {version:CC_VERSION,emptyTablesCreated:true};

}

function minor_(text,currency) {

  const p=CC_CURRENCY[currency]; if(p===undefined)fail_('VALIDATION: Unsupported or unconfirmed currency.');

  const s=String(text).trim(); if(!/^-?\d+(\.\d+)?$/.test(s))fail_('VALIDATION: Enter a decimal amount without separators.');

  const parts=s.replace('-','').split('.'); if((parts[1]||'').length>p)fail_('VALIDATION: Too many decimal places for currency.');

  const n=Number(parts[0])*Math.pow(10,p)+Number(((parts[1]||'')+'0'.repeat(p)).slice(0,p)||0);

  if(!Number.isSafeInteger(n)||n>1e12)fail_('VALIDATION: Amount exceeds supported precision.'); return s[0]==='-'?-n:n;

}

function formatMoney_(n,c) { if(n===''||n===null||n===undefined)return 'Unknown'; return (Number(n)/Math.pow(10,CC_CURRENCY[c]||0)).toFixed(CC_CURRENCY[c]||0); }

function addMinor_(a,b) {const n=Number(a)+Number(b);if(!Number.isSafeInteger(n))fail_('VALIDATION: Total exceeds safe integer range.');return n;}

function sum_(rows,key) {return rows.reduce((s,r)=>addMinor_(s,Number(r[key]||0)),0);}

function dateValid_(v) { if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false; const d=new Date(v+'T00:00:00Z');return !isNaN(d)&&d.toISOString().slice(0,10)===v; }

function normalizeTime_(value,tz) {

  if(value instanceof Date){if(isNaN(value))fail_('VALIDATION: Invalid reminder time.');return Utilities.formatDate(value,tz,'HH:mm');}

  if(typeof value==='number') {if(!isFinite(value)||value<0||value>=1)fail_('VALIDATION: Time fraction must be between zero and one.');const m=Math.round(value*1440);if(m>=1440)fail_('VALIDATION: Time rounds into next day.');return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');}

  const m=String(value).trim().match(/^(\d{1,2}):(\d{2})(?:\s*([ap]m))?$/i);

  if(!m)fail_('VALIDATION: Use HH:mm or h:mm AM/PM.');let h=Number(m[1]),min=Number(m[2]);

  if(min>59 || (m[3]?(h<1||h>12):h>23))fail_('VALIDATION: Invalid reminder time.');

  if(m[3])h=h%12+(m[3].toLowerCase()==='pm'?12:0);return String(h).padStart(2,'0')+':'+m[2];

}

function prepare_(entity,record,before) {

  const cols=columns_(entity); const r=before?clone_(before):meta_({});

  cols.forEach(c=>{if(r[c]===undefined)r[c]='';});

  Object.keys(record).forEach(c=>{

    if(c==='id'||c.startsWith('_'))return;

    if(!cols.includes(c)||CC_COMMON.includes(c)||CC_TECH.includes(c))fail_('VALIDATION: Protected or unknown field.');

    let v=record[c];if(v===null)v='';

    if(typeof v!=='string'&&typeof v!=='number')fail_('VALIDATION: Field must be text or number.');

    if(String(v).length>3000)fail_('VALIDATION: Field is too long.');

    if(/Minor$|^count$|^installmentNumber$/.test(c)&&v!=='')v=Number(v);

    r[c]=v;

  });

  r.revision=Number(r.revision||0)+(before?1:0); r.updatedAt=now_(); return r;

}

function immutableLedger_(e,b,a) {

  if(!b)return;

  if(['BankPayments','Repayments'].includes(e)&&['CONFIRMED','REVERSED'].includes(b.status)){

    if(columns_(e).some(k=>!['revision','updatedAt','notes','status'].includes(k)&&b[k]!==a[k])||b.status==='REVERSED'&&a.status!=='REVERSED'||a.status==='PENDING')fail_('VALIDATION: Confirmed ledger entries are immutable. Reverse and create a correction.');

  }

  if(e==='PaymentAllocations'&&columns_(e).some(k=>!['revision','updatedAt','status'].includes(k)&&b[k]!==a[k]))fail_('VALIDATION: Reverse allocation and create a correction.');

  if(e==='PaymentAllocations'&&b.status==='REVERSED'&&a.status!=='REVERSED')fail_('VALIDATION: A reversed allocation cannot be reactivated.');

}

function issueKey_(x) { return x.entity+'|'+x.id+'|'+x.message; }

function review_(db) {

  const out=CC_EDIT_ISSUES.slice();try{configuration_(db);}catch(e){out.push({entity:'Labels',id:'',message:String(e.message),severity:'ERROR'});}const add=(e,r,message,severity)=>out.push({entity:e,id:r.id||'',message,severity:severity||'ERROR'});

  const checkedSum=(rows,e,r)=>{try{return sum_(rows,'amountMinor');}catch(_){add(e,r,'Invalid or excessive linked amounts');return 0;}};

  const indexes=new Map();const find=(e,id)=>{if(!indexes.has(e))indexes.set(e,new Map(db[e].map(r=>[r.id,r])));return indexes.get(e).get(id);};

  Object.keys(CC_SCHEMA).filter(e=>!CC_INTERNAL.includes(e)).forEach(e=>{

    const ids=new Set(); db[e].forEach(r=>{

      if(!r.id||ids.has(r.id))add(e,r,'Missing or duplicate stable ID');ids.add(r.id);

      if(r._formulaFields&&r._formulaFields.length)add(e,r,'Formula found in a data field; replace with a literal value');

      if(!Number.isInteger(Number(r.revision))||Number(r.revision)<1)add(e,r,'Invalid revision');

      (CC_REQUIRED[e]||'').split(' ').filter(Boolean).forEach(k=>{if(r[k]===''||r[k]===undefined)add(e,r,'Required field: '+k);});

      columns_(e).forEach(k=>{

        const v=r[k]; if(v===''||v===undefined)return;

        if(CC_ENUMS[e+'.'+k]&&!CC_ENUMS[e+'.'+k].includes(v))add(e,r,'Invalid status or choice: '+k);

        if(/Minor$/.test(k)&&(!Number.isSafeInteger(Number(v))||Math.abs(Number(v))>1e12))add(e,r,'Invalid minor-unit amount: '+k);

        if(/Date$|^date$|^periodStart$|^periodEnd$/.test(k)&&!dateValid_(v))add(e,r,'Invalid local date: '+k);

      });

      if(r.currency&&CC_CURRENCY[r.currency]===undefined)add(e,r,'Unconfirmed or unsupported currency');

      if(r.lastFour&&!/^\d{4}$/.test(String(r.lastFour)))add(e,r,'Use exactly four card digits');

      if(e!=='Settings'&&Object.values(r).some(v=>typeof v==='string'&&/(?:\d[ -]?){13,19}/.test(v)&&!/^\d{4}-\d{2}-\d{2}T/.test(v)&&!/[a-f]/i.test(v)))add(e,r,'Possible full card number: remove sensitive digits');

      const refs={accountId:'Accounts',cardId:'Cards',statementId:'Statements',paymentId:'BankPayments',transactionId:'Transactions',personId:'People',shareId:'Shares',installmentPlanId:'InstallmentPlans',replacesCardId:'Cards',originTransactionId:'Transactions',matchedTransactionId:'Transactions'};

      Object.keys(refs).forEach(k=>{if(r[k]&&!find(refs[k],r[k]))add(e,r,'Missing reference: '+k);});

      ['accountId','cardId','statementId','transactionId','shareId','installmentPlanId','originTransactionId'].forEach(k=>{

        const parent=r[k]&&find(refs[k],r[k]);if(!parent)return;

        if(r.currency&&parent.currency&&r.currency!==parent.currency)add(e,r,'Currency mismatch: '+k);

        if(r.accountId&&parent.accountId&&r.accountId!==parent.accountId)add(e,r,'Account mismatch: '+k);

      });

      if(r.periodStart&&r.periodEnd&&r.periodStart>r.periodEnd)add(e,r,'Statement period is reversed');

      if(e==='Transactions'){

        if(['PURCHASE','FEE','INTEREST','CASH_ADVANCE','INSTALLMENT','FINANCED_PRINCIPAL'].includes(r.type)&&Number(r.amountMinor)<0)add(e,r,'Charge type requires a nonnegative amount');

        if(['BANK_PAYMENT','REFUND','REBATE'].includes(r.type)&&Number(r.amountMinor)>0)add(e,r,'Credit type requires a nonpositive amount');

        if(r.type==='INSTALLMENT'&&(!r.installmentPlanId||!r.installmentNumber))add(e,r,'Installment needs plan and sequence', 'WARNING');

        if(r.reviewStatus!=='VERIFIED')add(e,r,'Transaction requires review','WARNING');
        if(r.type==='UNKNOWN')add(e,r,'Choose an activity type','WARNING');

      }

      if(['BankPayments','PaymentAllocations','Shares','Repayments'].includes(e)&&Number(r.amountMinor)<=0)add(e,r,'Amount must be positive');

      if(e==='Statements'&&r.minimumMinor!==''&&(Number(r.minimumMinor)<0||r.balanceMinor!==''&&Number(r.minimumMinor)>Math.max(0,Number(r.balanceMinor))))add(e,r,'Minimum due exceeds positive statement balance');

      if(e==='Statements'&&r.syncError)add(e,r,'Calendar synchronization needs attention','WARNING');

      if(e==='Cards'&&r.replacesCardId){const p=find('Cards',r.replacesCardId);if(r.replacesCardId===r.id||p&&p.accountId!==r.accountId)add(e,r,'Invalid replacement relationship');const chain=new Set([r.id]);let next=p;while(next){if(chain.has(next.id)){add(e,r,'Replacement relationship contains a cycle');break;}chain.add(next.id);next=find('Cards',next.replacesCardId);}}

      if(e==='Shares'&&r.requestStatus==='REQUESTED'&&!r.requestDate)add(e,r,'Requested share needs request date');

      if(e==='InstallmentPlans'&&(!Number.isInteger(Number(r.count))||Number(r.count)<1||Number(r.count)>600))add(e,r,'Installment count must be 1–600');

      if(e==='InstallmentPlans'&&r.monthlyMinor!==''&&Number(r.monthlyMinor)<0)add(e,r,'Expected installment amount cannot be negative');

      if(e==='InstallmentPlans'&&r.originTransactionId){const origin=find('Transactions',r.originTransactionId);if(origin&&origin.type!=='FINANCED_PRINCIPAL')add(e,r,'Classify originating purchase as FINANCED_PRINCIPAL before linking a plan');}

      if(e==='SavedViews'){try{validateFilters_(JSON.parse(r.filters));if(!/^\w+:(asc|desc)$/.test(r.sort))throw Error();}catch(_){add(e,r,'Invalid saved filters or sort');}}

    });

  });

  db.BankPayments.forEach(p=>{

    const allocations=db.PaymentAllocations.filter(a=>a.paymentId===p.id&&a.status==='ACTIVE');

    if(checkedSum(allocations,'BankPayments',p)>Number(p.amountMinor))add('BankPayments',p,'Allocations exceed payment');

    if(p.matchedTransactionId){const t=find('Transactions',p.matchedTransactionId);if(t&&(t.type!=='BANK_PAYMENT'||t.status!=='ACTIVE'||t.accountId!==p.accountId||t.currency!==p.currency||-Number(t.amountMinor)!==Number(p.amountMinor)))add('BankPayments',p,'Matched transaction must be an equal bank payment credit');

      if(db.BankPayments.some(x=>x.id!==p.id&&x.status!=='REVERSED'&&p.status!=='REVERSED'&&x.matchedTransactionId===p.matchedTransactionId))add('BankPayments',p,'Imported bank payment already matched');}

  });

  db.PaymentAllocations.forEach(a=>{const p=find('BankPayments',a.paymentId),s=find('Statements',a.statementId);if(p&&s&&(p.accountId!==s.accountId||p.currency!==s.currency))add('PaymentAllocations',a,'Payment and statement must match account and currency');});

  db.Statements.forEach(s=>{

    const active=db.PaymentAllocations.filter(a=>a.statementId===s.id&&a.status==='ACTIVE'&&find('BankPayments',a.paymentId)&&find('BankPayments',a.paymentId).status!=='REVERSED');

    if(active.length&&s.balanceMinor==='')add('Statements',s,'Official balance required before allocation');

    if(s.balanceMinor!==''&&checkedSum(active,'Statements',s)>Math.max(0,Number(s.balanceMinor)))add('Statements',s,'Allocations exceed official balance');

  });

  db.Transactions.forEach(t=>{

    const shares=db.Shares.filter(s=>s.transactionId===t.id&&s.status==='ACTIVE');

    const eligible=t.status==='ACTIVE'&&['PURCHASE','FEE','INTEREST','CASH_ADVANCE','INSTALLMENT'].includes(t.type)?Math.max(0,Number(t.amountMinor)):0;

    if(checkedSum(shares,'Transactions',t)>eligible)add('Transactions',t,'Shares exceed eligible transaction amount');

    if(t.installmentPlanId){const p=find('InstallmentPlans',t.installmentPlanId);if(p&&t.installmentNumber&&(!Number.isInteger(Number(t.installmentNumber))||Number(t.installmentNumber)<1||Number(t.installmentNumber)>Number(p.count)))add('Transactions',t,'Installment sequence outside plan');if(t.type==='INSTALLMENT'&&t.status==='ACTIVE'&&db.Transactions.some(x=>x.id!==t.id&&x.installmentPlanId===t.installmentPlanId&&x.installmentNumber===t.installmentNumber&&x.type==='INSTALLMENT'&&x.status==='ACTIVE'))add('Transactions',t,'Multiple posted charges for installment sequence','WARNING');}

  });

  db.Shares.forEach(s=>{

    const entries=db.Repayments.filter(r=>r.shareId===s.id&&r.status!=='REVERSED');

    if(checkedSum(entries,'Shares',s)>Number(s.amountMinor))add('Shares',s,'Repayments and adjustments exceed share');

    if(s.status==='VOID'&&entries.length)add('Shares',s,'Reverse repayments before voiding share');

  });

  try{validateSettings_(settings_(db));}catch(_){add('Settings',{id:''},'Invalid settings; run repair or edit settings');}

  const keys=new Set();db.Settings.forEach(r=>{if(keys.has(r.key)||!Object.prototype.hasOwnProperty.call(CC_SETTINGS,r.key))add('Settings',r,'Duplicate or unknown setting');keys.add(r.key);});

  Object.keys(CC_SETTINGS).forEach(k=>{if(!keys.has(k))add('Settings',{id:''},'Missing setting: '+k);});

  db.Operations.filter(o=>o.state!=='DONE'&&o.state!=='CANCELLED').forEach(o=>add('Operations',o,'Pending operation requires recovery'));

  return out;

}

function statementTotals_(s,db) {

  if(s.balanceMinor!==''&&!Number.isSafeInteger(Number(s.balanceMinor))||s.minimumMinor!==''&&!Number.isSafeInteger(Number(s.minimumMinor)))fail_('VALIDATION: Invalid statement amount.');

  const paid=sum_(db.PaymentAllocations.filter(a=>a.statementId===s.id&&a.status==='ACTIVE'&&db.BankPayments.some(p=>p.id===a.paymentId&&p.status==='CONFIRMED')),'amountMinor');

  const known=s.balanceMinor!==''; const remaining=known?Math.max(0,Number(s.balanceMinor)-paid):'';

  return {paidMinor:paid,remainingMinor:remaining,minimumRemainingMinor:s.minimumMinor===''?'':Math.max(0,Number(s.minimumMinor)-paid),settlement:!known?'UNKNOWN':remaining===0?'SETTLED':paid?'PARTIAL':'OPEN'};

}

function shareTotals_(s,db) {

  if(s.amountMinor===''||!Number.isSafeInteger(Number(s.amountMinor)))fail_('VALIDATION: Invalid share amount.');

  const entries=db.Repayments.filter(r=>r.shareId===s.id&&r.status==='CONFIRMED');

  const cash=sum_(entries.filter(r=>r.type==='CASH'),'amountMinor'),credit=sum_(entries.filter(r=>r.type!=='CASH'),'amountMinor');

  const remaining=Number(s.amountMinor)-cash-credit;

  return {cashMinor:cash,creditMinor:credit,remainingMinor:remaining,settlement:remaining===0?'SETTLED':cash+credit>0?'PARTIAL':'OPEN'};

}

function decorate_(e,r,db) {

  const out=Object.assign({},r);
  let revisionToken;
  Object.defineProperty(out,'_token',{enumerable:true,get:()=>{if(revisionToken===undefined)revisionToken=token_(r);return revisionToken;}});

  try {

  if(e==='Statements')Object.assign(out,statementTotals_(r,db));

  if(e==='Shares'){Object.assign(out,shareTotals_(r,db));const today=today_(db);out.expectedState=out.remainingMinor>0&&r.expectedDate&&r.expectedDate<today?'PAST_EXPECTED_DATE':'NOT_PAST_EXPECTED_DATE';}

  if(e==='InstallmentPlans')out.postedCount=db.Transactions.filter(t=>t.installmentPlanId===r.id&&t.type==='INSTALLMENT'&&t.status==='ACTIVE').length;

  if(e==='People')out.totals=db.Shares.filter(s=>s.personId===r.id&&s.status==='ACTIVE').reduce((o,s)=>{o[s.currency]=addMinor_(o[s.currency]||0,shareTotals_(s,db).remainingMinor);return o;},{});

  }catch(_){Object.assign(out,{remainingMinor:'',paidMinor:'',minimumRemainingMinor:'',cashMinor:'',creditMinor:'',settlement:'INVALID',_invalid:true});if(e==='People')out.totals={};}

  return out;

}

function validateFilters_(f) {

  if(!f||Array.isArray(f)||typeof f!=='object')fail_('VALIDATION: Invalid filters.');

  const allowed=['category','recordId','q','personId','tag','status','requestStatus','settlement','expectedState','from','to','currency','dateBasis','accountId','cardId','statementId','statementDate','transactionId','shareId','type','spending','undated','installmentPlanId'];

  Object.keys(f).forEach(k=>{if(!allowed.includes(k)||(k==='type'&&Array.isArray(f[k])?f[k].length>30||f[k].some(v=>typeof v!=='string'||!CC_ENUMS['Transactions.type'].includes(v)):typeof f[k]!=='string'||f[k].length>300))fail_('VALIDATION: Invalid filter.');});

  if(f.from&&!dateValid_(f.from)||f.to&&!dateValid_(f.to)||f.from&&f.to&&f.from>f.to)fail_('VALIDATION: Invalid filter dates.');
  if(f.statementDate&&!dateValid_(f.statementDate))fail_('VALIDATION: Choose a valid statement date.');

}

function filtered_(e,db,f,sort) {

  validateFilters_(f);const parts=sort.split(':');if(parts.length!==2||!['asc','desc'].includes(parts[1]))fail_('VALIDATION: Invalid sort.');

  const dates={Transactions:['transactionDate','postingDate','dueDate'],Statements:['statementDate','dueDate'],Shares:['transactionDate','expectedDate','requestDate'],BankPayments:['date'],Repayments:['date']};

  const basis=f.dateBasis||(dates[e]||['updatedAt'])[0];if(!(dates[e]||['updatedAt']).includes(basis))fail_('VALIDATION: Unsupported date basis.');

  return db[e].map(r=>decorate_(e,r,db)).filter(r=>{

    const t=e==='Shares'?db.Transactions.find(x=>x.id===r.transactionId)||{}:r;
    if(f.statementDate){const statement=e==='Statements'?r:db.Statements.find(s=>s.id===(r.statementId||t.statementId));if(!statement||statement.statementDate!==f.statementDate)return false;}

    if(f.spending==='true'&&(t.status!=='ACTIVE'||!['PURCHASE','FEE','INTEREST','CASH_ADVANCE','INSTALLMENT'].includes(t.type)))return false;

    if(f.undated==='true'&&t.postingDate)return false;

    if(f.q&&!String([r.description,r.originalDescription,r.notes,r.name,r.nickname,r.reference,t.description,t.notes].join(' ')).toLowerCase().includes(f.q.toLowerCase()))return false;

    if(f.personId&&(e==='Transactions'?!db.Shares.some(s=>s.transactionId===r.id&&s.personId===f.personId&&s.status==='ACTIVE'):r.personId!==f.personId))return false;

    if(f.tag&&!String(t.tags||'').split(',').map(x=>x.trim().toLowerCase()).includes(f.tag.toLowerCase()))return false;

    if(f.category&&String(t.category||'').toLowerCase()!==f.category.toLowerCase())return false;
    if(Array.isArray(f.type)&&f.type.length&&!f.type.includes(t.type))return false;
    if(f.recordId&&r.id!==f.recordId)return false;
    if(['status','requestStatus','settlement','expectedState','currency','accountId','cardId','statementId','transactionId','shareId','type','installmentPlanId'].some(k=>f[k]&&!Array.isArray(f[k])&&String(r[k]||t[k]||'')!==f[k]))return false;

    const date=r[basis]||t[basis]||'';return !((f.from&&date<f.from)||(f.to&&date>f.to));

  }).sort((a,b)=>{const value=r=>parts[0]==='cardId'?(db.Cards.find(c=>c.id===r.cardId)?.nickname||''):parts[0]==='accountId'?(db.Accounts.find(c=>c.id===r.accountId)?.nickname||''):parts[0]==='personId'?(db.People.find(c=>c.id===r.personId)?.name||''):parts[0]==='transactionId'?(db.Transactions.find(c=>c.id===r.transactionId)?.description||''):parts[0]==='statementId'?(db.Statements.find(c=>c.id===r.statementId)?.statementDate||''):parts[0]==='paymentId'?(db.BankPayments.find(c=>c.id===r.paymentId)?.reference||''):parts[0]==='shareId'?(db.Transactions.find(t=>t.id===db.Shares.find(c=>c.id===r.shareId)?.transactionId)?.description||''):r[parts[0]];const x=value(a),y=value(b),empty=v=>v===''||v==null;if(empty(x)!==empty(y))return empty(x)?1:-1;const c=/Minor$|^count$|^postedCount$/.test(parts[0])&&!empty(x)?Number(x)-Number(y):typeof x==='number'&&typeof y==='number'?x-y:String(x??'').localeCompare(String(y??''));return (parts[1]==='asc'?1:-1)*c||a.id.localeCompare(b.id);});

}

function collectionSummary_(rows) {

  const totals={};rows.filter(r=>r.status==='ACTIVE').forEach(r=>{const c=r.currency;if(!totals[c])totals[c]={assigned:0,cash:0,credits:0,remaining:0,notRequested:0,partial:0,settled:0,disputed:0,pastExpected:0};const t=totals[c];t.assigned=addMinor_(t.assigned,r.amountMinor);t.cash=addMinor_(t.cash,r.cashMinor);t.credits=addMinor_(t.credits,r.creditMinor);t.remaining=addMinor_(t.remaining,r.remainingMinor);t.notRequested+=r.requestStatus==='NOT_REQUESTED'?1:0;t.partial+=r.settlement==='PARTIAL'?1:0;t.settled+=r.settlement==='SETTLED'?1:0;t.disputed+=r.requestStatus==='DISPUTED'?1:0;t.pastExpected+=r.expectedState==='PAST_EXPECTED_DATE'?1:0;});return totals;

}

function apiInstallmentSchedule(planId) {return guard_(()=>{

  const db=load_(),p=db.InstallmentPlans.find(x=>x.id===planId);if(!p||!dateValid_(p.startDate)||!Number.isInteger(Number(p.count))||Number(p.count)<1||Number(p.count)>600)fail_('VALIDATION: Valid plan start date and count required.');

  const [y,m,d]=p.startDate.split('-').map(Number);return Array.from({length:Number(p.count)},(_,i)=>{const end=new Date(Date.UTC(y,m+i,0));const due=new Date(Date.UTC(y,m-1+i,Math.min(d,end.getUTCDate()))).toISOString().slice(0,10);const posted=db.Transactions.filter(t=>t.installmentPlanId===p.id&&Number(t.installmentNumber)===i+1&&t.type==='INSTALLMENT'&&t.status==='ACTIVE');return {number:i+1,expectedDate:due,expectedAmount:formatMoney_(p.monthlyMinor,p.currency),currency:p.currency,postedCount:posted.length,status:posted.length===1?'POSTED':posted.length>1?'REVIEW DUPLICATES':'NOT LINKED'};});

});}

function lookups_(db) {const out={};['Accounts','Cards','People','Transactions','Statements','BankPayments','Shares','InstallmentPlans'].forEach(e=>out[e]=db[e].map(r=>{

  const account=db.Accounts.find(a=>a.id===r.accountId);const base=r.nickname||r.name||r.description||r.statementDate||r.date||r.reference||r.id;

  return {id:r.id,label:base+(e==='Cards'&&db.Cards.filter(c=>c.nickname===r.nickname).length>1?' · '+(r.lastFour?'•••• '+r.lastFour+' · ':'')+(account?.nickname||''):'')+(['Statements','BankPayments'].includes(e)&&account?' · '+account.nickname:'')+(['Accounts','Cards'].includes(e)?'':' · '+r.id.slice(-6)),currency:r.currency||(account&&account.currency)||'',accountId:r.accountId||'',status:r.status,...(e==='Statements'?{statementDate:r.statementDate}:{}),...(e==='InstallmentPlans'?{cardId:r.cardId,count:Number(r.count)}:{})};

}));return out;}

function overview_(db,issues) {

  const invalid=issues.some(x=>x.severity==='ERROR'); const totals={};

  const get=c=>totals[c]||(totals[c]={spendingMinor:0,owedMinor:0,assignedMinor:0,cashMinor:0,creditMinor:0,statementRemainingMinor:0,unknownStatements:0,knownStatements:0,unclassifiedCount:0});

  const months={}; if(!invalid){
    db.Transactions.filter(t=>t.status==='ACTIVE'&&t.type==='UNKNOWN').forEach(t=>get(t.currency).unclassifiedCount++);

    db.Transactions.filter(t=>t.status==='ACTIVE'&&['PURCHASE','FEE','INTEREST','CASH_ADVANCE','INSTALLMENT'].includes(t.type)).forEach(t=>{const g=get(t.currency);g.spendingMinor=addMinor_(g.spendingMinor,t.amountMinor);const key=t.currency+' '+(t.postingDate||'Undated').slice(0,7);months[key]=addMinor_(months[key]||0,t.amountMinor);});

    db.Shares.filter(s=>s.status==='ACTIVE').forEach(s=>{const x=shareTotals_(s,db),g=get(s.currency);g.assignedMinor=addMinor_(g.assignedMinor,s.amountMinor);g.owedMinor=addMinor_(g.owedMinor,x.remainingMinor);g.cashMinor=addMinor_(g.cashMinor,x.cashMinor);g.creditMinor=addMinor_(g.creditMinor,x.creditMinor);});

    db.Statements.filter(s=>s.status==='OPEN').forEach(s=>{const x=statementTotals_(s,db),g=get(s.currency);if(x.remainingMinor==='')g.unknownStatements++;else {g.knownStatements++;g.statementRemainingMinor=addMinor_(g.statementRemainingMinor,x.remainingMinor);}});

  }

  Object.values(totals).forEach(t=>{if(t.unknownStatements&&!t.knownStatements)t.statementRemainingMinor='';});

  const txDates=db.Transactions.map(t=>t.postingDate||t.transactionDate).filter(Boolean).sort();

  return {invalid,totals,months,freshness:txDates.pop()||'',lastImport:db.ImportHistory.map(x=>x.updatedAt).sort().pop()||'',

    recent:filtered_('Transactions',db,{},'transactionDate:desc').slice(0,5),upcoming:filtered_('Statements',db,{status:'OPEN'},'dueDate:asc').filter(s=>s.dueDate&&s.settlement!=='SETTLED'),reviewCount:issues.length};

}

function settings_(db) {const s=Object.assign({},CC_SETTINGS);db.Settings.forEach(r=>s[r.key]=r.key==='ReminderTime'||r.value instanceof Date?r.value:String(r.value));return s;}

function today_(db) {try{return Utilities.formatDate(new Date(),settings_(db).Timezone,'yyyy-MM-dd');}catch(_){return '';}}

function clientSettings_(db) {const s=settings_(db);try{s.ReminderTime=normalizeTime_(s.ReminderTime,s.Timezone);}catch(_){s.ReminderTime='INVALID — repair required';}Object.keys(s).forEach(k=>{if(s[k] instanceof Date)s[k]='INVALID — date value in setting';});return s;}

function validateSettings_(s) {

  try{Utilities.formatDate(new Date(),s.Timezone,'yyyy-MM-dd');}catch(_){fail_('VALIDATION: Invalid timezone.');}

  normalizeTime_(s.ReminderTime,s.Timezone);

  ['SyncEnabled','ShowAmounts','IncludeHistorical','BackupEnabled'].forEach(k=>{if(!['true','false'].includes(String(s[k])))fail_('VALIDATION: Boolean settings use true or false.');});

  if(s.DefaultCurrency&&CC_CURRENCY[s.DefaultCurrency]===undefined)fail_('VALIDATION: Unsupported default currency.');

  if(!/^\d+(,\d+){0,4}$/.test(String(s.ReminderMinutes))||String(s.ReminderMinutes).split(',').some(x=>Number(x)>40320))fail_('VALIDATION: Up to five reminder offsets, 0–40320 minutes.');

  if(!Number.isInteger(Number(s.BackupDays))||Number(s.BackupDays)<1||Number(s.BackupDays)>365)fail_('VALIDATION: BackupDays must be 1–365.');

  if(String(s.SyncEnabled)==='true'&&!s.CalendarId)fail_('VALIDATION: Select a calendar before enabling sync.');

}

function apiSettings(values, expectedToken, requestId) {return guard_(()=>locked_(()=>{

  const db=load_();ensureRecovered_(db);const old=settings_(db);if(hash_(JSON.stringify(old))!==expectedToken)fail_('CONFLICT: Settings changed. Refresh.');

  Object.keys(values).forEach(k=>{if(!Object.prototype.hasOwnProperty.call(CC_SETTINGS,k)||k==='CalendarId')fail_('VALIDATION: Calendar selection uses migration controls.');});

  const next=Object.assign({},old,values);next.ReminderTime=normalizeTime_(next.ReminderTime,next.Timezone);validateSettings_(next);

  if(next.Timezone!==old.Timezone&&db.Statements.some(s=>s.eventId&&s.calendarMode==='ON'))fail_('VALIDATION: Pause all linked statement reminders before timezone change.');

  const changes=Object.keys(next).filter(k=>next[k]!==old[k]).map(k=>{const b=db.Settings.find(x=>x.key===k);return {entity:'Settings',before:b,after:Object.assign({},b,{value:next[k],revision:Number(b.revision)+1,updatedAt:now_()})};});

  if(changes.length)commit_(db,changes,validRequest_(requestId),'SETTINGS');props_().setProperty('DATA_TIMEZONE',next.Timezone);props_().setProperty('SYNC_DIRTY','true');return {saved:true};

}));}

function repairSettings() {return guard_(()=>locked_(()=>{

  const db=load_(),s=settings_(db),r=db.Settings.find(x=>x.key==='ReminderTime');const value=normalizeTime_(s.ReminderTime,s.Timezone);

  if(r) {const sh=sheet_('Settings');const row=db.Settings.findIndex(x=>x.id===r.id)+2;sh.getRange(row,columns_('Settings').indexOf('value')+1).setNumberFormat('@').setValue(value);}

  return {reminderTime:value};

}));}

function diagnostics_(db) {return {backendRevision:'records-20260913-1',schemaVersion:CC_VERSION,settingsToken:hash_(JSON.stringify(settings_(db))),pending:db.Operations.filter(x=>x.state!=='DONE'&&x.state!=='CANCELLED').map(x=>({id:x.id,kind:x.kind})),triggers:ScriptApp.getProjectTriggers().filter(t=>['onSheetEdit_','reconcile_'].includes(t.getHandlerFunction())).map(t=>({handler:t.getHandlerFunction(),id:t.getUniqueId()})),lastSync:props_().getProperty('LAST_SYNC')||'',lastBackup:props_().getProperty('LAST_BACKUP')||'',automationError:props_().getProperty('AUTOMATION_ERROR')||''};}

function installTriggers() {return guard_(()=>locked_(()=>{

  stopTriggers_();const a=ScriptApp.newTrigger('onSheetEdit_').forSpreadsheet(book_()).onEdit().create();const b=ScriptApp.newTrigger('reconcile_').timeBased().everyMinutes(15).create();

  props_().setProperty('TRIGGER_IDS',JSON.stringify([a.getUniqueId(),b.getUniqueId()]));return {installed:2};

}));}

function stopAutomation() {return guard_(()=>locked_(()=>{stopTriggers_();return {stopped:true,message:'Existing Calendar reminders remain until paused and synchronized.'};}));}

function stopTriggers_() {ScriptApp.getProjectTriggers().filter(t=>['onSheetEdit_','reconcile_'].includes(t.getHandlerFunction())).forEach(t=>ScriptApp.deleteTrigger(t));props_().deleteProperty('TRIGGER_IDS');}

function triggerOwner_(e) {const ids=JSON.parse(props_().getProperty('TRIGGER_IDS')||'[]');if(!e||!ids.includes(String(e.triggerUid))||String(Session.getEffectiveUser().getEmail()).toLowerCase()!==String(props_().getProperty('OWNER_EMAIL')).toLowerCase())fail_('ACCESS_DENIED: Unregistered trigger.');}

function onSheetEdit_(e) {triggerOwner_(e);if(!e.source||e.source.getId()!==props_().getProperty('SPREADSHEET_ID'))return;props_().setProperty('SYNC_DIRTY','true');}

function reconcile_(e) {triggerOwner_(e);try{locked_(()=>{reconcileSheetEdits_();const db=load_();if(review_(db).some(x=>x.severity==='ERROR'))fail_('REVIEW: Invalid data blocks automation.');sync_(db);const s=settings_(db);if(s.BackupEnabled==='true'&&Date.now()-Date.parse(props_().getProperty('LAST_BACKUP')||'1970-01-01')>=Number(s.BackupDays)*86400000)backup_(db);});props_().deleteProperty('AUTOMATION_ERROR');}catch(_){props_().setProperty('AUTOMATION_ERROR','Automation needs attention. Review data, pending operations, Calendar access, and trigger authorization.');}}

function apiBackup() {return guard_(()=>locked_(()=>backup_(load_())));}

function backup_(db) {

  const b=SpreadsheetApp.create('Card workspace backup '+now_().slice(0,10));

  let placeholder=b.getSheets()[0];book_().getSheets().forEach(sh=>{const copy=sh.copyTo(b);if(placeholder){b.deleteSheet(placeholder);placeholder=null;}copy.setName(sh.getName());});

  props_().setProperty('LAST_BACKUP',now_());return {url:b.getUrl(),message:'Private snapshot created, including custom columns. Code, triggers, properties and Calendar are separate recovery items.'};

}

function calendarId_(s) {return s.CalendarId;}

function apiCalendarTest() {return guard_(()=>{const s=settings_(load_());if(!s.CalendarId)fail_('CALENDAR: Select a calendar.');try{const c=Calendar.Calendars.get(s.CalendarId);return {connected:true,timeZone:c.timeZone};}catch(_){fail_('CALENDAR: Calendar unavailable. Verify Advanced Service, API enablement, ID and owner permissions.');}});}

function apiCalendars() {return guard_(()=>{let list=[],page;do{const r=Calendar.CalendarList.list({maxResults:250,pageToken:page});list=list.concat((r.items||[]).filter(c=>['owner','writer'].includes(c.accessRole)).map(c=>({id:c.id,label:c.summary})));page=r.nextPageToken;}while(page);return list;});}

function apiCreateCalendar() {return guard_(()=>{const c=Calendar.Calendars.insert({summary:'Card payment reminders',timeZone:settings_(load_()).Timezone});return {id:c.id,label:c.summary};});}

function eventId_(statementId,calendarId) {return 'cc'+hash_(props_().getProperty('SPREADSHEET_ID')+'|'+statementId+'|'+calendarId).slice(0,60);}

function eventOwned_(ev,s) {return ev&&ev.extendedProperties&&ev.extendedProperties.private&&ev.extendedProperties.private.ccStatement===s.id&&ev.extendedProperties.private.ccWorkspace===hash_(props_().getProperty('SPREADSHEET_ID')).slice(0,32);}

function calendarGet_(cal,id) {try{return Calendar.Events.get(cal,id);}catch(e){if(/\b404\b|not found/i.test(String(e.message)))return null;throw e;}}

function localInstant_(date,time,tz) {

  if(!dateValid_(date))fail_('CALENDAR: Invalid due date.');const target=date+' '+time;const guess=Date.parse(date+'T'+time+':00Z');const offsets=new Set();

  [-36,-12,0,12,36].forEach(h=>offsets.add(Utilities.formatDate(new Date(guess+h*3600000),tz,'Z')));

  const candidates=[];offsets.forEach(o=>{const n=(o[0]==='-'?-1:1)*(Number(o.slice(1,3))*60+Number(o.slice(3,5)));const d=new Date(guess-n*60000);if(Utilities.formatDate(d,tz,'yyyy-MM-dd HH:mm')===target)candidates.push(d);});

  if(candidates.length!==1)fail_('CALENDAR: Reminder time is ambiguous or nonexistent in this timezone. Choose another time.');return candidates[0];

}

function eventPlan_(s,db,settings) {

  if(!dateValid_(s.dueDate))fail_('CALENDAR: Missing or invalid due date; existing event preserved.');

  const account=db.Accounts.find(a=>a.id===s.accountId);if(!account)fail_('CALENDAR: Missing billing account.');

  const time=normalizeTime_(settings.ReminderTime,settings.Timezone),start=localInstant_(s.dueDate,time,settings.Timezone);

  const totals=statementTotals_(s,db),disabled=s.calendarMode!=='ON'||s.status==='ARCHIVED'||totals.settlement==='SETTLED';

  const cal=s.calendarId||settings.CalendarId;if(!cal)fail_('CALENDAR: No target calendar configured.');

  if(s.calendarId&&s.calendarId!==settings.CalendarId)fail_('CALENDAR: Target changed; use Calendar migration.');

  const id=s.eventId||eventId_(s.id,cal);

  const body={summary:'Card payment · '+account.nickname+(settings.ShowAmounts==='true'&&s.balanceMinor!==''?' · '+formatMoney_(s.balanceMinor,s.currency)+' '+s.currency:''),

    description:'Payment reminder. Check your private card workspace for the current statement and payment status.',

    start:{dateTime:start.toISOString(),timeZone:settings.Timezone},end:{dateTime:new Date(start.getTime()+15*60000).toISOString(),timeZone:settings.Timezone},

    reminders:{useDefault:false,overrides:disabled?[]:String(settings.ReminderMinutes).split(',').map(m=>({method:'popup',minutes:Number(m)}))},

    extendedProperties:{private:{ccStatement:s.id,ccWorkspace:hash_(props_().getProperty('SPREADSHEET_ID')).slice(0,32)}}};

  const historical=s.dueDate<Utilities.formatDate(new Date(),settings.Timezone,'yyyy-MM-dd');

  return {cal,id,body,fingerprint:hash_(JSON.stringify(body)+'|'+account.nickname),skip:!s.eventId&&(disabled||historical&&settings.IncludeHistorical!=='true'),disabled};

}

function apiSyncPreview() {return guard_(()=>{const db=load_();return db.Statements.filter(s=>s.calendarMode!=='OFF'||s.eventId).map(s=>{try{const p=eventPlan_(s,db,settings_(db));return {id:s.id,dueDate:s.dueDate,action:p.skip?'SKIP':p.disabled?'DISABLE REMINDERS':s.eventId?'UPDATE':'CREATE'};}catch(_){return {id:s.id,action:'ERROR — existing event preserved'};}});});}

function apiSync() {return guard_(()=>locked_(()=>sync_(load_(),true)));}

function sync_(db,force) {

  const settings=settings_(db);validateSettings_(settings);ensureRecovered_(db);

  if(settings.SyncEnabled!=='true')return {processed:0,message:'Synchronization is disabled. Existing reminders remain.'};

  if(review_(db).some(x=>x.severity==='ERROR'))fail_('REVIEW: Repair invalid records before synchronization.');

  let processed=0,failed=0;const deadline=Date.now()+180000;

  const candidates=db.Statements.filter(s=>s.calendarMode!=='OFF'||s.eventId).sort((a,b)=>String(a.syncedAt).localeCompare(String(b.syncedAt)));

  for(let s of candidates){

    if(processed+failed>=20||Date.now()>deadline)break;if(!force&&s.nextRetry&&Date.parse(s.nextRetry)>Date.now())continue;

    try{

      const p=eventPlan_(s,db,settings);if(p.skip)continue;

      const fresh=load_(), current=fresh.Statements.find(x=>x.id===s.id);

      if(!current||token_(current)!==token_(s)||review_(fresh).some(x=>x.severity==='ERROR'))fail_('CONFLICT: Data changed during synchronization.');

      if(!s.eventId){const reserved=Object.assign({},s,{calendarId:p.cal,eventId:p.id});write_('Statements',s,reserved);s=reserved;SpreadsheetApp.flush();}

      const ev=calendarGet_(p.cal,p.id);

      if(ev&&!eventOwned_(ev,s))fail_('CALENDAR: Event ownership mismatch.');

      if(ev&&ev.status==='cancelled')fail_('CALENDAR: Event was deleted externally. Review before restoring.');

      if(ev)Calendar.Events.patch(p.body,p.cal,p.id,{sendUpdates:'none'});

      else {

        try{Calendar.Events.insert(Object.assign({id:p.id},p.body),p.cal,{sendUpdates:'none'});}

        catch(e){const recovered=calendarGet_(p.cal,p.id);if(!eventOwned_(recovered,s))throw e;Calendar.Events.patch(p.body,p.cal,p.id,{sendUpdates:'none'});}

      }

      const after=Object.assign({},s,{calendarId:p.cal,eventId:p.id,syncedAt:now_(),fingerprint:p.fingerprint,syncError:'',attempts:0,nextRetry:'',revision:Number(s.revision)+1,updatedAt:now_()});write_('Statements',s,after);processed++;

    }catch(_){failed++;try{const attempts=Number(s.attempts||0)+1;write_('Statements',s,Object.assign({},s,{syncError:'Sync failed: check dates, ownership, access and integration settings.',attempts,nextRetry:new Date(Date.now()+Math.min(1440,Math.pow(2,Math.min(attempts,10)))*60000).toISOString()}));}catch(__){/* Next reconciliation rediscovers deterministic event. */}}

  }

  props_().setProperty('LAST_SYNC',now_());props_().deleteProperty('SYNC_DIRTY');return {processed,failed,message:'Bounded reconciliation finished; remaining records continue on next run.'};

}

function apiCalendarMigrationPreview(target) {return guard_(()=>{

  const db=load_();Calendar.Calendars.get(target);const payload={target,settings:settings_(db),records:db.Statements.map(s=>({id:s.id,token:token_(s)}))};

  return {target,eventsToRetire:db.Statements.filter(s=>s.eventId).length,token:hash_(JSON.stringify(payload)),message:'Old events remain with reminders disabled. Future synchronization creates events in the selected calendar.'};

});}

function apiCalendarMigrate(target,previewToken,requestId) {return guard_(()=>locked_(()=>{

  const db=load_();ensureRecovered_(db);Calendar.Calendars.get(target);

  const payload={target,settings:settings_(db),records:db.Statements.map(s=>({id:s.id,token:token_(s)}))};if(hash_(JSON.stringify(payload))!==previewToken)fail_('CONFLICT: Calendar preview is stale. Preview again.');

  if(target===settings_(db).CalendarId)return {done:true};

  const oldSetting=db.Settings.find(x=>x.key==='CalendarId');

  const data={target,oldSetting,records:db.Statements.filter(s=>s.eventId).map(s=>clone_(s))};

  if(JSON.stringify(data).length>44000)fail_('LIMIT: Calendar migration exceeds one journal cell. Pause and migrate a smaller workspace.');

  const op=meta_({kind:'CALENDAR_MIGRATION',state:'PENDING',payload:JSON.stringify(data),error:''},validRequest_(requestId));write_('Operations',null,op);return migrateCalendarApply_(op,db);

}));}

function migrateCalendarApply_(op,db) {

  const data=JSON.parse(op.payload);

  data.records.forEach(s=>{const ev=calendarGet_(s.calendarId,s.eventId);if(ev){if(!eventOwned_(ev,s))fail_('CALENDAR: Cannot retire event with mismatched ownership.');Calendar.Events.patch({reminders:{useDefault:false,overrides:[]}},s.calendarId,s.eventId,{sendUpdates:'none'});}});

  data.records.forEach(s=>write_('Statements',s,Object.assign({},s,{calendarId:'',eventId:'',fingerprint:'',syncError:'',syncedAt:'',nextRetry:'',attempts:0})));

  write_('Settings',data.oldSetting,Object.assign({},data.oldSetting,{value:data.target}));

  write_('Operations',op,Object.assign({},op,{state:'DONE'}));return {done:true};

}

const CC_IMPORT_HEADERS=['Source Hash','Source Row','Bank','Card','Last Four','Billing Cycle','Statement Date','Payment Due Date','Transaction Date','Posting Date','Description','Amount','Source Reference'];

function importRows_(csv) {

  if(typeof csv!=='string'||csv.length>1500000)fail_('IMPORT: CSV must be at most 1.5 MB.');

  let rows;try{rows=Utilities.parseCsv(csv.replace(/^\uFEFF/,''));}catch(_){fail_('IMPORT: CSV quoting is invalid. Export it again with the sanitizer.');}if(!rows.length||JSON.stringify(rows.shift())!==JSON.stringify(CC_IMPORT_HEADERS))fail_('IMPORT: Use the supplied sanitizer and its exact CSV headers.');

  if(rows.length>5000)fail_('IMPORT: Maximum 5,000 source rows per file.');return rows.filter(r=>r.some(Boolean)).map((r,i)=>{if(r.length!==CC_IMPORT_HEADERS.length||r.some(v=>v.length>3000))fail_('IMPORT: Invalid column count or oversized field at source row '+(i+2));return Object.fromEntries(CC_IMPORT_HEADERS.map((k,i)=>[k,r[i]||'']));});

}

function importGroup_(r){return [r.Bank,r.Card,r['Last Four']].join(' | ');}

function importPreview_(csv,mappings,db){const p=previewRows_(importRows_(csv),mappings,db);p.token=hash_(csv+'|'+JSON.stringify(mappings));return p;}

function previewRows_(rows,mappings,db) {

  const seen=new Set(),existing=new Set(db.Transactions.map(t=>t.sourceKey));

  const cards=new Map(db.Cards.map(c=>[c.id,c])),accounts=new Map(db.Accounts.map(a=>[a.id,a]));

  const contentKey=(account,date,amount,description)=>JSON.stringify([account,date,Number(amount),description]);

  const content=new Set(db.Transactions.map(t=>contentKey(t.accountId,t.transactionDate,t.amountMinor,t.originalDescription)));

  const within=new Set();

  const results=rows.map((r,index)=>{

    const key=r['Source Hash']+':'+r['Source Row'];const group=[r.Bank,r.Card,r['Last Four']].join(' | '),map=mappings[group];

    const result={index,sourceKey:key,group,status:'ACCEPTED',reason:'',source:r};

    if(!/^[a-f0-9]{64}$/.test(r['Source Hash'])||!/^\d+$/.test(r['Source Row'])||seen.has(key)){result.status='REJECTED';result.reason='Invalid or duplicate source identity';return result;}seen.add(key);

    if(existing.has(key)){result.status='SKIPPED';result.reason='Source row already imported';return result;}

    const card=map&&cards.get(map.cardId),account=card&&accounts.get(card.accountId);

    if(!account||account.status!=='ACTIVE'||card.status!=='ACTIVE'||!map.currency||account.currency!==map.currency){result.status='REJECTED';result.reason='Confirm card mapping and matching currency';return result;}

    try{

      const amount=minor_(r.Amount,map.currency);if(!dateValid_(r['Transaction Date'])||r['Posting Date']&&!dateValid_(r['Posting Date'])||r['Statement Date']&&!dateValid_(r['Statement Date'])||r['Payment Due Date']&&!dateValid_(r['Payment Due Date']))throw Error();

      if(r['Last Four']&&!/^\d{4}$/.test(r['Last Four']))throw Error();

      result.transaction={accountId:account.id,cardId:card.id,statementId:'',transactionDate:r['Transaction Date'],postingDate:r['Posting Date'],dueDate:r['Payment Due Date']||'',originalDescription:r.Description,description:r.Description,amountMinor:amount,currency:map.currency,type:'UNKNOWN',category:'',tags:'',notes:'',sourceKey:key,sourceRef:r['Source Reference'],reviewStatus:'REVIEW',installmentPlanId:'',installmentNumber:'',status:'ACTIVE'};

      if(content.has(contentKey(account.id,r['Transaction Date'],amount,r.Description))||within.has(contentKey(account.id,r['Transaction Date'],amount,r.Description))){result.status='SUSPECT';result.reason='Matching content requires review; may be legitimate';result.transaction.reviewStatus='DUPLICATE_CANDIDATE';}

      within.add(contentKey(account.id,r['Transaction Date'],amount,r.Description));

      if(/(?:\d[ -]?){13,19}/.test(r.Description))throw Error();

    }catch(_){result.status='REJECTED';result.reason='Invalid date, amount, or sensitive content';}

    return result;

  });

  return {results,groups:[...new Set(results.map(r=>r.group))],counts:results.reduce((o,r)=>(o[r.status]=(o[r.status]||0)+1,o),{})};

}

function apiImportPreview(csv,mappings) {return guard_(()=>{const p=importPreview_(csv,mappings||{},load_());return {token:p.token,groups:p.groups,counts:p.counts,rows:p.results.map(r=>({index:r.index,group:r.group,status:r.status,reason:r.reason,date:r.source['Transaction Date'],description:r.source.Description,amount:r.source.Amount}))};});}

function apiImportCommit(csv,mappings,previewToken,indices,requestId) {return guard_(()=>locked_(()=>{

  const db=load_();ensureRecovered_(db);const prior=db.Operations.find(o=>o.id===requestId);if(prior&&prior.state==='DONE')return {imported:0,replayed:true};

  const p=importPreview_(csv,mappings,db);if(p.token!==previewToken)fail_('CONFLICT: Import preview changed.');

  if(!Array.isArray(indices)||indices.length>15||new Set(indices).size!==indices.length)fail_('IMPORT: Commit at most 15 distinct preview rows at a time.');

  const changes=[],working=domainClone_(db);let imported=0;

  indices.forEach(i=>{

    const r=p.results[i];if(!r||r.status==='REJECTED')fail_('IMPORT: Selected row is rejected.');if(r.status==='SKIPPED')return;

    let statementId='';if(r.source['Statement Date']){

      let s=working.Statements.find(s=>s.accountId===r.transaction.accountId&&s.statementDate===r.source['Statement Date']);

      if(!s){s=meta_({accountId:r.transaction.accountId,statementDate:r.source['Statement Date'],periodStart:'',periodEnd:'',dueDate:r.source['Payment Due Date'],balanceMinor:'',minimumMinor:'',currency:r.transaction.currency,status:'OPEN',reconciliation:'UNVERIFIED',calendarMode:'OFF',calendarId:'',eventId:'',syncedAt:'',fingerprint:'',syncError:'',attempts:0,nextRetry:''});working.Statements.push(s);changes.push({entity:'Statements',before:null,after:s});}

      else if(r.source['Payment Due Date']&&s.dueDate!==r.source['Payment Due Date'])fail_('IMPORT: Conflicting due dates for account and statement date. Review source mapping.');statementId=s.id;

    }

    const t=meta_(Object.assign({},r.transaction,{statementId}));working.Transactions.push(t);changes.push({entity:'Transactions',before:null,after:t});imported++;

  });

  if(review_(working).some(x=>x.severity==='ERROR'))fail_('REVIEW: Invalid data blocks import.');

  changes.push({entity:'ImportHistory',before:null,after:meta_({sourceHash:hash_(csv),outcome:'COMMITTED',accepted:imported,rejected:p.counts.REJECTED||0,suspect:p.counts.SUSPECT||0,skipped:p.counts.SKIPPED||0,summary:'Sanitized source rows imported; classification and official balances require review.'})});

  commit_(db,changes,validRequest_(requestId),'IMPORT');return {imported};

}));}

function importBatch_(id){const row=table_('ImportBatches').byId.get(id);if(!row||row.length!==1)fail_('IMPORT: Batch not found. Choose the CSV again.');return row[0].record;}

function activeBatch_(id){const b=importBatch_(id);if(b.state==='EXPIRED'||Date.parse(b.expiresAt)<=Date.now())fail_('IMPORT: Batch expired. Choose the CSV again.');return b;}

function updateBatch_(b,patch){const after=Object.assign({},b,patch,{revision:Number(b.revision)+1,updatedAt:now_()});write_('ImportBatches',b,after);return after;}

function importPageRows_(b,page){

  const start=Math.max(0,Math.floor(Number(page)||0))*50,count=Math.min(50,Number(b.rowCount)-start);if(count<=0)return [];

  return readImportRows_(b,start,count);

}

function readImportRows_(b,start,count){

  const sh=sheet_('ImportRows'),cols=columns_('ImportRows'),values=sh.getRange(Number(b.startRow)+start,1,count,cols.length).getValues();

  const formulas=sh.getRange(Number(b.startRow)+start,1,count,cols.length).getFormulas();

  return values.map((v,i)=>{

    const r=Object.fromEntries(cols.map((c,j)=>[c,v[j]]));

    if(r.batchId!==b.id||Number(r.rowIndex)!==start+i||formulas[i].some(Boolean)||r.digest!==hash_(r.source))fail_('IMPORT: Staging rows were changed. Stage a fresh copy of the CSV.');

    try{return {source:JSON.parse(r.source),result:r.result?JSON.parse(r.result):null,index:start+i};}catch(_){fail_('IMPORT: Staging data is invalid. Choose the CSV again.');}

  });

}

function selectedImportRows_(b,indices){

  const rows=[],runs=[];indices.forEach(i=>{const last=runs[runs.length-1];if(last&&last.start+last.count===i)last.count++;else runs.push({start:i,count:1});});

  runs.forEach(run=>rows.push(...readImportRows_(b,run.start,run.count)));return rows;

}

function batchView_(b,page){

  const items=importPageRows_(b,page),selection=JSON.parse(b.selection||'[]');

  return {batchId:b.id,state:b.state,validation:b.validation,groups:JSON.parse(b.groups||'[]'),mappings:JSON.parse(b.mappings||'{}'),counts:JSON.parse(b.counts||'{}'),selection,progress:JSON.parse(b.progress||'{"cursor":0,"imported":0}'),total:Number(b.rowCount),page:Math.max(0,Math.floor(Number(page)||0)),expiresAt:b.expiresAt,

    rows:items.map(x=>({index:x.index,date:x.source['Transaction Date'],description:x.source.Description,amount:x.source.Amount,group:importGroup_(x.source),status:x.result?x.result.status:'UNMAPPED',reason:x.result?x.result.reason:'Confirm card and currency mappings.'}))};

}

function expireImports_(){

  const batches=table_('ImportBatches').records.slice(),pending=new Set();

  table_('Operations').records.filter(o=>o.state!=='DONE'&&o.state!=='CANCELLED'&&o.kind==='IMPORT_BATCH').forEach(o=>JSON.parse(o.payload).filter(c=>c.entity==='ImportBatches').forEach(c=>pending.add(c.after.id)));

  batches.filter(b=>b.state!=='EXPIRED'&&Date.parse(b.expiresAt)<=Date.now()&&!pending.has(b.id)).forEach(b=>{

    sheet_('ImportRows').getRange(Number(b.startRow),1,Number(b.rowCount),columns_('ImportRows').length).clearContent();

    updateBatch_(b,{state:'EXPIRED',mappings:'{}',selection:'[]',groups:'[]',counts:'{}',validation:''});

  });

}

function apiImportStage(csv,restart){return guard_(()=>{

  const rows=importRows_(csv);if(!rows.length)fail_('IMPORT: CSV contains no transactions.');expireImports_();

  const groups=[...new Set(rows.map(importGroup_))];if(groups.length>100||JSON.stringify(groups).length>24000)fail_('IMPORT: Too many card groups. Split this CSV by card.');

  const fingerprint=hash_(csv),id='batch-'+fingerprint,existing=table_('ImportBatches').byId.get(id),old=existing&&existing[0].record;

  if(old&&restart)ensureRecovered_(load_());

  if(old&&!restart&&old.state!=='EXPIRED'&&old.state!=='STAGING')return batchView_(old,0);

  const ranges=table_('ImportBatches').records.filter(b=>b.state!=='EXPIRED'&&b.id!==id).map(b=>[Number(b.startRow),Number(b.rowCount)]).sort((a,b)=>a[0]-b[0]);

  let start=2;for(const [position,count] of ranges){if(start+rows.length<=position)break;start=Math.max(start,position+count);}

  const b=Object.assign(meta_({},id),{fingerprint,state:'STAGING',mappings:'{}',validation:'',selection:'[]',progress:'{"cursor":0,"imported":0}',expiresAt:new Date(Date.now()+7*86400000).toISOString(),error:'',startRow:start,rowCount:rows.length,groups:JSON.stringify([...new Set(rows.map(importGroup_))]),counts:'{}'});

  write_('ImportBatches',old||null,b);

  const sh=sheet_('ImportRows'),cols=columns_('ImportRows');room_(sh,start+rows.length-1);

  for(let offset=0;offset<rows.length;offset+=250){const part=rows.slice(offset,offset+250).map((source,i)=>Object.assign(meta_({},id+'-'+(offset+i)),{batchId:id,rowIndex:offset+i,source:JSON.stringify(source),result:'',digest:hash_(JSON.stringify(source))}));sh.getRange(start+offset,1,part.length,cols.length).setValues(part.map(r=>cols.map(c=>sheetValue_(r[c]))));}

  return batchView_(updateBatch_(b,{state:'STAGED'}),0);

},true,true);}

function apiImportValidate(batchId,mappings){return guard_(()=>{

  let b=activeBatch_(batchId);ensureRecovered_(load_());

  if(!mappings||Array.isArray(mappings)||typeof mappings!=='object')fail_('IMPORT: Confirm mappings.');

  b=updateBatch_(b,{state:'VALIDATING',validation:'',selection:'[]',progress:'{"cursor":0,"imported":0}'});

  const rows=readImportRows_(b,0,Number(b.rowCount)),result=previewRows_(rows.map(x=>x.source),mappings,load_());

  const col=columns_('ImportRows').indexOf('result')+1;

  for(let offset=0;offset<rows.length;offset+=250)sheet_('ImportRows').getRange(Number(b.startRow)+offset,col,Math.min(250,rows.length-offset),1).setValues(result.results.slice(offset,offset+250).map(r=>[JSON.stringify({status:r.status,reason:r.reason})]));

  const validation=hash_(b.fingerprint+'|'+JSON.stringify(mappings)+'|'+id_());

  const selected=result.results.filter(r=>r.status==='ACCEPTED').map(r=>r.index);

  b=updateBatch_(b,{state:'READY',mappings:JSON.stringify(mappings),validation,selection:JSON.stringify(selected),counts:JSON.stringify(result.counts)});

  return batchView_(b,0);

},true,true);}

function apiImportPage(batchId,page){return guard_(()=>batchView_(activeBatch_(batchId),page),true,true);}

function apiImportStatus(batchId){return guard_(()=>batchView_(activeBatch_(batchId),0),true,true);}

function finishImport_(b){const p=JSON.parse(b.progress),selected=JSON.parse(b.selection);return selected.length&&p.cursor>=selected.length&&b.state!=='COMPLETED'?updateBatch_(b,{state:'COMPLETED'}):b;}

function apiImportSelect(batchId,validation,indices){return guard_(()=>{

  const b=activeBatch_(batchId);ensureRecovered_(load_());

  if(b.validation!==validation||!['READY','PAUSED'].includes(b.state)||JSON.parse(b.progress).cursor!==0)fail_('CONFLICT: Preview or progress changed. Reload batch status.');

  if(!Array.isArray(indices)||indices.length>5000||new Set(indices).size!==indices.length||indices.some(i=>!Number.isInteger(i)||i<0||i>=Number(b.rowCount)))fail_('IMPORT: Invalid selection.');

  const rows=readImportRows_(b,0,Number(b.rowCount));if(indices.some(i=>!rows[i].result||!['ACCEPTED','SUSPECT'].includes(rows[i].result.status)))fail_('IMPORT: Select only accepted or suspected-duplicate rows.');

  return batchView_(updateBatch_(b,{selection:JSON.stringify(indices.slice().sort((a,b)=>a-b)),state:'READY'}),0);

},true,true);}

function apiImportPause(batchId){return guard_(()=>{const b=activeBatch_(batchId);ensureRecovered_(load_());if(b.state==='COMPLETED')return batchView_(b,0);if(!['READY','IMPORTING','PAUSED'].includes(b.state))fail_('IMPORT: Validate the batch first.');return batchView_(updateBatch_(b,{state:'PAUSED'}),0);},true,true);}

function apiImportBatchCommit(batchId,validation){return guard_(()=>{

  let b=activeBatch_(batchId);if(b.validation!==validation)fail_('CONFLICT: Preview changed. Reload batch status.');

  const pending=table_('Operations').records.find(op=>op.kind==='IMPORT_BATCH'&&op.state!=='DONE'&&op.state!=='CANCELLED'&&JSON.parse(op.payload).some(c=>c.entity==='ImportBatches'&&c.after.id===b.id));

  if(pending){applyOperation_(pending);return batchView_(finishImport_(importBatch_(batchId)),0);}

  if(!['READY','IMPORTING','PAUSED','COMPLETED'].includes(b.state))fail_('IMPORT: Validate the batch first.');

  if(b.state==='COMPLETED')return batchView_(b,0);

  const db=load_(),selection=JSON.parse(b.selection),progress=JSON.parse(b.progress);

  if(!selection.length)fail_('IMPORT: Select at least one row.');

  if(progress.cursor>=selection.length)return batchView_(finishImport_(b),0);

  const opId='import-'+hash_(b.id+'|'+validation+'|'+progress.cursor),prior=table_('Operations').byId.get(opId);

  if(prior){if(prior[0].record.state!=='DONE')applyOperation_(prior[0].record);return batchView_(finishImport_(importBatch_(batchId)),0);}

  ensureRecovered_(db);if(review_(db).some(x=>x.severity==='ERROR'))fail_('REVIEW: Invalid financial records block import.');

  const mappings=JSON.parse(b.mappings),selected=selection.slice(progress.cursor,progress.cursor+20),rows=selectedImportRows_(b,selected);

  const preview=previewRows_(rows.map(x=>x.source),mappings,db);

  preview.results.forEach((r,j)=>{if(r.status==='REJECTED')fail_('CONFLICT: Row '+(selected[j]+1)+' is no longer valid: '+r.reason);if(r.status==='SUSPECT'&&rows[j].result.status!=='SUSPECT')fail_('CONFLICT: Matching content appeared after preview. Validate the batch again.');});

  let size=selected.length,changes,imported;

  while(size){const built=importChanges_(preview.results.slice(0,size),db);changes=built.changes;imported=built.imported;

    const next={cursor:progress.cursor+size,imported:progress.imported+imported};

    changes.push({entity:'ImportBatches',partial:true,before:{id:b.id,progress:b.progress,state:b.state},after:{id:b.id,progress:JSON.stringify(next),state:'IMPORTING'}});

    if(JSON.stringify(changes).length<=42000)break;size--;}

  if(!size)fail_('LIMIT: A source row is too large to journal. Shorten its description.');

  commit_(db,changes,opId,'IMPORT_BATCH');props_().setProperty('SYNC_DIRTY','true');

  return batchView_(finishImport_(importBatch_(batchId)),0);

});}

function importChanges_(results,db){

  const changes=[],statements=new Map(db.Statements.map(s=>[s.accountId+'|'+s.statementDate,s]));let imported=0;

  results.forEach(r=>{if(r.status==='SKIPPED')return;let statementId='';

    if(r.source['Statement Date']){

      const key=r.transaction.accountId+'|'+r.source['Statement Date'];let s=statements.get(key);

      if(!s){s=meta_({accountId:r.transaction.accountId,statementDate:r.source['Statement Date'],periodStart:'',periodEnd:'',dueDate:r.source['Payment Due Date'],balanceMinor:'',minimumMinor:'',currency:r.transaction.currency,status:'OPEN',reconciliation:'UNVERIFIED',calendarMode:'OFF',calendarId:'',eventId:'',syncedAt:'',fingerprint:'',syncError:'',attempts:0,nextRetry:''});statements.set(key,s);changes.push({entity:'Statements',before:null,after:s});}

      else if(r.source['Payment Due Date']&&s.dueDate!==r.source['Payment Due Date'])fail_('IMPORT: Conflicting statement due dates. Correct mapping or source.');statementId=s.id;

    }

    changes.push({entity:'Transactions',before:null,after:meta_(Object.assign({},r.transaction,{statementId}))});imported++;

  });

  changes.push({entity:'ImportHistory',before:null,after:meta_({sourceHash:results.length?results[0].source['Source Hash']:'',outcome:'COMMITTED',accepted:imported,rejected:0,suspect:results.filter(r=>r.status==='SUSPECT').length,skipped:results.length-imported,summary:'Staged import; classifications and official balances require review.'})});

  const working=domainClone_(db);changes.forEach(c=>working[c.entity].push(c.after));if(review_(working).some(x=>x.severity==='ERROR'))fail_('REVIEW: Selected rows violate financial validation.');

  return {changes,imported};

}
