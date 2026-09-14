'use strict';
function createRecordClient(send, options = {}) {
  const reads = new Set(['apiBootstrap', 'apiList', 'apiImportLookups', 'apiPackageReceipt', 'apiInstallmentSchedule']);
  const pending = [];
  const shared = new Map();
  const pause = options.pause || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const exclusive = options.exclusive || (fn => fn());
  let running = false;
  let generation = 0;

  async function pump() {
    if (running) return;
    running = true;
    while (pending.length) {
      const item = pending.shift();
      try {
        const value = await exclusive(async () => {
          for (let attempt = 0; ; attempt++) {
            if (!item.guards.some(keep => keep())) {
              if (item.key && shared.get(item.key) === item) shared.delete(item.key);
              return null;
            }
            try { return await send(item.payload); }
            catch (error) {
              if (!item.read || error.code !== 'BUSY' || attempt >= 2) throw error;
              await pause(750 * (attempt + 1) + Math.floor(Math.random() * 250));
            }
          }
        });
        item.resolve(value);
      } catch (error) { item.reject(error); }
      finally { if (item.key && shared.get(item.key) === item) shared.delete(item.key); }
    }
    running = false;
  }

  function call(name, args = [], keep = () => true) {
    const read = reads.has(name);
    const payload = JSON.stringify({ action: name, args });
    if (!read) generation++;
    const key = read ? generation + ':' + payload : null;
    const existing = key && shared.get(key);
    if (existing) { existing.guards.push(keep); return existing.promise; }
    if (pending.length >= 40) return Promise.reject(new Error('Wait for the current record operation to finish.'));
    const item = { payload, key, read, guards: [keep] };
    item.promise = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject; });
    if (key) shared.set(key, item);
    pending.push(item);
    void pump();
    return item.promise;
  }
  call.version = () => generation;
  return call;
}

function createTransactionDrafts() {
  const drafts = new Map();
  const references = new Map();
  const fields = row => ({ type: row.type, reviewStatus: row.reviewStatus, tags: String(row.tags || '') });
  function track(row) {
    if (!references.has(row.id)) references.set(row.id, new Set());
    references.get(row.id).add(row);
    return drafts.get(row.id)?.value || fields(row);
  }
  function stage(row, value) {
    const original = drafts.get(row.id)?.original || JSON.parse(JSON.stringify(row));
    const next = fields(value);
    if (JSON.stringify(next) === JSON.stringify(fields(original))) drafts.delete(row.id);
    else drafts.set(row.id, { original, value: next });
  }
  function accept(rows) {
    for (const row of rows) {
      for (const reference of references.get(row.id) || []) Object.assign(reference, row);
      drafts.delete(row.id);
    }
  }
  function batches() {
    const groups = []; let group = [], size = 0;
    for (const [id, draft] of drafts) {
      const estimate = 2 * JSON.stringify(draft.original).length + JSON.stringify(draft.value).length + 1800;
      if (group.length && (group.length >= 10 || size + estimate > 32000)) { groups.push(group); group = []; size = 0; }
      group.push({ id, token: draft.original._token, ...draft.value }); size += estimate;
    }
    if (group.length) groups.push(group);
    return groups;
  }
  return { track, stage, accept, batches, size: () => drafts.size, has: id => drafts.has(id), clear: () => drafts.clear(), tags: () => [...drafts.values()].flatMap(d => d.value.tags.split(',').map(t => t.trim()).filter(Boolean)) };
}

(() => {
  const $=id=>document.getElementById(id);
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const append=(p,...children)=>{children.filter(Boolean).forEach(c=>p.append(c));return p;};
  const button=(text,fn,cls='secondary')=>{const b=el('button',cls,configured('button.'+text,text));b.type='button';b.addEventListener('click',fn);return b;};
  const uuid=()=>crypto.randomUUID();
  const state={boot:null,area:'Overview',entity:'Transactions',filters:{},sort:'updatedAt:desc',page:0,sequence:0,selected:null};
  const areas={Overview:[],Transactions:['Transactions'],'Cards and Accounts':['Accounts','Cards'],Statements:['Statements'],'Bank Payments':['BankPayments','PaymentAllocations'],'Money Owed':['Shares'],People:['People'],Repayments:['Repayments'],Installments:['InstallmentPlans'],'Saved Views':['SavedViews'],Review:[],'Settings and Integration':[],Configuration:['Labels','ReportConfig']};
  const labels={reviewAction:'Classify and review',BankPayments:'Bank payments',PaymentAllocations:'Payment allocations',Shares:'Money owed',InstallmentPlans:'Installment plans',SavedViews:'Saved views',amountMinor:'Amount',balanceMinor:'Official balance',minimumMinor:'Minimum due',monthlyMinor:'Monthly amount',lastFour:'Last four digits',requestStatus:'Request status',calendarMode:'Calendar reminders',reconciliation:'Payment information',remainingMinor:'Remaining',cashMinor:'Cash received',creditMinor:'Credits / waivers',paidMinor:'Allocated payment',minimumRemainingMinor:'Minimum remaining',postedCount:'Posted installments'};
  const configured=(key,fallback)=>state.boot?.configuration?.labels[key]??fallback;
  const label=k=>configured('field.'+k,labels[k]||k.replace(/([A-Z])/g,' $1').trim().replace(/^./,s=>s.toUpperCase()));
  const refs={accountId:'Accounts',cardId:'Cards',statementId:'Statements',paymentId:'BankPayments',transactionId:'Transactions',personId:'People',shareId:'Shares',installmentPlanId:'InstallmentPlans',replacesCardId:'Cards',originTransactionId:'Transactions',matchedTransactionId:'Transactions'};
  const technical=new Set(['calendarId','eventId','syncedAt','fingerprint','syncError','attempts','nextRetry','sourceKey','sourceRef']);
  const displays={Labels:['key','value'],ReportConfig:['key','value'],Accounts:['nickname','bank','currency','status'],Cards:['nickname','accountId','lastFour','relationship','status'],Transactions:['description','transactionDate','amountMinor','currency','type','reviewStatus','reviewAction'],Statements:['accountId','statementDate','dueDate','balanceMinor','paidMinor','remainingMinor','settlement','calendarMode'],BankPayments:['accountId','date','amountMinor','currency','status'],PaymentAllocations:['paymentId','statementId','amountMinor','status'],People:['name','contact','status'],Shares:['personId','transactionId','amountMinor','remainingMinor','requestStatus','settlement'],Repayments:['shareId','date','amountMinor','currency','type','status'],InstallmentPlans:['reference','accountId','count','postedCount','status'],SavedViews:['name','scope','status']};
  const dateBases={Transactions:['transactionDate','postingDate'],Statements:['statementDate','dueDate'],Shares:['transactionDate','expectedDate','requestDate'],BankPayments:['date'],Repayments:['date']};
  const navigationDescriptions={Overview:'Activity, statements and personal collections, each with its own ledger.',Transactions:'Review activity, add tags and assign purchases to people.',Statements:'Official balances, billing dates and confirmed allocations.','Money Owed':'Track requests, partial repayments and agreed credits independently.','Settings and Integration':'Manage configuration, Calendar reminders and recovery.'};
  const typeGuide={
    PURCHASE:['Purchase','Goods or services charged to the card.','Positive amount; included in classified spending.'],
    FEE:['Fee','Annual, late-payment, service or other bank fees.','Positive amount; included in classified spending.'],
    INTEREST:['Interest','Finance charges or interest billed by the bank.','Positive amount; included in classified spending.'],
    CASH_ADVANCE:['Cash advance','Cash withdrawn or borrowed against the credit card.','Positive amount; included in classified spending.'],
    BANK_PAYMENT:['Bank payment','A payment you made to the card issuer.','Negative transaction amount; link it to a statement payment allocation.'],
    REFUND:['Refund','A merchant return or purchase reversal credited by the bank.','Negative credit; retained separately from gross spending.'],
    REBATE:['Rebate / cashback','Cashback, rewards or promotional credits.','Negative credit; retained separately from gross spending.'],
    TRANSFER:['Transfer','Movement between accounts or balances.','Signed activity; kept separate from classified spending.'],
    ADJUSTMENT:['Adjustment','A bank correction requiring its own classification.','Signed correction; kept separate from classified spending.'],
    INSTALLMENT:['Installment charge','One monthly installment actually posted on the statement.','Positive amount; included once in classified spending.'],
    FINANCED_PRINCIPAL:['Financed principal','Original purchase converted into an installment plan.','Tracked separately; monthly installment charges represent spending.'],
    UNKNOWN:['Needs classification','Use while the purpose of an entry is still uncertain.','Included in the review count until a type is selected.']
  };
  const iconPaths={
    Overview:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    Transactions:'M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5',
    'Cards and Accounts':'M3 5h18v14H3z M3 9h18 M6 15h4',
    Statements:'M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h7',
    'Bank Payments':'M3 8l9-5 9 5z M5 10v8 M10 10v8 M15 10v8 M20 10v8 M3 21h18',
    'Money Owed':'M4 7h16v12H4z M2 10h20 M9 14h6',
    People:'M9 11a4 4 0 1 0 0-8a4 4 0 0 0 0 8 M2 21v-3a7 7 0 0 1 14 0v3 M17 5a4 4 0 0 1 0 8 M19 16a6 6 0 0 1 3 5',
    Repayments:'M4 8h15l-4-4 M20 16H5l4 4 M19 8l-4 4 M5 16l4-4',
    Installments:'M4 5h16v16H4z M8 2v6 M16 2v6 M4 10h16 M8 14h2 M14 14h2 M8 18h2',
    'Saved Views':'M6 3h12v18l-6-4-6 4z',
    Review:'M12 3l10 18H2z M12 9v5 M12 17v1',
    'Settings and Integration':'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
    Configuration:'M4 4h16v16H4z M4 10h16 M10 10v10',
    collapse:'M14 5l-7 7 7 7',expand:'M9 5l7 7-7 7',logout:'M10 4H4v16h6 M12 12h9 M17 8l4 4-4 4'
  };
  function icon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS(svg.namespaceURI,'path');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.7');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');svg.classList.add('nav-icon');path.setAttribute('d',iconPaths[name]||iconPaths.Overview);svg.append(path);return svg;}
  function setupSidebar(){
    const toggle=$('nav-toggle');
    toggle.addEventListener('click',()=>{const open=toggle.getAttribute('aria-expanded')!=='true';toggle.setAttribute('aria-expanded',String(open));document.querySelector('.navigation').classList.toggle('menu-open',open);});
    $('nav').addEventListener('keydown',e=>{if(e.key==='Escape'){toggle.setAttribute('aria-expanded','false');document.querySelector('.navigation').classList.remove('menu-open');toggle.focus();}});
    $('close-context').addEventListener('click',()=>$('context-drawer').close());
  }
  function showTypeGuide(){const box=el('div','type-guide');for(const [key,[name,meaning,effect]] of Object.entries(typeGuide)){const section=el('section');append(section,el('h3','',name+' ('+key+')'),el('p','',meaning),el('p','subtle',effect));box.append(section);}openDialog('Transaction types and reporting',box);}
  function typeOptions(){return (state.boot.enums['Transactions.type']||[]).map(id=>({id,label:typeGuide[id]?.[0]||label(id)}));}
  function applyWorkflowResult(result){
    if(result.overview)state.boot.overview=result.overview;
    if(result.issues)state.boot.issues=result.issues;
    if(result.tagOptions)state.boot.tagOptions=result.tagOptions;
    if(result.paymentSources)state.boot.paymentSources=result.paymentSources;
    renderContext();
  }
  const transactionDrafts=createTransactionDrafts();
  const reviewBindings=new Set();
  let reviewSaving=false,reviewJob=null,reviewMessage='';
  function tagPicker(value='',staged=false){
    const wrap=el('div','tag-picker'),chips=el('div','tag-chips'),choose=select([], '',false),newName=input(''),add=button('Add tag',()=>{}),creator=el('div','tag-creator'),error=el('small','field-error');
    let chosen=String(value||'').split(',').map(s=>s.trim()).filter(Boolean);
    choose.setAttribute('aria-label','Select a tag');newName.placeholder='New tag name';newName.maxLength=60;newName.setAttribute('aria-label','New tag name');creator.hidden=true;
    const draw=()=>{chips.replaceChildren();chosen.forEach(name=>{const remove=button(name+' x',()=>{chosen=chosen.filter(t=>t!==name);draw();wrap.dispatchEvent(new Event('change',{bubbles:true}));},'tag-chip');remove.setAttribute('aria-label','Remove tag '+name);chips.append(remove);});choose.replaceChildren(new Option('Select a tag...',''));const values=[...new Set([...(state.boot.tagOptions||[]),...(staged?transactionDrafts.tags():[]),...chosen])].sort((a,b)=>a.localeCompare(b));values.forEach(t=>{if(!chosen.some(v=>v.toLowerCase()===t.toLowerCase()))choose.append(new Option(t,t));});choose.append(new Option('+ Add new tag','__new_tag__'));};
    choose.addEventListener('change',()=>{if(choose.value==='__new_tag__'){creator.hidden=false;newName.focus();choose.value='';return;}if(choose.value){chosen.push(choose.value);draw();wrap.dispatchEvent(new Event('change',{bubbles:true}));}});
    add.addEventListener('click',async()=>{error.textContent='';const name=newName.value.trim();if(!name)return;add.disabled=true;try{if(!name||name.length>60||/[,\r\n\x00-\x1f]/.test(name))throw Error('Enter a tag of 1 to 60 characters without commas or line breaks.');let options=[...(state.boot.tagOptions||[]),...transactionDrafts.tags()];if(!staged){if(!state.boot.workflowRevision)throw Error('Install the Cardbills backend update to save new tags.');const r=await rpc('apiSave','TagOption',{name},'',uuid());state.boot.tagOptions=r.tagOptions;options=r.tagOptions;}const stored=options.find(t=>t.toLowerCase()===name.toLowerCase())||name;if(!chosen.some(t=>t.toLowerCase()===stored.toLowerCase()))chosen.push(stored);newName.value='';creator.hidden=true;draw();wrap.dispatchEvent(new Event('change',{bubbles:true}));}catch(e){error.textContent=e.message;}finally{add.disabled=false;}});
    append(creator,newName,add);append(wrap,chips,choose,creator,error);Object.defineProperty(wrap,'value',{get:()=>chosen.join(', '),set:value=>{chosen=String(value||'').split(',').map(t=>t.trim()).filter(Boolean);draw();}});draw();return wrap;
  }
  function updateReviewControls(){
    for(const binding of reviewBindings){
      if(!binding.box.isConnected){reviewBindings.delete(binding);continue;}
      const value=transactionDrafts.track(binding.row);
      binding.type.value=value.type;binding.review.value=value.reviewStatus;binding.tags.value=value.tags;
      binding.help.textContent=typeGuide[value.type]?.[2]||'';
      binding.status.textContent=transactionDrafts.has(binding.row.id)?'Pending - use Save changes below.':'';
      binding.box.querySelectorAll('button,input,select').forEach(node=>node.disabled=reviewSaving||!!reviewJob);
    }
  }
  function updateReviewFooter(){
    const bar=$('review-save-bar');if(!bar)return;
    const count=transactionDrafts.size();
    bar.hidden=state.area!=='Transactions'&&!count&&!reviewSaving;
    $('review-save-count').textContent=count?count+' transaction'+(count===1?'':'s')+' pending':'';
    $('review-save-status').textContent=reviewMessage;
    $('review-save-feedback').hidden=!count&&!reviewMessage;
    $('review-save-count').hidden=!count;
    $('review-save-status').hidden=!reviewMessage;
    $('save-review-changes').textContent=reviewSaving?'Saving...':reviewJob?'Retry save':'Save changes';
    $('save-review-changes').disabled=reviewSaving||!count;
    $('discard-review-changes').disabled=reviewSaving||!count;
    updateReviewControls();
  }
  function transactionControls(r){
    const value=transactionDrafts.track(r),box=el('div','quick-review'),type=select(typeOptions(),value.type,false),review=select([{id:'REVIEW',label:'Needs verification'},{id:'VERIFIED',label:'Verified'},{id:'DUPLICATE_CANDIDATE',label:'Check possible duplicate'}],value.reviewStatus,false),tags=tagPicker(value.tags,true),help=el('p','subtle'),status=el('p','field-status');
    box.dataset.reviewId=r.id;
    type.setAttribute('aria-label','Transaction type for '+r.description);review.setAttribute('aria-label','Review status for '+r.description);
    help.textContent=typeGuide[type.value]?.[2]||'';
    const stage=()=>{if(reviewSaving||reviewJob)return;transactionDrafts.stage(r,{type:type.value,reviewStatus:review.value,tags:tags.value});reviewMessage='';updateReviewFooter();};
    type.addEventListener('change',stage);review.addEventListener('change',stage);tags.addEventListener('change',stage);
    append(box,field('Transaction type',type),help,field('Review status',review),field('Tags',tags),status);
    reviewBindings.add({box,row:r,type,review,tags,help,status});
    box.querySelectorAll('button,input,select').forEach(node=>node.disabled=reviewSaving||!!reviewJob);
    status.textContent=transactionDrafts.has(r.id)?'Pending - use Save changes below.':'';
    return box;
  }
  function applyReviewRows(rows){
    transactionDrafts.accept(rows);
    for(const row of rows){
      for(const list of [state.pageResult?.rows,state.boot?.overview?.recent,state.boot?.lookups?.Transactions])for(const existing of list||[])if(existing.id===row.id)Object.assign(existing,row);
      if(state.selected?.id===row.id)Object.assign(state.selected,row);
    }
    document.querySelectorAll('[data-review-id]').forEach(box=>{
      const row=rows.find(r=>r.id===box.dataset.reviewId),tr=box.closest('tr');
      if(row&&tr){tr.querySelector('[data-field=type]')?.replaceChildren(el('span','badge',row.type));tr.querySelector('[data-field=reviewStatus]')?.replaceChildren(el('span','badge',row.reviewStatus));}
    });
  }
  async function saveReviewChanges(){
    if(reviewSaving||!transactionDrafts.size())return;
    if(!state.boot.reviewBatchRevision){reviewMessage='Install the bottom-save Workspace.gs update and deploy it, then Refresh data. Your selections stay pending.';updateReviewFooter();return;}
    if(!reviewJob)reviewJob={groups:transactionDrafts.batches().map(items=>({items,id:uuid()})),cursor:0,total:transactionDrafts.size(),saved:0};
    reviewSaving=true;reviewMessage='Saving pending classifications...';updateReviewFooter();
    try{
      while(reviewJob.cursor<reviewJob.groups.length){
        const group=reviewJob.groups[reviewJob.cursor],last=reviewJob.cursor===reviewJob.groups.length-1;
        const result=await rpc('apiSave','TransactionReviewBatch',{items:group.items,includeSummary:last},'',group.id);
        if(!Array.isArray(result.rows)||result.rows.length!==group.items.length||group.items.some(item=>!result.rows.some(row=>row.id===item.id)))throw Error('The save receipt needs a status check. Retry the same save.');
        applyReviewRows(result.rows);reviewJob.saved+=group.items.length;reviewJob.cursor++;
        if(last)applyWorkflowResult(result);
        reviewMessage='Saved '+reviewJob.saved+' of '+reviewJob.total+' transactions.';updateReviewFooter();
      }
      reviewMessage='Saved '+reviewJob.total+' transaction'+(reviewJob.total===1?'':'s')+'. Overview updated.';reviewJob=null;
      if(state.area==='Overview'){const scroll=$('main').scrollTop;$('content').replaceChildren();renderOverview();$('main').scrollTop=scroll;}
    }catch(error){
      reviewMessage=error.message+' Pending selections are retained.';
      if(/^(VALIDATION|CONFLICT|LIMIT):/.test(error.message))reviewJob=null;
      else reviewMessage+=' Use Retry save to check the same batch.';
    }finally{reviewSaving=false;updateReviewFooter();}
  }
  function setupReviewFooter(){
    $('save-review-changes').addEventListener('click',saveReviewChanges);
    $('discard-review-changes').addEventListener('click',()=>{
      if(reviewSaving||!transactionDrafts.size())return;
      if(!confirm('Discard pending transaction selections? Earlier successful saves remain recorded.'))return;
      const uncertain=!!reviewJob;transactionDrafts.clear();reviewJob=null;reviewMessage='Pending selections discarded.';updateReviewFooter();
      if(uncertain)action(refresh);
    });
    window.addEventListener('beforeunload',event=>{if(transactionDrafts.size()){event.preventDefault();event.returnValue='';}});
    $('sign-out').addEventListener('click',event=>{if(transactionDrafts.size()&&(reviewSaving||!confirm('Sign out and discard pending transaction selections?'))){event.preventDefault();event.stopImmediatePropagation();}},true);
  }
  function statementPaymentLabel(r){if(r.balanceMinor===''||r.balanceMinor==null)return 'Balance needed';if(Number(r.balanceMinor)<=0)return 'No payment due';if(r.settlement==='SETTLED')return 'Paid in full';if(r.settlement==='PARTIAL')return 'Partially paid';return r.reconciliation==='VERIFIED'?'No payment recorded':'Payment review needed';}
  function statementPaymentPicker(r){
    const chosen=select([{id:'',label:statementPaymentLabel(r)},{id:'FULL',label:'Record full payment...'},{id:'PARTIAL',label:'Record partial payment...'},{id:'VERIFY_UNPAID',label:'Confirm no payment recorded...'},{id:'VERIFY_NO_DUE',label:'Confirm zero / credit balance...'},{id:'REVIEW',label:'Mark payment information for review...'}],'',false);
    chosen.className='statement-payment-select';chosen.setAttribute('aria-label','Payment status for statement '+r.statementDate);
    chosen.addEventListener('change',()=>{const mode=chosen.value;chosen.value='';if(mode)showStatementPayment(r,mode);});return chosen;
  }
  function showStatementPayment(r,initial='FULL'){
    const form=el('form','payment-form'),mode=select([{id:'FULL',label:'Paid in full'},{id:'PARTIAL',label:'Partially paid'},{id:'VERIFY_UNPAID',label:'No payment recorded'},{id:'VERIFY_NO_DUE',label:'No payment due (zero / credit balance)'},{id:'REVIEW',label:'Payment information needs review'}],initial,false),sources=state.boot.paymentSources||{payments:[],transactions:[]};
    const source=select([{id:'NEW',label:'Record a new bank payment'},...sources.payments.filter(p=>p.accountId===r.accountId&&p.currency===r.currency&&p.availableMinor>0).map(p=>({id:'PAYMENT:'+p.id,label:'Existing payment '+p.date+' | '+money(p.availableMinor,p.currency)+' available'})),...sources.transactions.filter(t=>t.accountId===r.accountId&&t.currency===r.currency).map(t=>({id:'TRANSACTION:'+t.id,label:'Imported credit '+t.date+' | '+money(t.amountMinor,t.currency)}))],'NEW',false),amount=input(r.remainingMinor===''?'':decimal(r.remainingMinor,r.currency)),date=input('','date'),reference=input(''),help=el('p','subtle'),fields=el('div','form-grid'),confirm=input('','checkbox'),save=button('Save payment information',()=>{}),status=el('p','field-status');
    date.max=state.boot.today;save.type='submit';confirm.required=true;confirm.setAttribute('aria-label','Confirm the payment information');amount.inputMode='decimal';
    append(form,el('p','','Statement: '+lookup('Accounts',r.accountId)+' | '+r.statementDate),el('p','','Billed: '+money(r.balanceMinor,r.currency)+' | Confirmed allocations: '+money(r.paidMinor,r.currency)+' | Remaining: '+money(r.remainingMinor,r.currency)),field('Payment status',mode),help);
    append(fields,field('Payment source',source),field('Amount of this payment',amount),field('Actual payment date',date),field('Payment reference',reference));
    append(form,fields,append(el('label','check-label'),confirm,document.createTextNode('I confirm these payment details against my records.')),status,append(el('div','form-actions'),button('Cancel',()=>$('dialog').close()),save));
    const update=()=>{const paying=['FULL','PARTIAL'].includes(mode.value),[kind,id]=source.value.split(':'),existing=kind==='PAYMENT'?sources.payments.find(p=>p.id===id):kind==='TRANSACTION'?sources.transactions.find(t=>t.id===id):null;
      fields.hidden=!paying;amount.required=date.required=paying;amount.readOnly=mode.value==='FULL';date.disabled=!!existing;date.value=existing?existing.date:date.value;source.disabled=!paying;if(mode.value==='FULL')amount.value=r.remainingMinor===''?'':decimal(r.remainingMinor,r.currency);
      help.textContent=mode.value==='FULL'?'Records the remaining amount as a confirmed allocation. Enter when you actually paid.':mode.value==='PARTIAL'?'Enter this additional payment amount. Confirmed allocations determine the remaining balance.':mode.value==='VERIFY_UNPAID'?'Confirms payment information after checking that no allocations exist.':mode.value==='VERIFY_NO_DUE'?'Confirms a known zero or credit statement balance.': 'Keeps the payment ledger and marks its information for review.';
    };mode.addEventListener('change',update);source.addEventListener('change',()=>{date.value='';update();});update();
    let requestId=uuid(),pendingSignature='';
    form.addEventListener('submit',async event=>{event.preventDefault();save.disabled=true;status.textContent='Saving payment information...';try{
      if(!state.boot.workflowRevision)throw Error('Install the Cardbills backend update to use statement payment shortcuts.');
      const [kind,id]=source.value.split(':'),paying=['FULL','PARTIAL'].includes(mode.value),data={statementId:r.id,mode:mode.value,source:kind,paymentId:kind==='PAYMENT'?id:'',transactionId:kind==='TRANSACTION'?id:'',amountMinor:paying?toMinor(amount.value,r.currency):0,date:date.value,reference:reference.value};
      const signature=JSON.stringify(data);if(pendingSignature&&pendingSignature!==signature)requestId=uuid();pendingSignature=signature;
      const result=await rpc('apiSave','StatementPayment',data,r._token,requestId);Object.assign(r,result.row);applyWorkflowResult(result);$('dialog').close();const cached=state.pageEntity===state.entity?state.pageResult:null;if(cached)cached.rows=cached.rows.map(x=>x.id===r.id?r:x);await render(cached);notice('Payment information saved. Confirmed allocations determine settlement.');
    }catch(error){status.textContent=error.message;}finally{save.disabled=false;}});openDialog('Statement payment',form);
  }
  async function synchronizeStatements(){
    await action(async()=>{let result;for(let i=0;i<40;i++){notice('Synchronizing statement events...', 'loading');result=await rpc('apiSync');if(result.failed||!result.remaining)break;await new Promise(resolve=>setTimeout(resolve,500));}await refresh();notice(result.message||'Synchronization completed.',result.failed?'error':'');});
  }
  setupSidebar();setupReviewFooter();

  function notice(text,kind=''){const n=$('notice');n.replaceChildren();if(text)n.append(el('div','notice '+kind,text));}
  const sendRpc=async payload=>{
    const response=await fetch('/api/rpc',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:payload});
    if(response.status===401){location.replace('/login.html');throw Error('Sign in to continue.');}
    const result=await response.json();
    if(!response.ok){const error=Error(result.error||'The request could not be completed.');if(/^BUSY:/.test(result.error||''))error.code='BUSY';throw error;}
    return result.data;
  };
  const recordClient=createRecordClient(sendRpc,{exclusive:fn=>navigator.locks?navigator.locks.request('cardbills-record-request',fn):fn()});
  function rpc(name,...args){return name==='apiBackup'&&state.boot?.storage==='supabase'?sendRpc(JSON.stringify({action:name,args})):recordClient(name,args);}

  async function action(fn){try{return await fn();}catch(e){notice(e.message,'error');if(!state.boot)$('content').replaceChildren(el('div','empty','Workspace could not load. Correct the error above, then select Refresh data.'));return null;}}
  function money(n,c){if(n===''||n===null||n===undefined)return 'Unknown';const p=state.boot?.currencies[c]??2;return (Number(n)/10**p).toLocaleString(undefined,{minimumFractionDigits:p,maximumFractionDigits:p})+(c?' '+c:'');}
  function decimal(n,c){if(n===''||n===null||n===undefined)return '';const p=state.boot.currencies[c];return (Number(n)/10**p).toFixed(p);}
  function toMinor(s,c){if(s==='')return '';const p=state.boot.currencies[c];if(p===undefined)throw Error('Choose a confirmed currency.');if(!/^-?\d+(\.\d+)?$/.test(s.trim()))throw Error('Enter amount without commas.');const [a,b='']=s.trim().replace('-','').split('.');if(b.length>p)throw Error('Too many decimal places for '+c);const n=Number(a)*10**p+Number(b.padEnd(p,'0'));if(!Number.isSafeInteger(n)||n>1e12)throw Error('Amount is too large.');return s.trim().startsWith('-')?-n:n;}
  function lookup(type,id){return (state.boot.lookups[type]||[]).find(x=>x.id===id)?.label||id||'—';}
  function display(r,k){if(refs[k])return lookup(refs[k],r[k]);if(/Minor$/.test(k))return money(r[k],r.currency||currencyFor(r));if(r[k]==='')return '—';return String(r[k]??'—');}
  function currencyFor(r){return (state.boot.lookups.BankPayments||[]).find(x=>x.id===r.paymentId)?.currency||(state.boot.lookups.Shares||[]).find(x=>x.id===r.shareId)?.currency||'';}
  function field(name,control,hint){const custom=control.classList.contains('tag-picker'),l=custom?append(el('div','field'),el('span','field-label',label(name))):el('label','',label(name));control.name=name;l.append(control);if(hint)l.append(el('small','',hint));return l;}
  function input(value='',type='text'){const n=el('input');n.type=type;n.value=value;return n;}
  function select(options,value='',empty=true){const n=el('select');if(empty)n.append(new Option('Select…',''));options.forEach(o=>n.append(new Option(typeof o==='string'?label(o):o.label,typeof o==='string'?o:o.id)));n.value=value;return n;}
  let dialogOpener=null;
  function openDialog(title,content){if(!$('dialog').open)dialogOpener=document.activeElement;$('dialog-title').textContent=title;$('dialog-content').replaceChildren(content);$('dialog-error').textContent='';if(!$('dialog').open)$('dialog').showModal();setTimeout(()=>$('dialog-content').querySelector('input,select,textarea,button')?.focus(),0);}
  $('close-dialog').addEventListener('click',()=>$('dialog').close());
  $('dialog').addEventListener('close',()=>{if(dialogOpener?.isConnected)dialogOpener.focus();});
  $('dialog').addEventListener('keydown',e=>{if(e.key!=='Tab')return;const nodes=[...$('dialog').querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')].filter(n=>n.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}});
  function navigate(area,entity,filters={}){$('context-drawer').close();$('nav-toggle').setAttribute('aria-expanded','false');document.querySelector('.navigation').classList.remove('menu-open');state.area=area;state.entity=entity||areas[area][0]||'';state.filters=area==='Money Owed'?Object.assign({status:'ACTIVE'},filters):filters;state.page=0;state.selected=null;state.sort='updatedAt:desc';renderNav();$('title').textContent=areaName(area);$('title').focus({preventScroll:true});action(render);}
  const navigationGroups={Overview:['Overview'],Activity:['Transactions','Review','Saved Views'],Accounts:['Cards and Accounts','Statements','Bank Payments','Installments'],Collections:['Money Owed','People','Repayments'],Settings:['Settings and Integration','Configuration']};
  const areaName=area=>area==='Settings and Integration'?'Workspace and Backups':configured('nav.'+area,area);
  function renderNav(){
    const group=Object.keys(navigationGroups).find(k=>navigationGroups[k].includes(state.area))||'Overview';
    $('nav').replaceChildren();$('subnav').replaceChildren();
    Object.entries(navigationGroups).forEach(([name,items])=>{const b=button(name,()=>navigate(items[0]),'nav-item');if(name===group)b.setAttribute('aria-current','true');$('nav').append(b);});
    navigationGroups[group].forEach(area=>{const b=button(areaName(area),()=>navigate(area),'quiet');if(area===state.area)b.setAttribute('aria-current','page');$('subnav').append(b);});
  }
  let refreshPromise=null;
  function currentView(){return ['Overview','Review','Settings and Integration'].includes(state.area)?null:{entity:state.entity,filters:{...state.filters},page:state.page,sort:state.sort};}
  function refresh(){
    const version=recordClient.version();
    if(refreshPromise&&refreshPromise.version===version)return refreshPromise.promise;
    $('refresh').disabled=true;
    notice('Loading current records...', 'loading');
    const view=currentView(),viewKey=JSON.stringify(view),entry={version};
    entry.promise=(async()=>{
      const b=await rpc('apiBootstrap',view);
      if(version!==recordClient.version())return;
      state.boot=b;
      document.querySelector('.brand-title').textContent='Cardbills';document.title='Cardbills';
      $('refresh').textContent='Refresh';
      notice(b.overview.invalid?'Invalid records or pending operations need review. Financial overview totals are withheld.':'');
      renderNav();await render(viewKey===JSON.stringify(currentView())?b.currentPage:null);
    })().finally(()=>{if(refreshPromise===entry){refreshPromise=null;$('refresh').disabled=false;}});
    refreshPromise=entry;
    return entry.promise;
  }
  $('refresh').addEventListener('click',()=>action(refresh));
  async function render(prefetched){if(!state.boot)return;updateReviewFooter();const seq=++state.sequence;$('title').textContent=areaName(state.area);$('content').replaceChildren();renderContext();
    if(state.area==='Overview'){renderOverview();return;}
    if(state.area==='Review'){renderReview();return;}
    if(state.area==='Settings and Integration'){renderSettings();return;}
    renderToolbar();const container=el('div');$('content').append(container);container.append(el('div','empty','Loading records…'));
    try{const result=prefetched||await recordClient('apiList',[state.entity,state.filters,state.page,state.sort],()=>seq===state.sequence);if(seq!==state.sequence)return;container.replaceChildren();renderTable(container,result);}
    catch(e){if(seq===state.sequence){container.replaceChildren(el('div','empty',e.message));notice(e.message,'error');}}
  }
  function renderOverview(){const o=state.boot.overview,c=$('content');const intro=el('section','overview-intro');append(intro,el('h2','','Your finances, clearly organized.'),el('p','subtle','Track spending, manage balances and review what needs your attention.'),button('Review transactions',()=>navigate('Review'),'secondary'));c.append(intro);
    if(o.invalid)c.append(el('div','review-banner','Totals are unavailable until invalid records and pending operations are resolved. Open Review for details.'));
    const pending=Object.values(o.totals).reduce((n,t)=>n+(t.unclassifiedCount||0),0);if(pending)c.append(el('div','review-banner',pending+' entries await an activity type. Classify purchases, payments and credits in Transactions.'));
    const metrics=el('div','metrics');Object.entries(o.totals).forEach(([cur,t])=>{
      [['Classified spending',t.spendingMinor,'Transactions',{currency:cur,status:'ACTIVE',spending:'true'},'Charges only · posted installment basis'],['Money owed to you',t.owedMinor,'Money Owed',{currency:cur,status:'ACTIVE'},'Confirmed receipts and credits deducted'],[t.unknownStatements&&t.knownStatements?'Known statement remainder':'Statement remainder',t.statementRemainingMinor,'Statements',{currency:cur,status:'OPEN'},t.unknownStatements+' statements have unknown balances'],['Cash received',t.cashMinor,'Repayments',{currency:cur,status:'CONFIRMED',type:'CASH'},'Personal repayments only']].forEach(([title,n,area,filters,hint])=>{
        const b=button('',()=>navigate(area,undefined,filters),'metric');append(b,el('span','',title),el('strong','',money(n,cur)),el('span','',hint));metrics.append(b);
      });
    });if(metrics.childNodes.length)c.append(metrics);else if(!o.invalid){const e=el('div','empty');append(e,el('h2','','Your workspace is ready to begin'),el('p','','Start with a billing account and a masked card. Add statements from official bank records, or preview a sanitized transaction import.'),button('Add an account',()=>editRecord('Accounts')));c.append(e);}
    const activity=el('section','card');append(activity,el('h2','','Recorded spending by posting month'),el('p','subtle','Classified purchases, fees, interest, cash advances and installment charges. Select a month to inspect records.'));
    const bars=el('div','activity');const maxBy={};Object.entries(o.months).forEach(([k,n])=>{const cur=k.split(' ')[0];maxBy[cur]=Math.max(maxBy[cur]||1,n);});
    Object.entries(o.months).sort().slice(-12).forEach(([k,n])=>{const [cur,month]=k.split(' ');const b=button('',()=>{if(month==='Undated')navigate('Transactions',undefined,{currency:cur,dateBasis:'postingDate',spending:'true',undated:'true'});else{const end=new Date(Date.UTC(+month.slice(0,4),+month.slice(5,7),0)).toISOString().slice(0,10);navigate('Transactions',undefined,{currency:cur,dateBasis:'postingDate',from:month+'-01',to:end,status:'ACTIVE',spending:'true'});}},'');const line=el('span');append(line,el('span','',k),el('span','',money(n,cur)));const bar=el('div','bar');bar.style.width=Math.max(1,n/maxBy[cur]*100)+'%';append(b,line,bar);bars.append(b);});activity.append(bars.childNodes.length?bars:el('p','subtle','Choose transaction types to populate spending charts.'));c.append(activity);
    const recent=el('section','card');append(recent,el('h2','','Recent transactions'));simpleTable(recent,'Transactions',o.recent);c.append(recent);if(o.upcoming.length){const upcoming=el('section','card');append(upcoming,el('h2','','Upcoming statements'));o.upcoming.forEach(s=>upcoming.append(button(lookup('Accounts',s.accountId)+' · '+s.dueDate+' · '+money(s.remainingMinor,s.currency),()=>showDetails('Statements',s),'secondary')));c.append(upcoming);}
  }
  function renderContext(){const c=$('context');c.replaceChildren();append(c,el('p','eyebrow','AT A GLANCE'),el('h2','','Upcoming statements'));const o=state.boot.overview;
    o.upcoming.forEach(s=>{const d=el('div','upcoming');append(d,el('strong','',lookup('Accounts',s.accountId)),el('span','',s.dueDate+' · '+money(s.remainingMinor,s.currency)),el('p','subtle',s.reconciliation==='VERIFIED'?'Payment information verified':'Payment information unverified'));d.append(button('View statement',()=>showDetails('Statements',s),'quiet'));c.append(d);});
    if(!o.upcoming.length)c.append(el('p','subtle','No upcoming statements recorded.'));
    const note=el('div','context-note');append(note,el('strong','','Data freshness'),el('p','',o.freshness?'Latest recorded activity date: '+o.freshness:'No transactions imported.'),el('p','','Bank payments and personal repayments have separate histories.'));c.append(note);
  }
  function renderToolbar(){const c=$('content'),tabs=areas[state.area];if(tabs.length>1){const t=el('div','section-tabs');tabs.forEach(e=>t.append(button(label(e),()=>{state.entity=e;state.filters={};state.page=0;render();},e===state.entity?'active':'')));c.append(t);}
    const bar=el('div','toolbar'),search=input(state.filters.q||'','search');search.placeholder='Descriptions, names and notes';search.addEventListener('change',()=>{state.filters.q=search.value;state.page=0;render();});bar.append(field('Search',search));
    bar.append(button('Add '+label(state.entity).toLowerCase(),()=>editRecord(state.entity)));
    if(state.entity==='Transactions'){bar.append(button('Import CSV',showImport));bar.append(button('Import reviewed package',showPackageImport));bar.append(button('Type guide',showTypeGuide));}
    if(state.entity==='Shares')bar.append(button('Preview report',showReport));
    if(state.entity==='Statements')bar.append(button('Synchronize statement events',synchronizeStatements));
    c.append(bar);
    const more=el('details');more.open=Object.keys(state.filters).some(k=>k!=='q'&&state.filters[k]);more.append(el('summary','','Filters and sorting'));
    const f=el('div','filters');
    const choices={type:typeOptions(),tag:(state.boot.tagOptions||[]),currency:Object.keys(state.boot.currencies),status:state.boot.enums[state.entity+'.status']||[],requestStatus:state.boot.enums['Shares.requestStatus'],settlement:['OPEN','PARTIAL','SETTLED','UNKNOWN'],expectedState:['PAST_EXPECTED_DATE','NOT_PAST_EXPECTED_DATE']};
    const filterFields=['currency','status'];if(state.entity==='Transactions')filterFields.push('type');if(['Transactions','Shares'].includes(state.entity))filterFields.push('personId','tag');if(state.entity==='Shares')filterFields.push('requestStatus','settlement','expectedState');if(state.entity==='Statements')filterFields.push('settlement');
    filterFields.forEach(k=>{const n=k==='personId'?select(state.boot.lookups.People,state.filters[k]):choices[k]?select(choices[k],state.filters[k]):input(state.filters[k]||'');n.addEventListener('change',()=>{state.filters[k]=n.value;state.page=0;render();});f.append(field(k,n));});
    if(dateBases[state.entity]){const n=select(dateBases[state.entity],state.filters.dateBasis||dateBases[state.entity][0],false);n.addEventListener('change',()=>{state.filters.dateBasis=n.value;state.page=0;render();});f.append(field('dateBasis',n));['from','to'].forEach(k=>{const n=input(state.filters[k]||'','date');n.addEventListener('change',()=>{state.filters[k]=n.value;state.page=0;render();});f.append(field(k,n));});}
    const sort=select((displays[state.entity]||[]).flatMap(k=>[{id:k+':asc',label:label(k)+' ascending'},{id:k+':desc',label:label(k)+' descending'}]).concat([{id:'updatedAt:desc',label:'Recently updated'}]),state.sort,false);sort.addEventListener('change',()=>{state.sort=sort.value;render();});f.append(field('Sort',sort));
    append(more,f,button('Clear filters',()=>{state.filters={};state.page=0;render();}),['Transactions','Shares','Statements','BankPayments','Repayments'].includes(state.entity)?button('Save this view',()=>editRecord('SavedViews',{name:'',scope:state.entity,filters:JSON.stringify(state.filters),sort:state.sort,status:'ACTIVE'})):null);c.append(more);
  }
  function simpleTable(container,entity,rows){if(!rows.length){container.append(el('div','empty','No records to display.'));return;}const wrap=el('div','table-scroll');wrap.tabIndex=0;wrap.setAttribute('aria-label',label(entity)+' table');const table=el('table'),thead=el('thead'),tr=el('tr');(displays[entity]||[]).forEach(k=>{const th=el('th','',label(k));th.scope='col';tr.append(th);});thead.append(tr);table.append(thead);const body=el('tbody');rows.forEach(r=>{const row=el('tr');displays[entity].forEach((k,i)=>{const td=el('td');td.dataset.field=k;if(i===0)td.append(button(display(r,k),()=>showDetails(entity,r),''));else if(entity==='Transactions'&&k==='reviewAction'){const d=el('details','row-review');d.append(el('summary','','Review / classify'),transactionControls(r));td.append(d);}else if(entity==='Statements'&&k==='settlement')td.append(statementPaymentPicker(r));else if(/status|settlement|reviewStatus/.test(k))td.append(el('span','badge',display(r,k)));else td.textContent=display(r,k);row.append(td);});body.append(row);});table.append(body);wrap.append(table);container.append(wrap);}
  function renderTable(container,result){state.pageResult=result;state.pageEntity=state.entity;if(result.issues.some(x=>x.severity==='ERROR'))container.append(el('div','review-banner','This table contains invalid records. Treat calculated values as provisional until repaired.'));
    if(result.summary){Object.entries(result.summary).forEach(([cur,t])=>{const panel=el('section','card');panel.append(el('h2','','Collections · '+cur));const metrics=el('div','metrics');[['Assigned',t.assigned],['Cash received',t.cash],['Credits / waivers',t.credits],['Remaining owed',t.remaining]].forEach(([name,n])=>{const d=el('div','metric');append(d,el('span','',name),el('strong','',money(n,cur)));metrics.append(d);});panel.append(metrics);const counts=el('div','toolbar');[['Not requested',t.notRequested,{requestStatus:'NOT_REQUESTED'}],['Partially settled',t.partial,{settlement:'PARTIAL'}],['Settled',t.settled,{settlement:'SETTLED'}],['Disputed',t.disputed,{requestStatus:'DISPUTED'}],['Past expected date',t.pastExpected,{expectedState:'PAST_EXPECTED_DATE'}]].forEach(([name,n,f])=>counts.append(button(name+' ('+n+')',()=>{state.filters=Object.assign({},state.filters,f,{currency:cur});state.page=0;render();})));append(panel,el('p','subtle','Active shares within the current filters. Request status and settlement are independent.'),counts);container.append(panel);});}
    simpleTable(container,state.entity,result.rows);const pager=el('div','pager');pager.append(el('span','',result.total+' records · page '+(result.page+1)+' of '+Math.max(1,Math.ceil(result.total/40))));const controls=el('div');const prev=button('Previous',()=>{state.page--;render();}),next=button('Next',()=>{state.page++;render();});prev.disabled=result.page===0;next.disabled=(result.page+1)*40>=result.total;append(controls,prev,next);pager.append(controls);container.append(pager);}
  function showDetails(entity,r){state.selected=r;const c=$('context');c.replaceChildren();append(c,el('p','eyebrow','RECORD DETAILS'),el('h2','',label(entity)));const details=el('div');Object.keys(r).filter(k=>!k.startsWith('_')&&!['fingerprint','revision','sourceKey'].includes(k)).forEach(k=>{const d=el('div','detail-row');append(d,el('span','',label(k)),el('strong','',k==='totals'?Object.entries(r.totals).map(([cur,n])=>money(n,cur)).join(', '):display(r,k)));details.append(d);});c.append(details);c.append(button('Edit record',()=>editRecord(entity,r)));
    if(entity==='Transactions')c.append(button('Assign a share',()=>editRecord('Shares',{transactionId:r.id,currency:r.currency,status:'ACTIVE',requestStatus:'NOT_REQUESTED'})));
    if(entity==='Transactions'){const panel=el('section','card');append(panel,el('h3','','Classify and review'),transactionControls(r));c.append(panel);}
    if(entity==='Statements')c.append(statementPaymentPicker(r));
    if(entity==='Shares')c.append(button('Record repayment or credit',()=>editRecord('Repayments',{shareId:r.id,currency:r.currency,type:'CASH',status:'PENDING',date:state.boot.today})));
    if(entity==='Statements')c.append(button('Allocate bank payment',()=>editRecord('PaymentAllocations',{statementId:r.id,status:'ACTIVE'})));
    if(entity==='BankPayments')c.append(button('Allocate to statement',()=>editRecord('PaymentAllocations',{paymentId:r.id,status:'ACTIVE'})));
    if(entity==='Accounts')c.append(button('Statement history',()=>navigate('Statements',undefined,{accountId:r.id})));
    if(entity==='Cards')c.append(button('Card transactions',()=>navigate('Transactions',undefined,{cardId:r.id})));
    if(entity==='InstallmentPlans')c.append(button('View installment schedule',()=>action(async()=>{const rows=await rpc('apiInstallmentSchedule',r.id),box=el('div');box.append(el('p','subtle','Expected dates are a monthly plan estimate, not bank due dates. Posted progress counts linked installment charges.'));const wrap=el('div','table-scroll'),table=el('table');const head=el('tr');['Number','Expected date','Expected amount','Status'].forEach(k=>head.append(el('th','',k)));table.append(head);rows.forEach(x=>{const row=el('tr');[x.number,x.expectedDate,x.expectedAmount+' '+x.currency,x.status].forEach(v=>row.append(el('td','',v)));table.append(row);});append(wrap,table);append(box,wrap,button('View linked transactions',()=>{$('dialog').close();navigate('Transactions',undefined,{installmentPlanId:r.id});}));openDialog('Installment schedule',box);})))
    if(entity==='People')c.append(button('Collection history',()=>navigate('Money Owed',undefined,{personId:r.id})));
    if(entity==='SavedViews')c.append(button('Open saved view',()=>{try{navigate(Object.keys(areas).find(a=>areas[a].includes(r.scope)),r.scope,JSON.parse(r.filters));state.sort=r.sort;render();}catch(_){notice('Invalid saved view. Edit its filters.','error');}}));
    if(!$('context-drawer').open)$('context-drawer').showModal();c.scrollTo({top:0,behavior:'instant'});
  }
  function editRecord(entity,record={}){
    const form=el('form'),grid=el('div','form-grid'),controls={};const isEdit=!!record.id;
    const defaults={status:entity==='Statements'?'OPEN':['BankPayments','Repayments'].includes(entity)?'PENDING':'ACTIVE',reviewStatus:'REVIEW',relationship:'PRIMARY',type:entity==='Repayments'?'CASH':'PURCHASE',requestStatus:'NOT_REQUESTED',reconciliation:'UNVERIFIED',calendarMode:'OFF',currency:state.boot.settings.DefaultCurrency||'',filters:'{}',sort:'updatedAt:desc'};
    const editable=state.boot.schema[entity].split(' ').filter(k=>!technical.has(k));
    editable.forEach(k=>{
      let value=record[k]??defaults[k]??'',n;const options=state.boot.enums[entity+'.'+k];
      if(refs[k])n=select(state.boot.lookups[refs[k]]||[],value);
      else if(entity==='Transactions'&&k==='tags')n=tagPicker(value);
      else if(entity==='Transactions'&&k==='type')n=select(typeOptions(),value,false);
      else if(options)n=select(options,value);
      else if(k==='currency')n=select(Object.keys(state.boot.currencies),value);
      else if(['notes','originalDescription','filters'].includes(k)){n=el('textarea');n.value=value;}
      else if(/Minor$/.test(k))n=input(value===''?'':decimal(value,record.currency||currencyFor(record)||state.boot.settings.DefaultCurrency),'text');
      else if(/Date$|^date$|^periodStart$|^periodEnd$/.test(k))n=input(value,'date');
      else n=input(value);
      n.id='edit-'+k;n.required=(state.boot.required[entity]||'').split(' ').includes(k);controls[k]=n;
      const hints={tags:'Comma-separated labels. Tags do not create obligations.',lastFour:'Exactly four digits. Never enter full card numbers.',balanceMinor:'Official bank statement balance. Leave blank if unknown.',minimumMinor:'Official minimum due. Leave blank if unknown.',reconciliation:'VERIFIED means you have checked bank-payment information.',notes:'Private; excluded from shareable reports.',amountMinor:'Decimal currency amount. No thousands separators.',status:['BankPayments','Repayments'].includes(entity)?'Confirm only after verifying receipt. Reverse corrections; keep history.':'',filters:'JSON object using the supported Saved View filters.'};
      const l=field(k,n,hints[k]);if(['notes','originalDescription','description','filters','tags'].includes(k))l.classList.add('wide');grid.append(l);
    });
    const relation=controls.accountId||controls.shareId||controls.transactionId;if(relation&&controls.currency)relation.addEventListener('change',()=>{const type=refs[relation.name];const item=(state.boot.lookups[type]||[]).find(x=>x.id===relation.value);if(item?.currency)controls.currency.value=item.currency;});
    append(form,el('p','subtle','Use stable linked records. Amounts are entered as decimals and stored as exact minor units. Required fields must be completed.'),grid);
    const save=button('Save record',()=>{},'');save.type='submit';append(form,append(el('div','form-actions'),button('Cancel',()=>$('dialog').close()),save));let requestId=uuid();
    form.addEventListener('submit',async e=>{e.preventDefault();save.disabled=true;$('dialog-error').textContent='';try{
      const data={};if(isEdit)data.id=record.id;const cur=controls.currency?.value||currencyFor(Object.fromEntries(Object.entries(controls).map(([k,n])=>[k,n.value])));
      editable.forEach(k=>data[k]=/Minor$/.test(k)?toMinor(controls[k].value,cur):controls[k].value);
      await rpc('apiSave',entity,data,record._token||'',requestId);$('dialog').close();await refresh();notice('Record saved.');
    }catch(err){$('dialog-error').textContent=err.message;}finally{save.disabled=false;}});openDialog((isEdit?'Edit ':'Add ')+label(entity).toLowerCase(),form);
  }
  function renderReview(){const c=$('content');append(c,el('p','subtle','Errors block totals, imports, reports and synchronization. Warnings identify records requiring judgment. Use Diagnostics and recovery in Settings to resolve missing references before continuing.'));
    if(!state.boot.issues.length){c.append(el('div','empty','No review issues found.'));return;}const list=el('div','issues');state.boot.issues.forEach(x=>{const row=el('div','issue '+(x.severity==='ERROR'?'error':''));append(row,el('strong','',label(x.entity)),el('p','',x.message));if(x.message.startsWith('A tracked row was removed')){
      ['restore','accept'].forEach(mode=>{const request=uuid();row.append(button(mode==='restore'?'Restore deleted record':'Accept intentional deletion',()=>action(async()=>{
        await rpc('apiResolveMissing',x.entity,x.id,mode,request);await refresh();notice(mode==='restore'?'Record restored from saved history.':'Deletion accepted. Saved history is retained.');
      })));});row.append(el('small','',x.id));
    }if(areas[Object.keys(areas).find(a=>areas[a].includes(x.entity))])row.append(button('Open table',()=>navigate(Object.keys(areas).find(a=>areas[a].includes(x.entity)),x.entity),''));else row.append(button('Open recovery settings',()=>navigate('Settings and Integration'),''));list.append(row);});c.append(list);}
  function renderSettings(){const c=$('content'),form=el('form','card'),grid=el('div','form-grid');form.append(el('h2','','Workspace settings'));const controls={};Object.entries(state.boot.settings).filter(([k])=>k!=='CalendarId'&&(state.boot.storage!=='supabase'||!['SyncEnabled','IncludeHistorical','BackupEnabled','BackupDays'].includes(k))).forEach(([k,v])=>{const n=['SyncEnabled','ShowAmounts','IncludeHistorical','BackupEnabled'].includes(k)?select([{id:'false',label:'Disabled'},{id:'true',label:'Enabled'}],String(v),false):k==='DefaultCurrency'?select(Object.keys(state.boot.currencies),v):input(v);controls[k]=n;grid.append(field(k,n));});form.append(grid);const save=button('Save settings',()=>{},'');save.type='submit';form.append(append(el('div','form-actions'),save));form.addEventListener('submit',e=>{e.preventDefault();action(async()=>{save.disabled=true;try{await rpc('apiSettings',Object.fromEntries(Object.entries(controls).map(([k,n])=>[k,n.value])),state.boot.diagnostics.settingsToken,uuid());await refresh();notice('Settings saved.');}finally{save.disabled=false;}});});c.append(form);
    if(state.boot.storage==='supabase')renderBackups(c);
    if(state.boot.storage!=='supabase'){const integration=el('section','card');append(integration,el('h2','','Calendar and automation'),el('p','subtle','Synchronization is one way. Stopping automation leaves existing Calendar reminders in place. Pause statements and synchronize to disable their reminders.'),el('p','','Selected calendar: '+(state.boot.settings.CalendarId||'None')));
    const commands=[['Test Calendar','apiCalendarTest'],['Preview synchronization','apiSyncPreview'],['Install / repair triggers','installTriggers'],['Stop automation','stopAutomation'],['Repair reminder time','repairSettings'],['Create private backup','apiBackup']];const buttons=el('div','toolbar');commands.forEach(([title,method])=>buttons.append(button(title,()=>action(async()=>{notice(title+'…','loading');const r=await rpc(method);const box=el('div');if(Array.isArray(r))r.forEach(x=>box.append(el('p','',JSON.stringify(x))));else if(r.url){const a=el('a','','Open private backup');a.href=r.url;a.target='_blank';a.rel='noopener';append(box,el('p','',r.message),a);}else box.append(el('p','',JSON.stringify(r)));openDialog(title,box);await refresh();notice('Operation finished.');}))));buttons.append(button('Synchronize all statements',synchronizeStatements));buttons.append(button('Select or create calendar',chooseCalendar));integration.append(buttons);c.append(integration);}
    const d=state.boot.diagnostics,diag=el('section','card');append(diag,el('h2','','Diagnostics and recovery'),el('p','subtle','Backend: '+(d.backendRevision||'original-v4')+' | Workflows: '+(d.workflowRevision||'install update')+' | Batch save: '+(d.reviewBatchRevision||'install update')),el('p','','Registered triggers: '+d.triggers.length),el('p','','Last reconciliation run: '+(d.lastSync||'Never')),el('p','','Last backup: '+(d.lastBackup||'Never')),el('p','',d.automationError||'No recorded automation error.'));
    d.pending.forEach(op=>diag.append(button('Resume '+op.kind,()=>action(async()=>{await rpc('apiRecover',op.id);await refresh();notice('Operation recovered.');}))));if(!d.pending.length)diag.append(el('p','subtle','No pending writes.'));c.append(diag);
  }
  function renderBackups(c){
    const d=state.boot.diagnostics,box=el('section','card'),status=el('p','subtle',d.backupRunning?'Backup in progress…':d.backupError||'Backups do not interrupt your financial workspace.');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    append(box,el('h2','','Database and daily backup'),el('p','','Financial records are stored in Supabase. Sheets holds a daily backup. Calendar synchronization is disabled.'),el('p','','Database version: '+state.boot.databaseVersion),el('p','','Daily backup: '+(state.boot.settings.BackupEnabled==='true'?'Enabled':'Disabled')),el('p','','Last successful backup: '+(d.lastBackup||'Never')),el('p','','Backed-up database version: '+(d.lastBackupVersion||'None')),status);
    const controls=el('div','toolbar');
    const enable=button('Enable Sheets backups',()=>action(async()=>{enable.disabled=true;try{status.textContent='Checking Sheets access…';const r=await rpc('apiEnableSheetBackups');await refresh();notice(r.message);}finally{enable.disabled=false;}}));
    const manual=button('Back up now',async()=>{manual.disabled=true;status.textContent='Copying a database snapshot to Sheets… You can continue working.';try{const r=await rpc('apiBackup');status.textContent=r.message+' Database version '+r.databaseVersion+'.';if(state.area==='Settings and Integration')await refresh();}catch(e){status.textContent=e.message;notice(e.message,'error');}finally{manual.disabled=false;}},'secondary');
    manual.disabled=!!d.backupRunning;append(controls,enable,manual);box.append(controls);c.append(box);
  }
  async function chooseCalendar(){await action(async()=>{const calendars=await rpc('apiCalendars'),box=el('div'),choice=select(calendars,state.boot.settings.CalendarId);append(box,field('Calendar',choice),button('Create dedicated calendar',()=>action(async()=>{const x=await rpc('apiCreateCalendar');choice.append(new Option(x.label,x.id));choice.value=x.id;notice('Calendar created. Preview selection to use it.');})),button('Preview selection',()=>action(async()=>{const p=await rpc('apiCalendarMigrationPreview',choice.value),confirm=el('div');append(confirm,el('p','',p.message),el('p','',p.eventsToRetire+' existing events will have reminders disabled.'),button('Apply calendar selection',()=>action(async()=>{await rpc('apiCalendarMigrate',p.target,p.token,uuid());$('dialog').close();await refresh();})));openDialog('Confirm Calendar migration',confirm);})));openDialog('Select reminder calendar',box);});}
  async function showReport(){const box=el('div');box.append(el('p','','Export only the current filtered shares for one person. Review the complete snapshot before downloading. Private notes, card details and source references are excluded.'));const fields=state.boot.configuration.report.fields,checks={};fields.forEach(k=>{const n=input('','checkbox');n.checked=true;checks[k]=n;box.append(append(el('label','check-label'),n,document.createTextNode(label(k))));});box.append(button('Generate preview',()=>action(async()=>{const report=await rpc('apiReport',state.filters,fields.filter(k=>checks[k].checked));const html=reportHtml(report),preview=el('div'),frame=el('iframe','report-frame');frame.title='Shareable report preview';frame.setAttribute('sandbox','');frame.srcdoc=html;append(preview,el('p','','Snapshot contains '+report.rows.length+' selected shares. It is not a live balance.'),frame,button('Download HTML report',()=>{const url=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'})),a=el('a');a.href=url;a.download='repayment-report-'+report.generatedAt.slice(0,10)+'.html';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}));preview.append(el('p','subtle','Open the downloaded HTML and use Print → Save as PDF. Share only after reviewing the snapshot.'));openDialog('Report preview',preview);})));openDialog('Choose report fields',box);}
  function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function reportHtml(r){return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+escapeHtml(r.title||'Repayment snapshot')+'</title><style>body{font:14px system-ui;color:#292737;margin:32px}h1{font-size:26px}p{color:#605b69}table{border-collapse:collapse;width:100%}th,td{padding:10px;text-align:left;border-bottom:1px solid #ddd}th{background:#eee8f6}@media print{body{margin:0;font-size:10px}tr{break-inside:avoid}}</style><h1>'+escapeHtml(r.title||'Repayment snapshot')+'</h1><p>Generated '+escapeHtml(r.generatedAt)+'. A snapshot of selected records, not a live balance.</p><table><thead><tr>'+r.fields.map(k=>'<th>'+escapeHtml(label(k))+'</th>').join('')+'</tr></thead><tbody>'+r.rows.map(row=>'<tr>'+r.fields.map(k=>'<td>'+escapeHtml(row[k])+'</td>').join('')+'</tr>').join('')+'</tbody></table></html>';}
  function showImport(){
    let batch=null,mappings={},selected=new Set(),busy=false,running=false,pauseRequested=false,sourceCsv='',mappingDirty=false;
    const box=el('div'),status=el('p','notice','Choose a sanitized CSV to begin.'),file=input('','file'),mappingBox=el('div','form-grid'),results=el('div');
    const cardDrafts=new Map();
    file.accept='.csv,text/csv';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const savedKey='cc-import-batch';const saved=()=>{try{return sessionStorage.getItem(savedKey);}catch(_){return null;}};
    const remember=id=>{try{sessionStorage.setItem(savedKey,id);}catch(_){}};
    const setBusy=value=>{busy=value;box.querySelectorAll('button,input,select').forEach(n=>n.disabled=value||n.dataset.fixedDisabled==='true');pause.disabled=!running;};
    async function run(phase,fn){if(busy)return;setBusy(true);status.textContent=phase;try{await fn();}catch(e){status.textContent='Paused — '+e.message+' Use Check saved progress before retrying.';status.className='notice error';}finally{running=false;setBusy(false);}}
    function accept(data,reset=false){batch=data;remember(data.batchId);if(reset){mappings=data.mappings||{};selected=new Set(data.selection);renderMappings();}renderPage();}
    function renderMappings(){mappingBox.replaceChildren();batch.groups.forEach(group=>{
      const entry=mappings[group]||{},card=select(state.boot.lookups.Cards,entry.cardId||''),cur=select(Object.keys(state.boot.currencies),entry.currency||'');card.disabled=busy;cur.disabled=busy;
      card.append(new Option(configured('button.+ Add new card…','+ Add new card…'),'__add'));
      card.addEventListener('change',()=>{if(card.value==='__add'){card.value=entry.cardId||'';addImportCard(group,card);return;}mappings[group]=Object.assign(mappings[group]||{},{cardId:card.value});mappingDirty=true;});
      cur.addEventListener('change',()=>{mappings[group]=Object.assign(mappings[group]||{},{currency:cur.value});mappingDirty=true;});
      mappingBox.append(field(group,card),field('Confirmed currency',cur));
    });}
    function addImportCard(group,opener){
      if(cardDrafts.has(group)){cardDrafts.get(group)();return;}
      const parts=group.split(' | '),panel=el('form','card'),grid=el('div','form-grid'),error=el('p','notice error');error.setAttribute('role','alert');
      const account=select(state.boot.lookups.Accounts.filter(a=>a.status==='ACTIVE'));
      account.append(new Option(configured('button.+ Create new account…','+ Create new account…'),'__new'));
      if(!state.boot.lookups.Accounts.some(a=>a.status==='ACTIVE'))account.value='__new';
      const bank=input(parts[0]||''),accountName=input(parts[0]||''),nickname=input(parts.slice(1,-1).join(' | ')||''),lastFour=input(parts.at(-1)||''),currency=select(Object.keys(state.boot.currencies),mappings[group]?.currency||state.boot.settings.DefaultCurrency||'');
      nickname.required=true;lastFour.required=true;lastFour.pattern='[0-9]{4}';lastFour.maxLength=4;account.required=true;currency.required=true;
      const bankField=field('bank',bank),nameField=field('accountNickname',accountName);
      append(grid,field('accountId',account),bankField,nameField,field('nickname',nickname),field('lastFour',lastFour),field('currency',currency));
      const update=()=>{const creating=account.value==='__new';bankField.hidden=nameField.hidden=!creating;bank.required=accountName.required=creating;};account.addEventListener('change',update);update();
      const siblings=[...box.children];const show=()=>{siblings.forEach(n=>n.hidden=true);box.append(panel);account.focus();};cardDrafts.set(group,show);show();
      const finish=()=>{cardDrafts.delete(group);panel.remove();siblings.forEach(n=>n.hidden=false);renderMappings();mappingBox.querySelector('select')?.focus();};
      const cancel=button('Cancel',()=>{panel.remove();siblings.forEach(n=>n.hidden=false);if(opener.isConnected)opener.focus();else mappingBox.querySelector('select')?.focus();});
      const save=button('Save and select card',()=>{});save.type='submit';
      append(panel,el('h3','',configured('button.+ Add new card…','+ Add new card…')),grid,error,append(el('div','form-actions'),cancel,save));account.focus();
      const accountRequest=uuid(),cardRequest=uuid();let payload=null,accountId='',saving=false;
      panel.addEventListener('submit',async e=>{e.preventDefault();if(saving)return;error.textContent='';
        if(!nickname.value.trim()||(account.value==='__new'&&(!bank.value.trim()||!accountName.value.trim()))){error.textContent='Complete the nickname and required account fields.';return;}
        if(!payload){const existing=state.boot.lookups.Accounts.find(a=>a.id===account.value);if(account.value!=='__new'&&(!existing||existing.currency!==currency.value)){error.textContent='Choose an active account with the confirmed currency.';return;}
          payload={account:{bank:bank.value.trim(),nickname:accountName.value.trim(),currency:currency.value,status:'ACTIVE',reviewStatus:'REVIEW'},card:{nickname:nickname.value.trim(),lastFour:lastFour.value,relationship:'PRIMARY',status:'ACTIVE'},currency:currency.value};accountId=existing?.id||'';
        }
        payload.card.nickname=nickname.value.trim();payload.card.lastFour=lastFour.value;
        saving=true;grid.querySelectorAll('input,select').forEach(n=>n.disabled=true);save.disabled=cancel.disabled=true;
        try{
          if(!accountId)accountId=(await rpc('apiSave','Accounts',payload.account,'',accountRequest)).id;
          const result=await rpc('apiSave','Cards',{...payload.card,accountId},'',cardRequest);
          const lookups=await rpc('apiImportLookups');Object.assign(state.boot.lookups,{Accounts:lookups.Accounts,Cards:lookups.Cards});
          mappings[group]={cardId:result.id,currency:payload.currency};mappingDirty=true;finish();status.textContent='Card saved. Validate mappings and preview before importing.';
        }catch(err){error.textContent=err.message+' Retry Save and select card to check the same operation. Entered values are retained.';if(/VALIDATION:/.test(err.message)){if(!accountId){payload=null;grid.querySelectorAll('input,select').forEach(n=>n.disabled=false);}else{nickname.disabled=lastFour.disabled=false;}}}
        finally{saving=false;save.disabled=cancel.disabled=false;}
      });
    }
    function renderPage(){
      results.replaceChildren();if(!batch)return;
      status.className='notice';status.textContent=batch.state+' · '+batch.total+' source rows · '+batch.progress.imported+' imported · '+selected.size+' selected';
      results.append(el('p','',Object.entries(batch.counts).map(([k,v])=>k+': '+v).join(' · ')));
      const wrap=el('div','table-scroll import-preview'),table=el('table'),head=el('tr');['Select','Date','Description','Amount','Outcome'].forEach(k=>head.append(el('th','',k)));table.append(head);
      batch.rows.forEach(r=>{
        const tr=el('tr'),check=input('','checkbox');check.setAttribute('aria-label','Import source row '+(r.index+1));check.checked=selected.has(r.index);
        check.dataset.fixedDisabled=String(!['ACCEPTED','SUSPECT'].includes(r.status)||batch.progress.cursor>0);check.disabled=busy||check.dataset.fixedDisabled==='true';
        check.addEventListener('change',()=>{if(check.checked)selected.add(r.index);else selected.delete(r.index);});
        append(tr,append(el('td'),check),el('td','',r.date),el('td','',r.description),el('td','',r.amount),el('td','',r.status+' '+r.reason));table.append(tr);
      });wrap.append(table);results.append(wrap);
      const pager=el('div','pager'),previous=button('Previous preview page',()=>run('Loading preview…',async()=>accept(await rpc('apiImportPage',batch.batchId,batch.page-1)))),next=button('Next preview page',()=>run('Loading preview…',async()=>accept(await rpc('apiImportPage',batch.batchId,batch.page+1))));
      previous.dataset.fixedDisabled=String(batch.page===0);next.dataset.fixedDisabled=String((batch.page+1)*50>=batch.total);previous.disabled=busy||batch.page===0;next.disabled=busy||(batch.page+1)*50>=batch.total;
      append(pager,previous,el('span','','Page '+(batch.page+1)+' of '+Math.ceil(batch.total/50)+' · up to 50 rows'),next);results.append(pager);
    }
    const validate=button('Validate mappings and preview',()=>run('Validating rows…',async()=>{
      if(!batch)throw Error('Choose a CSV first.');const previous=batch.validation?new Set(selected):null;const page=batch.page;accept(await rpc('apiImportValidate',batch.batchId,mappings),true);if(previous)selected=new Set([...selected].filter(i=>previous.has(i)));if(page)accept(await rpc('apiImportPage',batch.batchId,page));else renderPage();mappingDirty=false;
    }));
    const check=button('Check saved progress',()=>run('Checking saved progress…',async()=>{
      const id=batch?.batchId||saved();if(!id)throw Error('Choose the same CSV to find its saved batch.');accept(await rpc('apiImportStatus',id),true);
    }));
    const restart=button('Restart preview from chosen CSV',()=>run('Re-staging chosen CSV…',async()=>{if(!sourceCsv)throw Error('Choose the original CSV first.');accept(await rpc('apiImportStage',sourceCsv,true),true);}));
    const start=button('Import selected rows',()=>run('Preparing import…',async()=>{
      if(!batch?.validation||mappingDirty)throw Error('Validate mappings first.');
      if(batch.progress.cursor===0){if(!selected.size)throw Error('Select at least one row.');accept(await rpc('apiImportSelect',batch.batchId,batch.validation,[...selected]),true);}
      else accept(await rpc('apiImportStatus',batch.batchId),true);
      running=true;pauseRequested=false;pause.disabled=false;
      while(batch.state!=='COMPLETED'&&!pauseRequested){status.textContent='Importing · '+batch.progress.cursor+' of '+selected.size+' selected rows processed…';accept(await rpc('apiImportBatchCommit',batch.batchId,batch.validation),true);}
      if(pauseRequested&&batch.state!=='COMPLETED')accept(await rpc('apiImportPause',batch.batchId),true);
      if(batch.state==='COMPLETED'){status.textContent='Completed — '+batch.progress.imported+' transactions imported. Review classifications and official balances.';await refresh();}
    }));
    const pause=button('Pause after this batch',()=>{pauseRequested=true;status.textContent='Pausing after the current batch…';});pause.disabled=true;
    file.addEventListener('change',()=>run('Reading CSV…',async()=>{
      const chosen=file.files[0];if(!chosen)return;if(!/\.csv$/i.test(chosen.name)||chosen.size>1500000)throw Error('Choose a sanitized CSV no larger than 1.5 MB.');
      const csv=await chosen.text();await new Promise(resolve=>requestAnimationFrame(resolve));
      const header=csv.replace(/^\uFEFF/,'').split(/\r?\n/,1)[0].split(',').map(s=>s.replace(/^"|"$/g,''));
      const expected=['Source Hash','Source Row','Bank','Card','Last Four','Billing Cycle','Statement Date','Payment Due Date','Transaction Date','Posting Date','Description','Amount','Source Reference'];
      if(JSON.stringify(header)!==JSON.stringify(expected))throw Error('CSV headers do not match the sanitizer. Use tools/sanitize_workbook.py.');
      sourceCsv=csv;status.textContent='Uploading and staging CSV…';accept(await rpc('apiImportStage',csv),true);
    }));
    append(box,el('p','','Upload sanitized CSV once, confirm each card and currency, then review 50 rows per page. Select the duplicate candidates you have reviewed.'),field('Sanitized CSV',file),status,mappingBox,append(el('div','toolbar'),validate,check,start,pause,restart),results);
    openDialog('Import transactions',box);
    $('dialog').addEventListener('close',()=>{pauseRequested=true;},{once:true});
  }
  function showPackageImport(){
    const box=el('div'),file=input('','file'),summary=el('p','subtle','Choose the reviewed package to preview its totals.'),progress=el('progress'),status=el('p','subtle');
    file.accept='.json';progress.max=1;progress.value=0;progress.setAttribute('aria-label','Import progress');
    let packageData=null,running=false;
    const commit=button('Import reviewed records',async()=>{
      if(!packageData||running)return;running=true;commit.disabled=true;file.disabled=true;
      try{
        let offset=0;
        while(offset<packageData.records.length){
          let end=offset;
          while(end<packageData.records.length&&end-offset<15&&JSON.stringify(packageData.records.slice(offset,end+1)).length<18000)end++;
          if(end===offset)throw Error('A record exceeds the supported batch size.');
          await rpc('apiPackageCommit',packageData.records.slice(offset,end),packageData.id+'-'+offset);
          offset=end;progress.value=offset/packageData.records.length;status.textContent='Imported '+offset+' of '+packageData.records.length+' records.';
        }
        const receipt=await rpc('apiPackageReceipt',packageData.sourceHash);
        const expected=packageData.expected;
        if(receipt.transactions!==expected.transactions||receipt.netMinor!==expected.netMinor||receipt.debitMinor!==expected.debitMinor||receipt.creditMinor!==expected.creditMinor)throw Error('Import totals need review. Open the records and compare the package receipt.');
        status.textContent='Verified '+receipt.transactions+' transactions. Net imported activity: '+money(receipt.netMinor,'PHP')+'.';
        await refresh();
      }catch(e){status.textContent=e.message+' Reopen the same package to resume after resolving the issue.';}
      finally{running=false;file.disabled=false;commit.disabled=false;}
    });
    commit.disabled=true;
    file.addEventListener('change',async()=>{
      try{
        const selected=file.files[0];if(!selected)return;if(selected.size>1500000)throw Error('Choose a package smaller than 1.5 MB.');
        const p=JSON.parse(await selected.text());
        if(p.format!=='cardbills-reviewed-v1'||!Array.isArray(p.records)||p.records.length<1||p.records.length>6000||!/^[-a-f0-9]{36}$/.test(p.id)||!/^[a-f0-9]{64}$/.test(p.sourceHash)||!p.expected)throw Error('Choose a Cardbills reviewed package.');
        const tx=p.records.filter(r=>r.entity==='Transactions');let total=0,debits=0,credits=0;
        for(const item of tx){const r=item.record;if(r.currency!=='PHP'||!Number.isSafeInteger(r.amountMinor))throw Error('Check the package currency and amounts.');total+=r.amountMinor;if(r.amountMinor>0)debits+=r.amountMinor;else credits+=r.amountMinor;}
        if(tx.length!==p.expected.transactions||total!==p.expected.netMinor||debits!==p.expected.debitMinor||credits!==p.expected.creditMinor)throw Error('Package totals need review.');
        packageData=p;summary.textContent=tx.length+' transactions | '+money(debits,'PHP')+' debits | '+money(credits,'PHP')+' credits | '+money(total,'PHP')+' net imported activity.';commit.disabled=false;progress.value=0;status.textContent='Card mappings, retained duplicates and display descriptions are included.';
      }catch(e){packageData=null;commit.disabled=true;status.textContent=e.message;}
    });
    append(box,field('Reviewed import package',file),summary,progress,status,commit);openDialog('Import reviewed package',box);
  }
  $('sign-out').addEventListener('click',()=>action(async()=>{
    const response=await fetch('/api/logout',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'});
    if(!response.ok)throw Error('Sign-out needs another attempt.');
    location.replace('/login.html');
  }));
  window.addEventListener('error',()=>notice('The interface encountered an error. Refresh or install the matching release files.','error'));
  window.addEventListener('unhandledrejection',e=>notice(e.reason?.message||'A request failed. Refresh and try again.','error'));
  action(async()=>{await refresh();const start=document.body.dataset.start;
    if(start==='review')navigate('Review');
    if(start==='settings')navigate('Settings and Integration');
    if(start==='configuration')navigate('Configuration');
    if(start==='records')navigate('Transactions');
    if(start==='report'){navigate('Money Owed');showReport();}
    if(start==='import')showImport();
  });
})();
