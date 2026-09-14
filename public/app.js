'use strict';
function createRecordClient(send, options = {}) {
  const reads = new Set(['apiBootstrap', 'apiList', 'apiImportLookups', 'apiPackageReceipt', 'apiInstallmentSchedule']);
  const pending = [];
  const shared = new Map();
  const pause = options.pause || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const exclusive = options.exclusive || (fn => fn());
  let running = 0;
  let writing = false;
  let generation = 0;

  async function pump() {
    if (writing) return;
    while (pending.length && running < 4) {
      if (!pending[0].read && running) return;
      const item = pending.shift();
      running++;
      if (!item.read) writing = true;
      void (async()=>{try {
        const execute = async () => {
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
        };
        const value = await (item.read ? execute() : exclusive(execute));
        item.resolve(value);
      } catch (error) { item.reject(error); }
      finally { if (item.key && shared.get(item.key) === item) shared.delete(item.key); running--;if(!item.read)writing=false;void pump(); }
      })();
      if (!item.read) return;
    }
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
  const fields = row => ({ type: row.type, reviewStatus: row.reviewStatus, tags: String(row.tags || ''), category: String(row.category || ''), dueDate: String(row.dueDate || ''), notes: String(row.notes || '') });
  function track(row) {
    if (!references.has(row.id)) references.set(row.id, new Set());
    references.get(row.id).add(row);
    return drafts.get(row.id)?.value || fields(row);
  }
  function stage(row, value) {
    const original = drafts.get(row.id)?.original || JSON.parse(JSON.stringify(row));
    const next = fields({...track(row), ...value});
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

function statementDueLabel(dueDate,today){const days=Math.round((Date.parse(dueDate+'T00:00:00Z')-Date.parse(today+'T00:00:00Z'))/86400000);return days<0?'Past due':days===0?'Due today':'Due in '+days+' '+(days===1?'day':'days');}

(() => {
  const $=id=>document.getElementById(id);
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const append=(p,...children)=>{children.filter(Boolean).forEach(c=>p.append(c));return p;};
  const button=(text,fn,cls='secondary')=>{const b=el('button',cls,configured('button.'+text,text));b.type='button';b.addEventListener('click',fn);return b;};
  const uuid=()=>crypto.randomUUID();
  const state={boot:null,area:'Overview',entity:'Transactions',filters:{},sort:'transactionDate:desc',page:0,sequence:0,selected:null};
  const areas={Overview:[],Loans:['Loans'],Transactions:['Transactions'],'Cards and Accounts':['Accounts','Cards'],Statements:['Statements'],'Bank Payments':['BankPayments','PaymentAllocations'],'Money Owed':['Shares'],People:['People'],Repayments:['Repayments'],Installments:['InstallmentPlans'],'Saved Views':['SavedViews'],Review:[],'Settings and Integration':[],Configuration:['Labels','ReportConfig']};
  const labels={nextDueDate:'Next unpaid due date',scheduledRemainingMinor:'Scheduled amount remaining',termMonths:'Term (months)',needsAttention:'Needs attention',reviewFix:'Fix',assignedShares:'Share',originTransactionId:'Financed principal transaction',cardId:'Card',accountId:'Account',reviewAction:'Classify and review',BankPayments:'Bank payments',PaymentAllocations:'Payment allocations',Shares:'Money owed',InstallmentPlans:'Installment plans',SavedViews:'Saved views',amountMinor:'Amount',balanceMinor:'Official balance',minimumMinor:'Minimum due',monthlyMinor:'Monthly amount',lastFour:'Last four digits',requestStatus:'Request status',calendarMode:'Calendar reminders',reconciliation:'Payment information',remainingMinor:'Remaining',cashMinor:'Cash received',creditMinor:'Credits / waivers',paidMinor:'Allocated payment',minimumRemainingMinor:'Minimum remaining',postedCount:'Posted installments'};
  const configured=(key,fallback)=>state.boot?.configuration?.labels[key]??fallback;
  const label=k=>configured('field.'+k,labels[k]||k.replace(/([A-Z])/g,' $1').trim().replace(/^./,s=>s.toUpperCase()));
  const refs={accountId:'Accounts',cardId:'Cards',statementId:'Statements',paymentId:'BankPayments',transactionId:'Transactions',personId:'People',shareId:'Shares',installmentPlanId:'InstallmentPlans',replacesCardId:'Cards',originTransactionId:'Transactions',matchedTransactionId:'Transactions'};
  const technical=new Set(['calendarId','eventId','syncedAt','fingerprint','syncError','attempts','nextRetry','sourceKey','sourceRef']);
  const displays={Loans:['nickname','lender','currency','nextDueDate','scheduledRemainingMinor','termMonths','status','notes'],Labels:['key','value'],ReportConfig:['key','value'],Accounts:['nickname','bank','currency','status'],Cards:['nickname','accountId','lastFour','relationship','status'],Transactions:['description','cardId','transactionDate','dueDate','amountMinor','currency','type','reviewStatus','category','tags','notes','assignedShares'],Statements:['accountId','statementDate','dueDate','balanceMinor','paidMinor','remainingMinor','settlement','calendarMode'],BankPayments:['accountId','date','amountMinor','currency','status'],PaymentAllocations:['paymentId','statementId','amountMinor','status'],People:['name','contact','status'],Shares:['personId','transactionId','amountMinor','remainingMinor','requestStatus','settlement'],Repayments:['shareId','date','amountMinor','currency','type','status'],InstallmentPlans:['reference','accountId','count','postedCount','status'],SavedViews:['name','scope','status']};
  const dateBases={Transactions:['transactionDate','postingDate','dueDate'],Statements:['statementDate','dueDate'],Shares:['transactionDate','expectedDate','requestDate'],BankPayments:['date'],Repayments:['date']};
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
    FINANCED_PRINCIPAL:['Financed principal','Full purchase converted into an installment plan; RCBC may show this as a negative entry.','Keep the original sign. Excluded from spending; separate positive monthly installment charges represent billed spending.'],
    UNKNOWN:['Needs classification','Use while the purpose of an entry is still uncertain.','Included in the review count until a type is selected.']
  };
  const iconPaths={filter:'M3 4h18l-7 8v7l-4 2v-9z',
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
    add.addEventListener('click',async()=>{error.textContent='';const name=newName.value.trim();if(!name)return;add.disabled=true;try{if(!name||name.length>60||/[,\r\n\x00-\x1f]/.test(name))throw Error('Enter a tag of 1 to 60 characters without commas or line breaks.');let options=[...(state.boot.tagOptions||[]),...transactionDrafts.tags()];if(!staged){if(!state.boot.workflowRevision)throw Error('Install the BillBills backend update to save new tags.');const r=await rpc('apiSave','TagOption',{name},'',uuid());state.boot.tagOptions=r.tagOptions;options=r.tagOptions;}const stored=options.find(t=>t.toLowerCase()===name.toLowerCase())||name;if(!chosen.some(t=>t.toLowerCase()===stored.toLowerCase()))chosen.push(stored);newName.value='';creator.hidden=true;draw();wrap.dispatchEvent(new Event('change',{bubbles:true}));}catch(e){error.textContent=e.message;}finally{add.disabled=false;}});
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
  let loanSaveFocus=null;const loanDrafts=new Map(),loanFields=['nickname','lender','notes','status'];
  const inlineRows=new Set();const inlineFields=['type','reviewStatus','category','tags','dueDate','notes'];
  function updateReviewFooter(){
    updateInlineState();
    const bar=$('review-save-bar');if(!bar)return;
    const count=transactionDrafts.size()+loanDrafts.size;
    bar.hidden=!['Transactions','Review','Loans'].includes(state.area)&&!count&&!reviewSaving;
    $('review-save-count').textContent=count?count+' record'+(count===1?'':'s')+' pending':'';
    $('review-save-status').textContent=reviewMessage;
    $('review-save-feedback').hidden=!count&&!reviewMessage;
    $('review-save-count').hidden=!count;
    $('review-save-status').hidden=!reviewMessage;
    $('save-review-changes').textContent=reviewSaving?'Saving...':reviewJob?'Retry save':'Save changes';
    $('save-review-changes').disabled=reviewSaving||!count;
    $('discard-review-changes').disabled=reviewSaving||(!count&&!inlineRows.size);
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
    const savedScroll=window.scrollY,mainScroll=$('main').scrollTop;let returnFocus=null;
    transactionDrafts.accept(rows);rows.forEach(r=>inlineRows.delete(r.id));
    for(const row of rows){
      for(const list of [state.pageResult?.rows,state.boot?.overview?.recent,state.boot?.lookups?.Transactions])for(const existing of list||[])if(existing.id===row.id)Object.assign(existing,row);
      if(state.selected?.id===row.id)Object.assign(state.selected,row);
    }
    document.querySelectorAll('[data-review-id]').forEach(box=>{
      const row=rows.find(r=>r.id===box.dataset.reviewId),tr=box.closest('tr');
      if(row&&tr){const expanded=box.closest('details');if(expanded?.open){if(expanded.contains(document.activeElement)||document.activeElement===$('save-review-changes'))returnFocus=returnFocus||expanded.querySelector('summary');expanded.open=false;}tr.querySelector('[data-field=dueDate]')?.replaceChildren(document.createTextNode(row.dueDate||'�'));tr.querySelector('[data-field=type]')?.replaceChildren(el('span','badge',row.type));tr.querySelector('[data-field=reviewStatus]')?.replaceChildren(el('span','badge',row.reviewStatus));}
    });
    paintInlineRows();if(!returnFocus&&document.activeElement===$('save-review-changes'))returnFocus=$('edit-page');returnFocus?.focus({preventScroll:true});$('main').scrollTop=mainScroll;window.scrollTo(0,savedScroll);
  }
  async function saveReviewChanges(){
    if(reviewSaving||!transactionDrafts.size())return;
    if(!state.boot.reviewBatchRevision){reviewMessage='The connected backend does not support batch saving yet. Refresh after the application update. Your selections remain pending.';updateReviewFooter();return;}
    if(!reviewJob)reviewJob={groups:transactionDrafts.batches().map(items=>({items,id:uuid()})),cursor:0,total:transactionDrafts.size(),saved:0};
    reviewSaving=true;reviewMessage='Saving pending changes...';updateReviewFooter();
    try{
      while(reviewJob.cursor<reviewJob.groups.length){
        const group=reviewJob.groups[reviewJob.cursor],last=reviewJob.cursor===reviewJob.groups.length-1;
        const result=await rpc('apiSave','TransactionReviewBatch',{items:group.items,includeSummary:last},'',group.id);
        if(!Array.isArray(result.rows)||result.rows.length!==group.items.length||group.items.some(item=>!result.rows.some(row=>row.id===item.id)))throw Error('The save receipt needs a status check. Retry the same save.');
        applyReviewRows(result.rows);reviewJob.saved+=group.items.length;reviewJob.cursor++;
        if(last)applyWorkflowResult(result);
        reviewMessage='Saved '+reviewJob.saved+' of '+reviewJob.total+' transactions.';updateReviewFooter();
      }
      reviewMessage='Saved '+reviewJob.total+' transaction'+(reviewJob.total===1?'':'s')+'. Overview updated.';reviewJob=null;if(state.area==='Review')await render();
      if(state.area==='Overview'){const scroll=$('main').scrollTop;$('content').replaceChildren();renderOverview();$('main').scrollTop=scroll;}
    }catch(error){
      reviewMessage=error.message+' Pending selections are retained.';
      if(/^(VALIDATION|CONFLICT|LIMIT):/.test(error.message))reviewJob=null;
      else reviewMessage+=' Use Retry save to check the same batch.';
    }finally{reviewSaving=false;updateReviewFooter();}
  }
  function setupReviewFooter(){
    $('save-review-changes').addEventListener('click',saveAllChanges);
    $('discard-review-changes').addEventListener('click',()=>{
      if(reviewSaving)return;if(loanDrafts.size){if(!confirm('Discard pending loan edits?'))return;loanDrafts.clear();inlineRows.clear();render();updateReviewFooter();}if(!transactionDrafts.size()){inlineRows.clear();paintInlineRows();updateReviewFooter();return;}
      if(!confirm('Discard pending transaction selections? Earlier successful saves remain recorded.'))return;
      const uncertain=!!reviewJob;transactionDrafts.clear();inlineRows.clear();paintInlineRows();reviewJob=null;reviewMessage='Pending selections discarded.';updateReviewFooter();
      if(uncertain)action(refresh);
    });
    window.addEventListener('beforeunload',event=>{if(transactionDrafts.size()||loanDrafts.size){event.preventDefault();event.returnValue='';}});
    $('sign-out').addEventListener('click',event=>{if((transactionDrafts.size()||loanDrafts.size)&&(reviewSaving||!confirm('Sign out and discard pending edits?'))){event.preventDefault();event.stopImmediatePropagation();}},true);
  }
  function statementPaymentLabel(r){if(r.balanceMinor===''||r.balanceMinor==null)return 'Balance needed';if(Number(r.balanceMinor)<=0)return 'No payment due';if(r.settlement==='SETTLED')return 'Paid in full';if(r.settlement==='PARTIAL')return 'Partially paid';return r.reconciliation==='VERIFIED'?'No payment recorded':'Payment review needed';}
  function statementPaymentPicker(r){
    const chosen=select([{id:'',label:statementPaymentLabel(r)},{id:'FULL',label:'Record full payment...'},{id:'PARTIAL',label:'Record partial payment...'},{id:'VERIFY_UNPAID',label:'Confirm no payment recorded...'},{id:'VERIFY_NO_DUE',label:'Confirm zero / credit balance...'},{id:'REVIEW',label:'Mark payment information for review...'}],'',false);
    chosen.className='statement-payment-select';chosen.setAttribute('aria-label','Payment status for statement '+r.statementDate);
    chosen.addEventListener('change',()=>{const mode=chosen.value;chosen.value='';if(mode)showStatementPayment(r,mode);});return chosen;
  }
  function showStatementPayment(r,initial='FULL',onReturn){
    const form=el('form','payment-form'),mode=select([{id:'FULL',label:'Paid in full'},{id:'PARTIAL',label:'Partially paid'},{id:'VERIFY_UNPAID',label:'No payment recorded'},{id:'VERIFY_NO_DUE',label:'No payment due (zero / credit balance)'},{id:'REVIEW',label:'Payment information needs review'}],initial,false),sources=state.boot.paymentSources||{payments:[],transactions:[]};
    const source=select([{id:'NEW',label:'Record a new bank payment'},...sources.payments.filter(p=>p.accountId===r.accountId&&p.currency===r.currency&&p.availableMinor>0).map(p=>({id:'PAYMENT:'+p.id,label:'Existing payment '+p.date+' | '+money(p.availableMinor,p.currency)+' available'})),...sources.transactions.filter(t=>t.accountId===r.accountId&&t.currency===r.currency).map(t=>({id:'TRANSACTION:'+t.id,label:'Imported credit '+t.date+' | '+money(t.amountMinor,t.currency)}))],'NEW',false),amount=input(r.remainingMinor===''?'':decimal(r.remainingMinor,r.currency)),date=input('','date'),reference=input(''),help=el('p','subtle'),fields=el('div','form-grid'),confirm=input('','checkbox'),save=button('Save payment information',()=>{}),status=el('p','field-status');
    date.max=state.boot.today;save.type='submit';confirm.required=true;confirm.setAttribute('aria-label','Confirm the payment information');amount.inputMode='decimal';
    append(form,el('p','','Statement: '+lookup('Accounts',r.accountId)+' | '+r.statementDate),el('p','','Billed: '+money(r.balanceMinor,r.currency)+' | Confirmed allocations: '+money(r.paidMinor,r.currency)+' | Remaining: '+money(r.remainingMinor,r.currency)),field('Payment status',mode),help);
    append(fields,field('Payment source',source),field('Amount of this payment',amount),field('Actual payment date',date),field('Payment reference',reference));
    append(form,fields,append(el('label','check-label'),confirm,document.createTextNode('I confirm these payment details against my records.')),status,append(el('div','form-actions'),button('Cancel',()=>{if(onReturn)onReturn();else $('dialog').close();}),save));
    const update=()=>{const paying=['FULL','PARTIAL'].includes(mode.value),[kind,id]=source.value.split(':'),existing=kind==='PAYMENT'?sources.payments.find(p=>p.id===id):kind==='TRANSACTION'?sources.transactions.find(t=>t.id===id):null;
      fields.hidden=!paying;amount.required=date.required=paying;amount.readOnly=mode.value==='FULL';date.disabled=!!existing;date.value=existing?existing.date:date.value;source.disabled=!paying;if(mode.value==='FULL')amount.value=r.remainingMinor===''?'':decimal(r.remainingMinor,r.currency);
      help.textContent=mode.value==='FULL'?'Records the remaining amount as a confirmed allocation. Enter when you actually paid.':mode.value==='PARTIAL'?'Enter this additional payment amount. Confirmed allocations determine the remaining balance.':mode.value==='VERIFY_UNPAID'?'Confirms payment information after checking that no allocations exist.':mode.value==='VERIFY_NO_DUE'?'Confirms a known zero or credit statement balance.': 'Keeps the payment ledger and marks its information for review.';
    };mode.addEventListener('change',update);source.addEventListener('change',()=>{date.value='';update();});update();
    let requestId=uuid(),pendingSignature='';
    form.addEventListener('submit',async event=>{event.preventDefault();save.disabled=true;status.textContent='Saving payment information...';try{
      if(!state.boot.workflowRevision)throw Error('Install the BillBills backend update to use statement payment shortcuts.');
      const [kind,id]=source.value.split(':'),paying=['FULL','PARTIAL'].includes(mode.value),data={statementId:r.id,mode:mode.value,source:kind,paymentId:kind==='PAYMENT'?id:'',transactionId:kind==='TRANSACTION'?id:'',amountMinor:paying?toMinor(amount.value,r.currency):0,date:date.value,reference:reference.value};
      const signature=JSON.stringify(data);if(pendingSignature&&pendingSignature!==signature)requestId=uuid();pendingSignature=signature;
      const result=await rpc('apiSave','StatementPayment',data,r._token,requestId);Object.assign(r,result.row);applyWorkflowResult(result);$('dialog').close();const cached=state.pageEntity===state.entity?state.pageResult:null;if(cached)cached.rows=cached.rows.map(x=>x.id===r.id?r:x);await render(cached);notice('Payment information saved. Confirmed allocations determine settlement.');if(onReturn)await onReturn();
    }catch(error){status.textContent=error.message;}finally{save.disabled=false;}});openDialog('Statement payment',form);dialogReturn=onReturn;
  }
  async function synchronizeStatements(){
    await action(async()=>{let result;for(let i=0;i<40;i++){notice('Synchronizing Calendar events...', 'loading');result=await rpc('apiSync');if(result.failed||!result.remaining)break;await new Promise(resolve=>setTimeout(resolve,500));}await refresh();notice(result.message||'Synchronization completed.',result.failed?'error':'');});
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
  function lookup(type,id){return (state.boot.lookups[type]||[]).find(x=>x.id===id)?.label||(['Accounts','Cards'].includes(type)?(id?'Unavailable '+(type==='Cards'?'card':'account'):'—'):id||'—');}
  function display(r,k){if(refs[k])return lookup(refs[k],r[k]);if(/Minor$/.test(k))return money(r[k],r.currency||currencyFor(r));if(r[k]==='')return '—';return String(r[k]??'—');}
  function currencyFor(r){return (state.boot.lookups.BankPayments||[]).find(x=>x.id===r.paymentId)?.currency||(state.boot.lookups.Shares||[]).find(x=>x.id===r.shareId)?.currency||'';}
  function field(name,control,hint){const custom=control.classList.contains('tag-picker'),l=custom?append(el('div','field'),el('span','field-label',label(name))):el('label','',label(name));control.name=name;l.append(control);if(hint)l.append(el('small','',hint));return l;}
  function input(value='',type='text'){const n=el('input');n.type=type;n.value=value;return n;}
  function select(options,value='',empty=true){const n=el('select');if(empty)n.append(new Option('Select…',''));options.forEach(o=>n.append(new Option(typeof o==='string'?label(o):o.label,typeof o==='string'?o:o.id)));n.value=value;return n;}
  let dialogOpener=null;
  let dialogReturn=null;
  function openDialog(title,content){dialogReturn=null;if(!$('dialog').open)dialogOpener=document.activeElement;$('dialog-title').textContent=title;$('dialog-content').replaceChildren(content);$('dialog-error').textContent='';if(!$('dialog').open)$('dialog').showModal();setTimeout(()=>$('dialog-content').querySelector('input,select,textarea,button')?.focus(),0);}
  $('close-dialog').addEventListener('click',()=>{if(dialogReturn)dialogReturn();else $('dialog').close();});
  $('dialog').addEventListener('cancel',e=>{if(dialogReturn){e.preventDefault();dialogReturn();}});
  $('dialog').addEventListener('close',()=>{if(dialogOpener?.isConnected)dialogOpener.focus();});
  $('dialog').addEventListener('keydown',e=>{if(e.key!=='Tab')return;const nodes=[...$('dialog').querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')].filter(n=>n.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}});
  function navigate(area,entity,filters={}){$('context-drawer').close();$('nav-toggle').setAttribute('aria-expanded','false');document.querySelector('.navigation').classList.remove('menu-open');state.area=area;state.entity=entity||areas[area][0]||'';state.filters=area==='Money Owed'?Object.assign({status:'ACTIVE'},filters):filters;state.page=0;state.selected=null;state.sort=state.entity==='Transactions'?'transactionDate:desc':state.entity==='Loans'?'nickname:asc':'updatedAt:desc';renderNav();$('title').textContent=areaName(area);$('title').focus({preventScroll:true});action(render);}
  const navigationGroups={Overview:['Overview'],Activity:['Transactions','Review','Saved Views'],Accounts:['Cards and Accounts','Statements','Bank Payments','Installments','Loans'],Collections:['Money Owed','People','Repayments'],Settings:['Settings and Integration','Configuration']};
  const areaName=area=>area==='Settings and Integration'?'Workspace and Backups':configured('nav.'+area,area);
  function renderNav(){
    const group=Object.keys(navigationGroups).find(k=>navigationGroups[k].includes(state.area))||'Overview';
    $('nav').replaceChildren();$('subnav').replaceChildren();
    Object.entries(navigationGroups).forEach(([name,items])=>{const b=button(name,()=>navigate(items[0]),'nav-item');if(name===group)b.setAttribute('aria-current','true');$('nav').append(b);});
    (group==='Overview'?[]:navigationGroups[group]).forEach(area=>{const b=button(areaName(area),()=>navigate(area),'quiet');if(area===state.area)b.setAttribute('aria-current','page');$('subnav').append(b);});
  }
  let refreshPromise=null;
  function currentView(){return ['Overview','Review','Loans','Settings and Integration'].includes(state.area)?null:{entity:state.entity,filters:{...state.filters},page:state.page,sort:state.sort};}
  function refresh(){
    const version=recordClient.version();
    if(refreshPromise&&refreshPromise.version===version)return refreshPromise.promise;

    notice('Loading current records...', 'loading');
    const view=currentView(),viewKey=JSON.stringify(view),entry={version};
    entry.promise=(async()=>{
      const b=await rpc('apiBootstrap',view);
      if(version!==recordClient.version())return;
      state.boot=b;
      document.querySelector('.brand-title').textContent='BillBills';document.title='BillBills';

      notice(b.overview.invalid?'Invalid records or pending operations need review. Financial overview totals are withheld.':'');
      renderNav();await render(viewKey===JSON.stringify(currentView())?b.currentPage:null);
    })().finally(()=>{if(refreshPromise===entry){refreshPromise=null;}});
    refreshPromise=entry;
    return entry.promise;
  }

  let renderedView='',reviewFocus=null;
  async function render(prefetched){if(!state.boot)return;updateReviewFooter();const seq=++state.sequence,view=state.area+'|'+state.entity,sameView=renderedView===view,scroll=$('main').scrollTop,windowScroll=window.scrollY,tableScroll=$('content').querySelector('.table-scroll')?.scrollLeft||0,focusKey=document.activeElement?.dataset.sortKey,focusName=document.activeElement?.name;$('title').textContent=areaName(state.area);
    const listView=!['Overview','Review','Loans','Settings and Integration'].includes(state.area);
    let result=prefetched;
    if(listView){try{result=result||await recordClient('apiList',[state.entity,{...state.filters},state.page,state.sort],()=>seq===state.sequence);if(seq!==state.sequence)return;}catch(e){if(seq===state.sequence)notice(e.message,'error');return;}}
    inlineRows.clear();$('content').replaceChildren();renderContext();renderedView=view;
    if(state.area==='Overview'){renderOverview();return;}
    if(state.area==='Review'){await renderReview();if(sameView){$('main').scrollTop=scroll;window.scrollTo(0,windowScroll);const table=$('content').querySelector('.table-scroll');if(table)table.scrollLeft=tableScroll;if(focusKey)$('content').querySelector('[data-sort-key="'+CSS.escape(focusKey)+'"]')?.focus({preventScroll:true});else if(reviewFocus){const row=$('content').querySelector('[data-transaction-row="'+CSS.escape(reviewFocus.id)+'"]'),target=row?.querySelector(reviewFocus.field?'[data-inline-field="'+CSS.escape(reviewFocus.field)+'"]':'button')||row?.querySelector('button')||$('content').querySelector('.review-transactions h2');if(target){target.tabIndex=target.tabIndex<0?-1:target.tabIndex;target.focus({preventScroll:true});}}}return;}
    if(state.area==='Loans'){await renderLoans();if(sameView){$('main').scrollTop=scroll;window.scrollTo(0,windowScroll);const table=$('content').querySelector('.table-scroll');if(table)table.scrollLeft=tableScroll;if(focusKey)$('content').querySelector('[data-sort-key="'+CSS.escape(focusKey)+'"]')?.focus({preventScroll:true});}return;}
    if(state.area==='Settings and Integration'){renderSettings();return;}
    renderToolbar();const container=el('div');$('content').append(container);renderTable(container,result);if(sameView){$('main').scrollTop=scroll;window.scrollTo(0,windowScroll);const table=$('content').querySelector('.table-scroll');if(table)table.scrollLeft=tableScroll;if(focusKey)$('content').querySelector('[data-sort-key="'+CSS.escape(focusKey)+'"]')?.focus({preventScroll:true});else if(focusName)$('content').querySelector('[name="'+CSS.escape(focusName)+'"]')?.focus({preventScroll:true});}
  }
  function renderOverview(){const o=state.boot.overview,c=$('content');
    const upcoming=el('section','card');append(upcoming,el('h2','','Upcoming Statements'));
    if(!o.upcoming.length)upcoming.append(el('p','subtle','No outstanding statements with a due date.'));
    o.upcoming.forEach(s=>{const item=button('',()=>openStatement(s.id),'statement-overview');const account=(state.boot.lookups.Accounts||[]).find(a=>a.id===s.accountId);const due=statementDueLabel(s.dueDate,state.boot.today);append(item,el('strong','',account?.label||lookup('Accounts',s.accountId)),el('strong','',money(s.remainingMinor,s.currency)),el('span','','Due '+s.dueDate),el('span',s.dueDate<state.boot.today?'badge overdue':'badge',due));const cards=(state.boot.lookups.Cards||[]).filter(c=>c.accountId===s.accountId);upcoming.append(item);});upcoming.classList.add('statement-grid');c.append(upcoming);renderUpcomingLoans(c);

    if(o.invalid)c.append(el('div','review-banner','Totals are unavailable until invalid records and pending operations are resolved. Open Review for details.'));
    const metrics=el('div','metrics');metrics.id='overview-metrics';Object.entries(o.totals).forEach(([cur,t])=>{
      [['Classified spending',t.spendingMinor,'Transactions',{currency:cur,status:'ACTIVE',spending:'true'},'Charges only · posted installment basis'],['Money owed to you',t.owedMinor,'Money Owed',{currency:cur,status:'ACTIVE'},'Confirmed receipts and credits deducted'],[t.unknownStatements&&t.knownStatements?'Known statement remainder':'Statement remainder',t.statementRemainingMinor,'Statements',{currency:cur,status:'OPEN'},t.unknownStatements+' statements have unknown balances'],['Cash received',t.cashMinor,'Repayments',{currency:cur,status:'CONFIRMED',type:'CASH'},'Personal repayments only']].forEach(([title,n,area,filters,hint])=>{
        const b=button('',()=>navigate(area,undefined,filters),'metric');append(b,el('span','',title),el('strong','',money(n,cur)),el('span','',hint));metrics.append(b);
      });
    });if(metrics.childNodes.length)c.append(metrics);else if(!o.invalid){const e=el('div','empty');append(e,el('h2','','Your workspace is ready to begin'),el('p','','Start with a billing account and a masked card. Add statements from official bank records, or preview a sanitized transaction import.'),button('Add an account',()=>editRecord('Accounts')));c.append(e);}
    renderCharts(c);
    const recent=el('section','card');append(recent,el('h2','','Recent transactions'));simpleTable(recent,'Transactions',o.recent);c.append(recent);
  }
  let chartEnd='',chartCurrency='';
  function renderCharts(container){
    const section=el('section','card');container.append(section);const requested=chartEnd||state.boot.today.slice(0,7),seq=state.sequence;
    const draw=data=>{if(!section.isConnected||seq!==state.sequence)return;section.replaceChildren();if(data.invalid)return;const currencies=Object.keys(data.currencies);if(!currencies.length)return;if(!currencies.includes(chartCurrency))chartCurrency=currencies[0];const group=data.currencies[chartCurrency],toolbar=el('div','toolbar'),currency=select(currencies.map(id=>({id,label:id})),chartCurrency,false);currency.setAttribute('aria-label','Chart currency');currency.addEventListener('change',()=>{chartCurrency=currency.value;draw(data);});const move=amount=>{chartEnd=new Date(Date.UTC(+requested.slice(0,4),+requested.slice(5,7)-1+amount,1)).toISOString().slice(0,7);section.remove();renderCharts(container);};const next=button('Next year',()=>move(12));next.disabled=requested>=state.boot.today.slice(0,7);append(toolbar,button('Previous year',()=>move(-12)),next,button('Latest 12 months',()=>{chartEnd='';section.remove();renderCharts(container);}),currency);const settings=el('div','chart-settings');settings.setAttribute('popover','auto');settings.append(toolbar);const toggle=button('Chart settings',()=>{const rect=toggle.getBoundingClientRect();settings.style.margin='0';settings.style.inset='auto';settings.style.right=Math.max(16,innerWidth-rect.right)+'px';settings.style.top=Math.min(rect.bottom+8,innerHeight-200)+'px';settings.togglePopover();},'chart-settings-button');toggle.setAttribute('aria-label','Chart settings');toggle.textContent='\u2699';settings.addEventListener('toggle',e=>{toggle.setAttribute('aria-expanded',String(e.newState==='open'));if(e.newState==='closed')toggle.focus({preventScroll:true});else settings.querySelector('button')?.focus();});append(section,el('h2','','Recorded spending by posting month'),toggle,settings);
      const period={currency:chartCurrency,status:'ACTIVE',spending:'true',dateBasis:'postingDate',from:group.months[0].month+'-01',to:new Date(Date.UTC(+requested.slice(0,4),+requested.slice(5,7),0)).toISOString().slice(0,10)};
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');const plotWidth=Math.max(440,Math.min(800,innerWidth-96)),step=(plotWidth-96)/11;svg.setAttribute('viewBox','0 0 '+plotWidth+' 300');svg.setAttribute('role','group');svg.setAttribute('aria-label','Monthly spending trend. Focus or tap a point to see its month and amount.');svg.classList.add('spending-line');const max=Math.max(1,...group.months.map(m=>m.amountMinor)),line=document.createElementNS(svg.namespaceURI,'polyline');line.setAttribute('points',group.months.map((m,i)=>(70+i*step)+','+(240-m.amountMinor/max*200)).join(' '));line.setAttribute('fill','none');line.setAttribute('stroke','#0071E3');line.setAttribute('stroke-width','3');const text=(x,y,value,anchor='middle')=>{const t=document.createElementNS(svg.namespaceURI,'text');t.setAttribute('x',x);t.setAttribute('y',y);t.setAttribute('text-anchor',anchor);t.setAttribute('fill','#717785');t.setAttribute('font-size',plotWidth<600?'14':'12');t.textContent=value;svg.append(t);};for(let i=0;i<=4;i++){const y=240-i*50,axis=document.createElementNS(svg.namespaceURI,'line');axis.setAttribute('x1','70');axis.setAttribute('x2',plotWidth-26);axis.setAttribute('y1',y);axis.setAttribute('y2',y);axis.setAttribute('stroke','#D2D2D7');axis.setAttribute('stroke-opacity',i===0?'1':'.35');svg.append(axis);text(60,y+4,new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(Number(decimal(max*i/4,chartCurrency))),'end');}group.months.forEach((m,i)=>{const date=new Date(m.month+'-01T00:00:00Z');text(70+i*step,265,date.toLocaleString('en',{month:'short',timeZone:'UTC'}));if(i===0||m.month.endsWith('-01'))text(70+i*step,287,m.month.slice(0,4));});svg.append(line);group.months.forEach((m,i)=>{const dot=document.createElementNS(svg.namespaceURI,'circle');dot.setAttribute('cx',70+i*step);dot.setAttribute('cy',240-m.amountMinor/max*200);dot.setAttribute('r','6');dot.setAttribute('fill','#0071e3');dot.setAttribute('tabindex','0');dot.setAttribute('role','link');dot.setAttribute('aria-label',m.month+' '+money(m.amountMinor,chartCurrency));const tip=el('div','chart-tooltip');tip.hidden=true;section.append(tip);const show=()=>{tip.textContent=m.month+' / '+money(m.amountMinor,chartCurrency);tip.hidden=false;};const hide=()=>tip.hidden=true;dot.addEventListener('mouseenter',show);dot.addEventListener('mouseleave',hide);dot.addEventListener('focus',show);dot.addEventListener('blur',hide);dot.addEventListener('click',show);dot.addEventListener('keydown',e=>{if(e.key==='Escape')hide();else if(e.key==='Enter'||e.key===' '){e.preventDefault();show();}});dot.setAttribute('role','button');svg.append(dot);});section.append(svg);      const split=el('div','split');for(const [key,title]of [['currentCards','Spending by card']]){const panel=el('div');panel.append(el('h3','',title),el('p','subtle','Current month'));const max=Math.max(1,...group[key].map(v=>v.amountMinor));for(const value of group[key].slice().sort((a,b)=>b.amountMinor-a.amountMinor)){const name=key==='currentCards'?(value.id?lookup('Cards',value.id):'No card'):(typeGuide[value.id]?.[0]||value.id),entry=button(name+' '+money(value.amountMinor,chartCurrency),()=>navigate('Transactions',undefined,{...period,from:data.currentMonth+'-01',to:new Date(Date.UTC(+data.currentMonth.slice(0,4),+data.currentMonth.slice(5,7),0)).toISOString().slice(0,10),...(key==='currentCards'?(value.id?{cardId:value.id}:{noCard:'true'}):{type:value.id})}),'chart-breakdown');const bar=el('span','chart-bar');bar.style.width=(value.amountMinor/max*100)+'%';entry.append(bar);panel.append(entry);}if(!group[key].length)panel.append(el('p','','No recorded spending in this period.'));split.append(panel);}section.append(split);if(group.undatedCount)section.append(button(group.undatedCount+' spending transactions without a posting date',()=>navigate('Transactions',undefined,{currency:chartCurrency,status:'ACTIVE',spending:'true',undated:'true'})));
    };
    if(!chartEnd&&state.boot.overview.charts)draw(state.boot.overview.charts);else recordClient('apiList',['OverviewCharts',{endMonth:requested},0,''],()=>seq===state.sequence&&section.isConnected).then(draw).catch(e=>{if(section.isConnected)section.textContent=e.message;});
  }
  function renderContext(){const c=$('context');c.replaceChildren();append(c,el('p','eyebrow','AT A GLANCE'),el('h2','','Upcoming Statements'));const o=state.boot.overview;
    o.upcoming.forEach(s=>{const d=el('div','upcoming');append(d,el('strong','',lookup('Accounts',s.accountId)),el('span','',s.dueDate+' · '+money(s.remainingMinor,s.currency)),el('p','subtle',s.reconciliation==='VERIFIED'?'Payment information verified':'Payment information unverified'));d.append(button('View statement',()=>openStatement(s.id),'quiet'));c.append(d);});
    if(!o.upcoming.length)c.append(el('p','subtle','No upcoming statements recorded.'));
    const note=el('div','context-note');append(note,el('strong','','Data freshness'),el('p','',o.freshness?'Latest recorded activity date: '+o.freshness:'No transactions imported.'),el('p','','Bank payments and personal repayments have separate histories.'));c.append(note);
  }
  function renderToolbar(){
    const c=$('content'),tabs=areas[state.area];if(tabs.length>1){const t=el('div','section-tabs');tabs.forEach(e=>t.append(button(label(e),()=>{state.entity=e;state.filters={};state.page=0;render();},e===state.entity?'active':'')));c.append(t);}
    const bar=el('div','toolbar'),search=input(state.filters.q||'','search');search.placeholder='Descriptions, names and notes';search.setAttribute('aria-label','Search');search.addEventListener('change',()=>{if(search.value.trim())state.filters.q=search.value.trim();else delete state.filters.q;state.page=0;render();});bar.append(field('Search',search));const filters=button('Filters',showTableFilters);filters.prepend(icon('filter'));bar.append(filters);
    if(['Transactions','Loans'].includes(state.entity)){const edit=button('Edit',()=>{for(const row of state.pageResult?.rows||[])inlineRows.add(row.id);paintInlineRows();paintLoanRows();updateReviewFooter();});edit.id='edit-page';edit.disabled=reviewSaving||!!reviewJob;edit.classList.add('toolbar-edit');bar.append(edit);}
    bar.append(button(state.entity==='Loans'?'Add loan':'Add '+label(state.entity).toLowerCase(),()=>state.entity==='Loans'?editLoan():editRecord(state.entity)));
    if(state.entity==='Transactions')append(bar,button('Import CSV',showImport),button('Import reviewed package',showPackageImport),button('Type guide',showTypeGuide));
    if(state.entity==='Shares')bar.append(button('Preview report',showReport));
    if(['Transactions','Shares','Statements','BankPayments','Repayments'].includes(state.entity))bar.append(button('Save this view',()=>editRecord('SavedViews',{name:'',scope:state.entity,filters:JSON.stringify(state.filters),sort:state.sort,status:'ACTIVE'})));
    bar.dataset.recordToolbar='true';c.append(bar);const chips=el('div','toolbar');for(const [key,value]of Object.entries(state.filters)){if(!value||Array.isArray(value)&&!value.length)continue;chips.append(button(label(key)+': '+(refs[key]?lookup(refs[key],value):Array.isArray(value)?value.map(v=>key==='type'?(typeGuide[v]?.[0]||v):v).join(', '):value)+' x',()=>{delete state.filters[key];state.page=0;render();}));}if(chips.childNodes.length)chips.append(button('Clear filters',()=>{state.filters={};state.page=0;render();}));c.append(chips);
  }
  function showTableFilters(){
    const values=structuredClone(state.filters),box=el('div','form-grid'),controls={},entity=state.entity;
    const add=(key,control)=>{control.setAttribute('aria-label',label(key));controls[key]=control;box.append(field(key,control));};
    const columns=displays[entity]||[],accountEntities=['Transactions','Statements','BankPayments','InstallmentPlans','Cards','Shares'];
    if(accountEntities.includes(entity))add('accountId',select(state.boot.lookups.Accounts||[],values.accountId||''));
    if(['Transactions','Cards','Shares','InstallmentPlans'].includes(entity)){add('cardId',select((state.boot.lookups.Cards||[]).filter(c=>!values.accountId||c.accountId===values.accountId),values.cardId||''));}
    if(['Transactions','Statements'].includes(entity))add('statementDate',select([...new Set((state.boot.lookups.Statements||[]).filter(r=>!values.accountId||r.accountId===values.accountId).map(r=>r.statementDate).filter(Boolean))].sort().reverse(),values.statementDate||''));
    if(controls.accountId)controls.accountId.addEventListener('change',()=>{const account=controls.accountId.value;if(controls.cardId){const cards=(state.boot.lookups.Cards||[]).filter(c=>!account||c.accountId===account),old=controls.cardId.value;controls.cardId.replaceChildren(...select(cards,cards.some(c=>c.id===old)?old:'').childNodes);}if(controls.statementDate)controls.statementDate.replaceChildren(...select([...new Set((state.boot.lookups.Statements||[]).filter(r=>!account||r.accountId===account).map(r=>r.statementDate).filter(Boolean))].sort().reverse(),'').childNodes);});
    if(entity==='Transactions'){const types=select(typeOptions(),'',false);types.multiple=true;types.size=5;const chosen=Array.isArray(values.type)?values.type:values.type?[values.type]:[];for(const option of types.options)option.selected=chosen.includes(option.value);add('type',types);add('reviewStatus',select(state.boot.enums['Transactions.reviewStatus'],values.reviewStatus||''));add('category',input(values.category||''));}
    if(['Transactions','Shares'].includes(entity)){add('tag',select(state.boot.tagOptions||[],values.tag||''));add('personId',select(state.boot.lookups.People||[],values.personId||''));}
    if(columns.includes('currency'))add('currency',select(Object.keys(state.boot.currencies),values.currency||''));
    if(state.boot.enums[entity+'.status'])add('status',select(state.boot.enums[entity+'.status'],values.status||''));
    if(entity==='Shares'){add('requestStatus',select(state.boot.enums['Shares.requestStatus'],values.requestStatus||''));add('expectedState',select(['PAST_EXPECTED_DATE','NOT_PAST_EXPECTED_DATE'],values.expectedState||''));}
    if(['Shares','Statements'].includes(entity))add('settlement',select(['OPEN','PARTIAL','SETTLED','UNKNOWN'],values.settlement||''));
    if(dateBases[entity]){add('dateBasis',select(dateBases[entity],values.dateBasis||dateBases[entity][0],false));add('from',input(values.from||'','date'));add('to',input(values.to||'','date'));}
    const apply=button('Apply filters',()=>{for(const [key,control]of Object.entries(controls)){const value=control.multiple?[...control.selectedOptions].map(o=>o.value):control.value;if(!value||Array.isArray(value)&&!value.length)delete values[key];else values[key]=value;}state.filters=values;state.page=0;$('dialog').close();render();},'primary');box.append(apply);openDialog('Filters',box);
  }
  function updateInlineState(){const edit=$('edit-page');if(edit)edit.disabled=reviewSaving||!!reviewJob;document.querySelectorAll('[data-inline-field]').forEach(n=>n.disabled=reviewSaving||!!reviewJob);}
  function inlineCell(td,row,key){td.replaceChildren();if(!inlineRows.has(row.id)&&!transactionDrafts.has(row.id)){td.textContent=display(row,key);return;}const value=transactionDrafts.track(row)[key],control=key==='type'?select(typeOptions(),value,false):key==='reviewStatus'?select(state.boot.enums['Transactions.reviewStatus'].map(id=>({id,label:id==='REVIEW'?'Needs verification':id==='VERIFIED'?'Verified':'Check possible duplicate'})),value,false):input(value,key==='dueDate'?'date':'text');control.dataset.inlineField=key;control.setAttribute('aria-label',label(key)+' for '+row.description);control.disabled=reviewSaving||!!reviewJob;control.addEventListener('change',()=>{transactionDrafts.stage(row,{[key]:control.value});reviewMessage='';updateReviewFooter();});td.append(control);}
  function paintInlineRows(){for(const tr of document.querySelectorAll('[data-transaction-row]')){const row=state.pageResult?.rows.find(r=>r.id===tr.dataset.transactionRow);if(row)for(const key of inlineFields){const cell=tr.querySelector('[data-field="'+key+'"]');if(cell)inlineCell(cell,row,key);}}}
  const columnChoices=new Map();
  function columnPicker(container,table,entity,columns){
    if(!columnChoices.has(entity))columnChoices.set(entity,new Set(columns.filter(k=>!['category','tags','notes'].includes(k))));
    const chosen=columnChoices.get(entity);if(state.area==='Review'){chosen.add('needsAttention');chosen.add('reviewFix');}const panel=el('div','chart-settings column-settings');panel.setAttribute('popover','auto');
    const apply=()=>table.querySelectorAll('[data-field]').forEach(cell=>cell.hidden=!chosen.has(cell.dataset.field));
    const checks=new Map();
    for(const key of columns){const check=input('','checkbox');check.checked=chosen.has(key);check.disabled=key===columns[0]||['needsAttention','reviewFix'].includes(key);check.addEventListener('change',()=>{check.checked?chosen.add(key):chosen.delete(key);apply();});checks.set(key,check);panel.append(append(el('label','check-label'),check,document.createTextNode(label(key))));}
    panel.append(button('Reset columns',()=>{chosen.clear();columns.filter(k=>!['category','tags','notes'].includes(k)||k===columns[0]).forEach(k=>chosen.add(k));checks.forEach((check,key)=>check.checked=chosen.has(key));apply();},'quiet'));
    const toggle=button('Columns',()=>{const rect=toggle.getBoundingClientRect();panel.style.margin='0';panel.style.inset='auto';panel.style.left=Math.max(16,Math.min(rect.left,innerWidth-280))+'px';const top=Math.max(16,Math.min(rect.bottom+6,innerHeight-Math.min(560,innerHeight*.7)-16));panel.style.top=top+'px';panel.style.maxHeight=(innerHeight-top-16)+'px';panel.togglePopover();},'quiet');
    toggle.setAttribute('aria-expanded','false');panel.addEventListener('toggle',e=>{toggle.setAttribute('aria-expanded',String(e.newState==='open'));if(e.newState==='open')panel.querySelector('input:not(:disabled)')?.focus();else toggle.focus({preventScroll:true});});
    const actions=el('div','table-actions'),edit=$('content').querySelector('#edit-page');actions.append(toggle);if(edit)actions.append(edit);const toolbar=$('content').querySelector('[data-record-toolbar]');(toolbar||container).append(actions);container.append(panel);apply();
  }
  function simpleTable(container,entity,rows){
    if(!rows.length){container.append(el('div','empty','No records to display.'));return;}
    const wrap=el('div','table-scroll');wrap.tabIndex=0;wrap.setAttribute('aria-label',label(entity)+' table');const table=el('table'),head=el('thead'),tr=el('tr'),columns=state.area==='Overview'&&entity==='Transactions'?['description','cardId','transactionDate','dueDate','amountMinor','currency','type']:(displays[entity]||[]).concat(state.area==='Review'&&entity==='Transactions'?['needsAttention','reviewFix']:[]),list=state.entity===entity&&state.area!=='Overview';
    for(const key of columns){const th=el('th');th.scope='col';th.dataset.field=key;if(list&&!['assignedShares','needsAttention','reviewFix'].includes(key)){const active=state.sort.split(':');th.setAttribute('aria-sort',active[0]===key?(active[1]==='asc'?'ascending':'descending'):'none');const sort=button(label(key)+(active[0]===key?(active[1]==='asc'?' \u2191':' \u2193'):''),()=>{const current=state.sort.split(':');state.sort=key+':'+(current[0]===key&&current[1]==='asc'?'desc':'asc');state.page=0;render();},'table-sort');sort.dataset.sortKey=key;th.append(sort);}else th.textContent=label(key);tr.append(th);}head.append(tr);table.append(head);const body=el('tbody');
    for(const row of rows){const tr=el('tr');if(entity==='Transactions'&&list)tr.dataset.transactionRow=row.id;if(entity==='Loans')tr.dataset.loanRow=row.id;columns.forEach((key,index)=>{const td=el('td');td.dataset.field=key;if(entity==='Loans'&&key==='scheduledRemainingMinor'){td.textContent=money(row.scheduledRemainingMinor,row.currency)+(row.unknownInstallments?' + '+row.unknownInstallments+' amounts not set':'');}else if(entity==='Loans'&&loanFields.includes(key)){loanCell(td,row,key);}else if(entity==='Loans'&&index===0)td.append(button(display(row,key),()=>openLoan(row.id)));else if(key==='needsAttention'){for(const issue of row.reviewIssues||[])td.append(el('div','review-reason',issue.message));}else if(key==='reviewFix'){const seen=new Set();for(const issue of row.reviewIssues||[]){const kind=/installment|principal/i.test(issue.message)?'installment':/activity type/i.test(issue.message)?'type':/share/i.test(issue.message)?'shares':'record';if(seen.has(kind))continue;seen.add(kind);td.append(button({installment:'Set installment details',type:'Choose type',shares:'Review shares',record:'Fix record'}[kind],()=>fixReviewTransaction(row,kind)));}}else if(entity==='Transactions'&&key==='assignedShares'){const shares=row.assignedShares||[];for(const share of shares)td.append(el('div','',lookup('People',share.personId)+' '+money(share.amountMinor,row.currency)));td.append(button(shares.length?'Edit shares':'Assign shares',()=>shareEditor(row)));}else if(entity==='Transactions'&&list&&inlineFields.includes(key))inlineCell(td,row,key);else if(index===0)td.append(button(display(row,key),()=>showDetails(entity,row),''));else if(entity==='Statements'&&key==='settlement')td.append(statementPaymentPicker(row));else td.textContent=display(row,key);tr.append(td);});body.append(tr);}table.append(body);wrap.append(table);if(state.area!=='Overview')columnPicker(container,table,entity,columns);container.append(wrap);
  }
  function renderTable(container,result){state.pageResult=result;state.pageEntity=state.entity;if(result.issues.some(x=>x.severity==='ERROR'))container.append(el('div','review-banner','This table contains invalid records. Treat calculated values as provisional until repaired.'));
    if(result.summary){Object.entries(result.summary).forEach(([cur,t])=>{const panel=el('section','card');panel.append(el('h2','','Collections · '+cur));const metrics=el('div','metrics');[['Assigned',t.assigned],['Cash received',t.cash],['Credits / waivers',t.credits],['Remaining owed',t.remaining]].forEach(([name,n])=>{const d=el('div','metric');append(d,el('span','',name),el('strong','',money(n,cur)));metrics.append(d);});panel.append(metrics);const counts=el('div','toolbar');[['Not requested',t.notRequested,{requestStatus:'NOT_REQUESTED'}],['Partially settled',t.partial,{settlement:'PARTIAL'}],['Settled',t.settled,{settlement:'SETTLED'}],['Disputed',t.disputed,{requestStatus:'DISPUTED'}],['Past expected date',t.pastExpected,{expectedState:'PAST_EXPECTED_DATE'}]].forEach(([name,n,f])=>counts.append(button(name+' ('+n+')',()=>{state.filters=Object.assign({},state.filters,f,{currency:cur});state.page=0;render();})));append(panel,el('p','subtle','Active shares within the current filters. Request status and settlement are independent.'),counts);container.append(panel);});}
    simpleTable(container,state.entity,result.rows);const pager=el('div','pager');pager.append(el('span','',result.total+' records · page '+(result.page+1)+' of '+Math.max(1,Math.ceil(result.total/40))));const controls=el('div');const prev=button('Previous',()=>{state.page--;render();}),next=button('Next',()=>{state.page++;render();});prev.disabled=result.page===0;next.disabled=(result.page+1)*40>=result.total;append(controls,prev,next);pager.append(controls);container.append(pager);}
  function originalTransaction(container,share){
    const section=el('section','card');section.append(el('h3','','Original transaction'));container.append(section);
    const current=()=>state.selected===share&&section.isConnected;
    if(!share.transactionId){section.append(el('p','','No original transaction is linked.'));return;}
    recordClient('apiList',['Transactions',{recordId:share.transactionId},0,'updatedAt:desc'],current).then(result=>{if(!current()||!result)return;const transaction=result.rows[0];if(!transaction){section.append(el('p','','The original transaction is unavailable.'));return;}append(section,el('p','',transaction.description),el('p','',lookup('Cards',transaction.cardId)+' � '+lookup('Accounts',transaction.accountId)),el('p','',transaction.transactionDate+' � '+money(transaction.amountMinor,transaction.currency)));if(transaction.status==='VOID')section.append(el('p','','This transaction is voided.'));section.append(button('Open original transaction',()=>{showDetails('Transactions',transaction);const back=button('Back to Money owed',()=>{showDetails('Shares',share);const heading=$('context').querySelector('h2');heading.tabIndex=-1;heading.focus({preventScroll:true});});$('context').prepend(back);back.focus();}));}).catch(error=>{if(current())section.append(el('p','error',error.message));});
  }
  async function openStatement(id){return action(async()=>{const data=await rpc('apiList','Statements',{recordId:id},0,'');const r=data.rows[0];if(!r)throw Error('Statement is unavailable.');const box=el('div','loan-details'),grid=el('div','record-detail-grid');box.append(el('h3','',lookup('Accounts',r.accountId)));for(const [name,value]of [['Statement date',r.statementDate],['Due date',r.dueDate],['Official balance',money(r.balanceMinor,r.currency)],['Allocated payments',money(r.paidMinor,r.currency)],['Remaining balance',money(r.remainingMinor,r.currency)],['Status',statementPaymentLabel(r)]]){const cell=el('div','detail-row');append(cell,el('span','',name),el('strong','',value));grid.append(cell);}box.append(grid);const back=()=>openStatement(id),actions=el('div','editor-secondary');append(actions,button('Edit statement',()=>editRecord('Statements',r,back)),button('Record payment',()=>showStatementPayment(r,'FULL',back)),button('Allocate bank payment',()=>editRecord('PaymentAllocations',{statementId:r.id,status:'ACTIVE'},back)));box.append(actions);openDialog('Statement details',box);});}
  function showDetails(entity,r){state.selected=r;const c=$('context');c.replaceChildren();append(c,el('h2','',label(entity)));const details=el('div','record-detail-grid');Object.keys(r).filter(k=>!k.startsWith('_')&&k!=='id'&&!technical.has(k)&&k!=='revision').forEach(k=>{const d=el('div','detail-row');if(['notes','originalDescription','description'].includes(k))d.classList.add('wide');append(d,el('span','',label(k)),el('strong','',k==='totals'?Object.entries(r.totals).map(([cur,n])=>money(n,cur)).join(', '):display(r,k)));details.append(d);});c.append(details);const technicalDetails=el('details');technicalDetails.append(el('summary','','Technical details'));Object.keys(r).filter(k=>k==='id'||k.endsWith('Id')||technical.has(k)).forEach(k=>technicalDetails.append(el('p','subtle',k+': '+(r[k]||'—'))));c.append(technicalDetails);c.append(button('Edit record',()=>editRecord(entity,r)));
    if(entity==='Transactions'){const section=el('section');section.append(el('h3','','Installment plan'));const plan=(state.boot.lookups.InstallmentPlans||[]).find(p=>p.id===r.installmentPlanId);section.append(el('p','',plan?plan.label+' / '+(r.installmentNumber||'Not set')+' of '+plan.count:'No installment plan assigned'));section.append(button('Edit installment details',()=>editRecord('Transactions',r)));c.append(section);c.append(button('Link installment charges',()=>linkInstallments(r)));}
    if(entity==='Transactions')c.append(button('Assign shares',()=>shareEditor(r)));
    if(entity==='Transactions'){const panel=el('section','card');append(panel,el('h3','','Classify and review'),transactionControls(r));c.append(panel);}
    if(entity==='Statements')c.append(statementPaymentPicker(r));
    if(entity==='Shares')originalTransaction(c,r);
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
  function linkInstallments(record){
    const box=el('div'),plans=(state.boot.lookups.InstallmentPlans||[]).filter(p=>p.status!=='ARCHIVED'&&p.accountId===record.accountId&&p.currency===record.currency&&(!p.cardId||p.cardId===record.cardId));
    const plan=select(plans,record.installmentPlanId||''),search=input('','search'),list=el('div'),selected=new Map();let page=0,sequence=0,requestId=uuid(),retryPayload=null;
    plan.setAttribute('aria-label','Installment plan ID');search.placeholder='Search existing charges';
    append(box,el('p','subtle','Choose an installment plan, then select existing charges and their installment numbers. Amounts and dates stay unchanged. Link up to 10 charges at a time.'),field('Installment plan ID',plan),button('Create installment plan',()=>editRecord('InstallmentPlans',{accountId:record.accountId,cardId:record.cardId,currency:record.currency,startDate:record.transactionDate,monthlyMinor:record.amountMinor,reference:record.description})),field('Search charges',search),list);
    const save=button('Link selected charges',async()=>{try{
      if(!plan.value||!selected.size)throw Error('Choose a plan and select charges first.');
      if([...selected.keys()].some(id=>transactionDrafts.has(id)))throw Error('Save or discard pending transaction selections before linking these charges.');
      retryPayload=retryPayload||{planId:plan.value,items:[...selected.values()]};save.disabled=true;
      try{const result=await rpc('apiSave','InstallmentLinks',retryPayload,'',requestId);applyReviewRows(result.rows||[]);applyWorkflowResult(result);$('dialog').close();$('context-drawer').close();await render();notice('Installment charges linked.');}
      finally{save.disabled=false;}
    }catch(error){$('dialog-error').textContent=error.message;}});box.append(append(el('div','form-actions installment-actions'),save));
    function changed(){retryPayload=null;requestId=uuid();}
    async function load(){const current=++sequence;const result=await rpc('apiList','Transactions',{accountId:record.accountId,currency:record.currency,status:'ACTIVE',q:search.value},page,'transactionDate:asc');if(current!==sequence)return;list.replaceChildren();
      const chosen=plans.find(p=>p.id===plan.value);if(chosen)list.append(el('p','subtle','Plan ID: '+chosen.id));
      result.rows.forEach(r=>{const line=el('div','installment-charge'),check=input('','checkbox'),number=input(selected.get(r.id)?.number||r.installmentNumber||'','number');number.min='1';number.max=String(chosen?.count||600);number.step='1';
        const eligible=chosen&&Number(r.amountMinor)>0&&['UNKNOWN','PURCHASE','INSTALLMENT'].includes(r.type)&&(!chosen.cardId||r.cardId===chosen.cardId)&&(!r.installmentPlanId||r.installmentPlanId===chosen.id);
        check.checked=selected.has(r.id);check.disabled=!eligible;number.disabled=!check.checked;
        const caption=r.transactionDate+' · '+r.description+' · '+money(r.amountMinor,r.currency);
        check.addEventListener('change',()=>{if(check.checked&&selected.size>=10){check.checked=false;notice('Select up to 10 charges per batch.','error');return;}changed();number.disabled=!check.checked;if(check.checked)selected.set(r.id,{id:r.id,token:r._token,number:Number(number.value)});else selected.delete(r.id);});
        number.addEventListener('input',()=>{changed();if(selected.has(r.id))selected.get(r.id).number=Number(number.value);});
        const choice=el('label','installment-choice');append(choice,check,el('span','',caption));append(line,choice,field('Installment number',number));list.append(line);
      });
      const previous=button('Previous',()=>{page--;action(load);}),next=button('Next',()=>{page++;action(load);});previous.disabled=page===0;next.disabled=(page+1)*40>=result.total;append(list,append(el('div','pager'),previous,el('span','',selected.size+' selected'),next));
    }
    plan.addEventListener('change',()=>{selected.clear();changed();page=0;action(load);});search.addEventListener('change',()=>{page=0;action(load);});openDialog('Link installment charges',box);action(load);
  }
  function installmentPrincipalPicker(grid,controls){
    const hidden=controls.originTransactionId,box=el('div','wide'),summary=el('p'),search=input('','search'),results=el('div');search.placeholder='Search financed principal transactions';search.setAttribute('aria-label','Search financed principal transactions');hidden.closest('label').hidden=true;append(box,el('h3','','Financed principal transaction'),summary,search,button('Clear selection',()=>{hidden.value='';summary.textContent='No principal selected';}),results);grid.append(box);let page=0,sequence=0;

    const title=r=>r.description+' | '+r.transactionDate+' | '+lookup('Cards',r.cardId)+' | '+money(r.amountMinor,r.currency);
    const load=async()=>{const seq=++sequence;if(!controls.accountId.value){results.textContent='Choose an account first.';return;}try{const data=await rpc('apiList','Transactions',{accountId:controls.accountId.value,cardId:controls.cardId.value,currency:controls.currency.value,type:'FINANCED_PRINCIPAL',status:'ACTIVE',q:search.value},page,'transactionDate:desc');if(seq!==sequence||!box.isConnected)return;results.replaceChildren();for(const row of data.rows)results.append(button(title(row),()=>{hidden.value=row.id;summary.textContent=title(row);}));if(!data.rows.length)results.textContent='No matching principal transactions.';const previous=button('Previous',()=>{page--;load();}),next=button('Next',()=>{page++;load();});previous.disabled=!page;next.disabled=(page+1)*40>=data.total;append(results,previous,next);}catch(e){if(seq===sequence)results.textContent=e.message;}};
    search.addEventListener('change',()=>{page=0;load();});for(const key of ['accountId','cardId','currency'])controls[key].addEventListener('change',()=>{hidden.value='';summary.textContent='Select a principal for these account details.';page=0;queueMicrotask(load);});
    summary.textContent=hidden.value?'Loading selected principal...':'No principal selected';const initialId=hidden.value;if(initialId)rpc('apiList','Transactions',{recordId:initialId},0,'updatedAt:desc').then(data=>{if(!box.isConnected||hidden.value!==initialId)return;const row=data.rows[0];summary.textContent=row?title(row):'Selected transaction is unavailable';}).catch(e=>{if(box.isConnected)summary.textContent=e.message;});setTimeout(load,0);
  }
  function editRecord(entity,record={},onReturn){
    const form=el('form'),grid=el('div','form-grid'),controls={};const isEdit=!!record.id;
    const defaults={status:entity==='Statements'?'OPEN':['BankPayments','Repayments'].includes(entity)?'PENDING':'ACTIVE',reviewStatus:'REVIEW',relationship:'PRIMARY',type:entity==='Repayments'?'CASH':'PURCHASE',requestStatus:'NOT_REQUESTED',reconciliation:'UNVERIFIED',calendarMode:'OFF',currency:state.boot.settings.DefaultCurrency||'',filters:'{}',sort:'updatedAt:desc'};
    const editable=state.boot.schema[entity].split(' ').filter(k=>!technical.has(k));
    editable.forEach(k=>{
      let value=record[k]??defaults[k]??'',n;const options=state.boot.enums[entity+'.'+k];
      if(entity==='InstallmentPlans'&&k==='originTransactionId'){n=input(value);n.type='hidden';}
      else if(refs[k])n=select(state.boot.lookups[refs[k]]||[],value);
      else if(entity==='Transactions'&&k==='tags')n=tagPicker(value);
      else if(entity==='Transactions'&&k==='type')n=select(typeOptions(),value,false);
      else if(options)n=select(options,value);
      else if(k==='currency')n=select(Object.keys(state.boot.currencies),value);
      else if(['notes','originalDescription','filters'].includes(k)){n=el('textarea');n.value=value;}
      else if(/Minor$/.test(k))n=input(value===''?'':decimal(value,record.currency||currencyFor(record)||state.boot.settings.DefaultCurrency),'text');
      else if(/Date$|^date$|^periodStart$|^periodEnd$/.test(k))n=input(value,'date');
      else n=input(value);
      n.id='edit-'+k;n.required=(state.boot.required[entity]||'').split(' ').includes(k);controls[k]=n;
      const hints={dueDate:entity==='Transactions'?'Optional due date for this transaction. This does not change the statement due date.':'',tags:'Comma-separated labels. Tags do not create obligations.',lastFour:'Exactly four digits. Never enter full card numbers.',balanceMinor:'Official bank statement balance. Leave blank if unknown.',minimumMinor:'Official minimum due. Leave blank if unknown.',reconciliation:'VERIFIED means you have checked bank-payment information.',notes:'Private; excluded from shareable reports.',amountMinor:'Decimal currency amount. No thousands separators.',status:['BankPayments','Repayments'].includes(entity)?'Confirm only after verifying receipt. Reverse corrections; keep history.':'',filters:'JSON object using the supported Saved View filters.'};
      const l=field(k,n,hints[k]);if(['notes','originalDescription','description','filters','tags'].includes(k))l.classList.add('wide');grid.append(l);
    });
    if(entity==='InstallmentPlans')installmentPrincipalPicker(grid,controls);
    const installmentPicker=entity==='Transactions'?transactionPlanPicker(grid,controls,record):null;
    const relation=controls.accountId||controls.shareId||controls.transactionId;if(relation&&controls.currency)relation.addEventListener('change',()=>{const type=refs[relation.name];const item=(state.boot.lookups[type]||[]).find(x=>x.id===relation.value);if(item?.currency)controls.currency.value=item.currency;});
    append(form,el('p','subtle','Use stable linked records. Amounts are entered as decimals and stored as exact minor units. Required fields must be completed.'),grid);
    const save=button('Save record',()=>{},'');save.type='submit';append(form,append(el('div','form-actions'),button('Cancel',()=>{if(onReturn)onReturn();else $('dialog').close();}),save));let requestId=uuid();
    form.addEventListener('submit',async e=>{e.preventDefault();save.disabled=true;$('dialog-error').textContent='';try{
      const data={};if(isEdit)data.id=record.id;const cur=controls.currency?.value||currencyFor(Object.fromEntries(Object.entries(controls).map(([k,n])=>[k,n.value])));
      editable.forEach(k=>data[k]=/Minor$/.test(k)?toMinor(controls[k].value,cur):controls[k].value);
      const staged=installmentPicker?.selection();const result=await rpc('apiSave',staged?staged.action:entity,staged?{transaction:data,planId:staged.id,planToken:staged._token,replacePrincipalId:staged.replacePrincipalId||'',principalId:staged.principalId||'',principalToken:staged.principalToken||''}:data,record._token||'',requestId);$('dialog').close();await refresh();if(onReturn)await onReturn(result.id);notice('Record saved.');
    }catch(err){$('dialog-error').textContent=err.message;}finally{save.disabled=false;}});openDialog((isEdit?'Edit ':'Add ')+label(entity).toLowerCase(),form);dialogReturn=onReturn||null;
  }
  function transactionPlanPicker(grid,controls,record){
    const plan=controls.installmentPlanId,sequence=controls.installmentNumber;
    plan.closest('label').hidden=true;sequence.closest('label').hidden=true;
    const section=el('section','wide installment-editor'),summary=el('p','subtle'),popup=el('div','chart-settings installment-dropdown'),search=input('','search'),results=el('div'),pager=el('div','toolbar');
    popup.setAttribute('popover','auto');search.setAttribute('aria-label','Search installment options');search.placeholder='Search description, reference or ID';
    const seqLabel=field('Payment sequence',sequence);sequence.type='number';sequence.min='1';
    let chosen=record.__principalChoice||null,selected=null,selectedOrigin=null,page=0,serial=0,mode='',principalId='',options=[];
    const principal=()=>controls.type.value==='FINANCED_PRINCIPAL';
    const choose=button('Choose installment plan',()=>{mode=principal()?'plans':'principals';principalId='';page=0;search.value='';const rect=choose.getBoundingClientRect();popup.style.margin='0';popup.style.inset='auto';popup.style.left=Math.max(12,Math.min(rect.left,innerWidth-340))+'px';popup.style.top=Math.max(12,Math.min(rect.bottom+6,innerHeight-380))+'px';popup.showPopover();load();});
    choose.setAttribute('aria-haspopup','listbox');choose.setAttribute('aria-expanded','false');
    function update(){section.hidden=!['INSTALLMENT','FINANCED_PRINCIPAL'].includes(controls.type.value);seqLabel.hidden=principal();sequence.disabled=principal();const p=principal()?chosen:selected||(state.boot.lookups.InstallmentPlans||[]).find(p=>p.id===plan.value);summary.textContent=p?'Number of payments: '+p.count+(!principal()&&sequence.value?' · '+sequence.value+' of '+p.count:''):'No new plan selection';sequence.max=p?String(p.count):'';choose.textContent=p?(p.reference||p.label||p.id):(principal()?'Choose installment plan':'Choose financed principal');}
    function draft(){const value={...record};for(const [key,node]of Object.entries(controls))value[key]=/Minor$/.test(key)?toMinor(node.value,controls.currency.value):node.value;value.__principalChoice=chosen;return value;}
    async function returnToTransaction(id){const value=draft();if(id&&!principal())value.installmentPlanId=id;if(id&&principal()){const data=await rpc('apiList','InstallmentPlans',{recordId:id},0,'');const fresh=data.rows[0];value.__principalChoice=fresh&&(!fresh.originTransactionId||fresh.originTransactionId===record.id)?fresh:null;}editRecord('Transactions',value);}
    function createFor(origin){popup.hidePopover();editRecord('InstallmentPlans',{accountId:controls.accountId.value,cardId:controls.cardId.value,currency:controls.currency.value,startDate:origin?.transactionDate||controls.transactionDate.value,reference:origin?.description||controls.description.value,...(origin?{originTransactionId:origin.id}:principal()?{originTransactionId:record.id}:{})},returnToTransaction);}
    function selectPlan(p){
      if(principal()){
        if(p.originTransactionId&&p.originTransactionId!==record.id){results.replaceChildren();append(results,el('p','','This plan already has a different financed principal ('+p.originTransactionId+'). Replace it with this transaction when you save?'),button('Confirm replacement',()=>{chosen={...p,replacePrincipalId:p.originTransactionId};popup.hidePopover();update();}),button('Cancel replacement',()=>load()));return;}
        chosen=p;
      }else{selected=p;if(![...plan.options].some(o=>o.value===p.id))plan.add(new Option(p.reference||p.id,p.id));plan.value=p.id;}
      popup.hidePopover();update();
    }
    async function selectOrigin(origin){selectedOrigin=origin;const ticket=++serial;try{const data=await rpc('apiList','InstallmentOptions',{mode:'plans',accountId:controls.accountId.value,cardId:controls.cardId.value,currency:controls.currency.value,principalId:origin.id},0,'');if(ticket!==serial||!section.isConnected)return;if(data.total===0){createFor(origin);return;}if(data.total===1){selectPlan(data.rows[0]);return;}mode='plans';principalId=origin.id;search.value='';page=0;load();}catch(e){if(ticket===serial)results.textContent=e.message;}}
    async function load(){const ticket=++serial;try{const data=await rpc('apiList','InstallmentOptions',{mode,principalId,q:search.value,accountId:controls.accountId.value,cardId:controls.cardId.value,currency:controls.currency.value},page,'');if(ticket!==serial||!section.isConnected||!popup.matches(':popover-open'))return;results.replaceChildren();options=[];for(const row of data.rows){const text=mode==='plans'?(row.reference||row.id)+' · '+row.count+' payments':row.description+' · '+row.transactionDate+' · '+lookup('Cards',row.cardId)+' · '+money(row.amountMinor,row.currency);const option=button(text,()=>mode==='plans'?selectPlan(row):selectOrigin(row));option.setAttribute('role','option');options.push(option);results.append(option);}if(!options.length)results.append(el('p','subtle','No matching records.'));pager.replaceChildren();const prev=button('Previous',()=>{page--;load();}),next=button('Next',()=>{page++;load();});prev.disabled=page===0;next.disabled=(page+1)*20>=data.total;append(pager,prev,el('span','',String(page+1)),next);}catch(e){if(ticket===serial)results.textContent=e.message;}}
    popup.addEventListener('toggle',e=>{choose.setAttribute('aria-expanded',String(e.newState==='open'));if(e.newState==='open')search.focus();else{serial++;choose.focus({preventScroll:true});}});
    popup.addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const i=options.indexOf(document.activeElement),next=e.key==='ArrowDown'?Math.min(i+1,options.length-1):Math.max(i-1,0);options[next]?.focus();}else if(e.key==='Enter'&&document.activeElement===search){e.preventDefault();options[0]?.click();}});
    search.addEventListener('input',()=>{page=0;load();});sequence.addEventListener('input',update);
    for(const key of ['accountId','cardId','currency','type'])controls[key].addEventListener('change',()=>{serial++;if(popup.matches(':popover-open'))popup.hidePopover();chosen=null;selected=null;selectedOrigin=null;plan.value='';sequence.value='';update();});
    results.setAttribute('role','listbox');results.setAttribute('aria-label','Installment options');append(popup,search,results,pager);
    const edit=button('Edit plan',()=>action(async()=>{const id=principal()?chosen?.id:plan.value;if(!id)throw Error('Choose a plan first.');const data=await rpc('apiList','InstallmentPlans',{recordId:id},0,'');if(!data.rows[0])throw Error('Plan is unavailable.');editRecord('InstallmentPlans',data.rows[0],returnToTransaction);}));
    append(section,el('h3','','Installment plan'),choose,popup,summary,seqLabel,button('Clear selection',()=>{chosen=null;selected=null;if(!principal()){plan.value='';sequence.value='';}update();}),button('Create plan',()=>createFor()),edit,el('p','subtle','Select a principal purchase for monthly charges, or assign this financed principal to a plan. Changes apply when you save. Creating a plan saves that plan separately.'));
    const secondary=el('div','editor-secondary');[...section.children].filter(n=>n.tagName==='BUTTON'&&n!==choose).forEach(n=>secondary.append(n));section.insertBefore(secondary,section.lastElementChild);seqLabel.classList.add('payment-sequence');grid.append(section);update();return {selection:()=>principal()?(chosen?{...chosen,action:'TransactionPrincipal'}:null):(selected&&selectedOrigin?{...selected,action:'TransactionInstallment',principalId:selectedOrigin.id,principalToken:selectedOrigin._token}:null)};
  }
  function loanCell(cell,row,key){cell.replaceChildren();if(!inlineRows.has(row.id)&&!loanDrafts.has(row.id)){if(key==='nickname')cell.append(button(row.nickname,()=>openLoan(row.id)));else cell.textContent=display(row,key);return;}const draft=loanDrafts.get(row.id),value=draft?.values[key]??row[key]??'',control=key==='status'?select(state.boot.enums['Loans.status'],value,false):input(value);control.dataset.loanField=key;control.setAttribute('aria-label',label(key)+' for '+row.nickname);control.disabled=reviewSaving;control.addEventListener('change',()=>{loanSaveFocus={id:row.id,key};const current=loanDrafts.get(row.id)||{row,values:Object.fromEntries(loanFields.map(k=>[k,row[k]||''])),request:uuid()};current.values[key]=control.value;if(loanFields.every(k=>String(current.values[k])===String(row[k]||'')))loanDrafts.delete(row.id);else loanDrafts.set(row.id,current);updateReviewFooter();});cell.append(control);}
  function paintLoanRows(){for(const tr of document.querySelectorAll('[data-loan-row]')){const row=state.pageResult?.rows.find(r=>r.id===tr.dataset.loanRow);if(row)for(const key of loanFields){const cell=tr.querySelector('[data-field="'+key+'"]');if(cell)loanCell(cell,row,key);}}}
  async function saveAllChanges(){if(reviewSaving)return;if(transactionDrafts.size())await saveReviewChanges();if(reviewJob||transactionDrafts.size()||!loanDrafts.size)return;reviewSaving=true;let saved=0;updateReviewFooter();paintLoanRows();try{for(const [id,draft]of [...loanDrafts]){await rpc('apiSave','LoanDetails',{id,...draft.values},draft.row._token,draft.request);loanDrafts.delete(id);inlineRows.delete(id);saved++;}reviewMessage='Saved '+saved+' loan'+(saved===1?'':'s')+'.';await refresh();}catch(e){reviewMessage='Saved '+saved+' loans. Remaining edits are pending. '+e.message;if(saved){try{await refresh();}catch{}}}finally{reviewSaving=false;paintLoanRows();updateReviewFooter();if(loanSaveFocus){const tr=document.querySelector('[data-loan-row="'+CSS.escape(loanSaveFocus.id)+'"]');(tr?.querySelector('[data-loan-field="'+loanSaveFocus.key+'"]')||tr?.querySelector('button'))?.focus({preventScroll:true});}}}
  async function openLoan(id){return action(async()=>{const data=await rpc('apiList','LoanDashboard',{loanId:id},0,'');if(!data.loans[0])throw Error('Loan is unavailable.');showLoan(data.loans[0],data);});}
  function renderUpcomingLoans(container,page=0,before=null){const section=el('section','card statement-grid');section.append(el('h2','','Upcoming Loans'));container.insertBefore(section,before);const seq=state.sequence;action(async()=>{const data=await rpc('apiList','UpcomingLoans',{},page,'nextDueDate:asc');if(seq!==state.sequence||!section.isConnected)return;const metrics=$('overview-metrics');if(metrics&&!metrics.querySelector('[data-loan-total]'))for(const [currency,t]of Object.entries(data.loanTotals||{})){const metric=button('',()=>navigate('Loans',undefined,{currency}),'metric');metric.dataset.loanTotal=currency;append(metric,el('span','','Remaining loan payments'),el('strong','',money(t.remaining,currency)),el('span','',t.unknown?t.unknown+' future amounts not set':'Unpaid scheduled payments'));metrics.append(metric);}for(const loan of data.rows){const item=button('',()=>openLoan(loan.loanId||loan.id),'statement-overview');append(item,el('strong','',loan.nickname),el('strong','',loan.nextRemainingMinor===null?'Amount not set':money(loan.nextRemainingMinor,loan.currency)),el('span','',loan.lender+' · Payment '+loan.installmentNumber+' · Due '+loan.nextDueDate),el('span',loan.nextDueDate<state.boot.today?'badge overdue':'badge',statementDueLabel(loan.nextDueDate,state.boot.today)));section.append(item);}if(!data.total)section.append(el('p','subtle','No unpaid loan installments.'));if(data.total>40){const nav=el('div','pager'),prev=button('Previous',()=>{renderUpcomingLoans(container,page-1,section);section.remove();}),next=button('Next',()=>{renderUpcomingLoans(container,page+1,section);section.remove();});prev.disabled=!page;next.disabled=(page+1)*40>=data.total;append(nav,prev,next);section.append(nav);}});}
  function loanForm(title,fields,onSave){const returnToLoan=loanNestedReturn;const form=el('form'),grid=el('div','form-grid'),controls={};for(const [key,labelText,type,value,choices]of fields){const control=choices?select(choices,value,false):input(value??'',type||'text');control.setAttribute('aria-label',labelText);controls[key]=control;const labelNode=el('label','',labelText);labelNode.append(control);grid.append(labelNode);}if(controls.firstDueDate&&controls.dueDay)controls.firstDueDate.addEventListener('change',()=>{controls.dueDay.value=Number(controls.firstDueDate.value.slice(8))||1;});const save=button('Save',()=>{},'primary');save.type='submit';append(form,grid,save);const request=uuid();form.addEventListener('submit',async e=>{e.preventDefault();save.disabled=true;try{await onSave(Object.fromEntries(Object.entries(controls).map(([k,v])=>[k,v.value])),request);$('dialog').close();await refresh();if(returnToLoan)await returnToLoan();}catch(error){$('dialog-error').textContent=error.message;}finally{save.disabled=false;}});openDialog(title,form);dialogReturn=returnToLoan;}
  function editLoan(loan){const r=loan||{},currency=r.currency||state.boot.settings.DefaultCurrency;const fields=[['lender','Lender','text',r.lender],['nickname','Loan nickname','text',r.nickname],['currency','Currency','text',currency,Object.keys(state.boot.currencies).map(id=>({id,label:id}))],['firstDueDate','First due date','date',r.firstDueDate],['dueDay','Monthly due day (1-31)','number',r.dueDay||1],['termMonths','Total term (months)','number',r.termMonths||12],['principal','Original principal (optional)','text',r.principalMinor===''||r.principalMinor===undefined?'':decimal(r.principalMinor,currency)],['notes','Notes','text',r.notes],['status','Status','text',r.status||'ACTIVE',[{id:'ACTIVE',label:'Active'},{id:'COMPLETED',label:'Completed'},{id:'ARCHIVED',label:'Archived'}]]];if(!loan)fields.push(['monthly','Fixed monthly payment','text',''],['duration','Fixed period','number',12],['unit','Fixed period unit','text','months',[{id:'months',label:'Months'},{id:'years',label:'Years'}]]);loanForm(loan?'Edit loan':'Add loan',fields,async(v,request)=>{const record={lender:v.lender,nickname:v.nickname,currency:v.currency,firstDueDate:v.firstDueDate,dueDay:Number(v.dueDay),termMonths:Number(v.termMonths),principalMinor:v.principal?toMinor(v.principal,v.currency):'',notes:v.notes,status:v.status};if(loan)record.id=loan.id;else{record.initialMonthlyMinor=toMinor(v.monthly,v.currency);record.initialMonths=Number(v.duration)*(v.unit==='years'?12:1);}await rpc('apiSave','Loans',record,loan?._token||'',request);});}
  function loanScheduleForm(loan,segment){const r=segment||{};loanForm(segment?'Edit payment period':'Set lender payment amount',[['startDate','Effective from','date',r.startDate||loan.firstDueDate],['endDate','Effective through','date',r.endDate||loan.installments.at(-1).dueDate],['monthly','Monthly payment','text',r.monthlyMinor?decimal(r.monthlyMinor,loan.currency):''],['status','Status','text',r.status||'ACTIVE',[{id:'ACTIVE',label:'Active'},{id:'VOID',label:'Void'}]]],async(v,request)=>{await rpc('apiSave','LoanSchedules',{...(segment?{id:segment.id}:{}),loanId:loan.id,startDate:v.startDate,endDate:v.endDate,monthlyMinor:toMinor(v.monthly,loan.currency),status:v.status},segment?._token||'',request);});}
  function loanPaymentForm(loan,installment){const returnToLoan=loanNestedReturn;const box=el('div'),date=input(state.boot.today,'date'),amount=input(installment?decimal(installment.remainingMinor,loan.currency):''),reference=input(''),notes=input(''),allocationRows=el('div'),entries=[];date.setAttribute('aria-label','Actual payment date');amount.setAttribute('aria-label','Payment amount');append(box,field('Actual payment date',date),field('Payment amount',amount),field('Reference',reference),field('Notes',notes),el('p','subtle','Allocate the full payment. Past dates and partial payments are supported. Nothing is recorded until confirmation.'),allocationRows);const add=(selected)=>{const row=el('div','share-line'),choice=select(loan.installments.filter(i=>i.remainingMinor>0).map(i=>({id:String(i.number),label:'#'+i.number+' / '+i.dueDate+' / '+money(i.remainingMinor,loan.currency)})),selected?String(selected.number):'',true),value=input(selected?decimal(selected.remainingMinor,loan.currency):'');choice.setAttribute('aria-label','Installment allocation');value.setAttribute('aria-label','Allocated amount');const entry={row,choice,value};entries.push(entry);append(row,choice,value,button('Remove',()=>{entries.splice(entries.indexOf(entry),1);row.remove();}));allocationRows.append(row);};add(installment);box.append(button('Allocate another installment',()=>add()));const request=uuid();box.append(button('Review payment',()=>{try{const payload={loanId:loan.id,date:date.value,amountMinor:toMinor(amount.value,loan.currency),reference:reference.value,notes:notes.value,allocations:entries.map(e=>({number:Number(e.choice.value),amountMinor:toMinor(e.value.value,loan.currency)}))};if(payload.allocations.reduce((sum,a)=>sum+a.amountMinor,0)!==payload.amountMinor)throw Error('Allocations must equal the payment amount.');const confirmBox=el('div');append(confirmBox,el('p','',loan.nickname+' / '+money(payload.amountMinor,loan.currency)+' paid on '+payload.date),el('p','',payload.allocations.map(a=>'Installment '+a.number+': '+money(a.amountMinor,loan.currency)).join('; ')),button('Back',()=>{openDialog('Record loan payment',box);dialogReturn=returnToLoan;}),button('Confirm payment',()=>action(async()=>{await rpc('apiSave','LoanPayment',payload,loan._token,request);$('dialog').close();await refresh();if(returnToLoan)await returnToLoan();}),'primary'));openDialog('Confirm loan payment',confirmBox);dialogReturn=returnToLoan;}catch(e){$('dialog-error').textContent=e.message;}},'primary'));openDialog('Record loan payment',box);dialogReturn=returnToLoan;}
  let loanNestedReturn=null;
  function showLoan(loan,data){
    const box=el('div','loan-details');const nested=fn=>{if(loanDrafts.has(loan.id)){notice('Save pending loan edits before changing its details.','error');return;}const scroll=$('dialog').scrollTop,focusText=document.activeElement?.textContent;loanNestedReturn=async()=>{await openLoan(loan.id);requestAnimationFrame(()=>{$('dialog').scrollTop=scroll;[...$('dialog').querySelectorAll('button')].find(b=>b.textContent===focusText)?.focus({preventScroll:true});});};fn();dialogReturn=loanNestedReturn;};
    append(box,el('h3','',loan.nickname),el('p','subtle',loan.lender+' / '+loan.currency),el('p','subtle','Scheduled amounts are not an outstanding-principal calculation.'));
    const actions=el('div','editor-secondary');append(actions,button('Edit loan',()=>nested(()=>editLoan(loan))),button('Set payment period',()=>nested(()=>loanScheduleForm(loan))),button('Record payment',()=>nested(()=>loanPaymentForm(loan))));box.append(actions);
    function table(title,headers,rows){const section=el('section'),wrap=el('div','table-scroll'),t=el('table'),head=el('thead'),tr=el('tr'),body=el('tbody');for(const h of headers)tr.append(el('th','',h));head.append(tr);for(const values of rows){const r=el('tr');for(const value of values){const cell=el('td');if(value instanceof Node)cell.append(value);else cell.textContent=value;r.append(cell);}body.append(r);}append(t,head,body);wrap.append(t);append(section,el('h3','',title),wrap);if(!rows.length)section.append(el('p','subtle','No records.'));box.append(section);}
    table('Payment periods',['From','Through','Monthly amount','Status','Action'],data.schedules.filter(s=>s.loanId===loan.id).map(s=>[s.startDate,s.endDate,money(s.monthlyMinor,loan.currency),s.status,button('Edit period',()=>nested(()=>loanScheduleForm(loan,s)))]));
    table('Installments',['Number','Due date','Scheduled','Paid','Remaining','Status','Action'],loan.installments.map(i=>[i.number,i.dueDate,i.amountMinor===null?'Amount not set':money(i.amountMinor,loan.currency),money(i.paidMinor,loan.currency),i.remainingMinor===null?'Amount not set':money(i.remainingMinor,loan.currency),i.status==='Upcoming'?statementDueLabel(i.dueDate,state.boot.today):i.status,i.remainingMinor>0?button('Record payment / Mark paid',()=>nested(()=>loanPaymentForm(loan,i))):i.remainingMinor===null?button('Set amount',()=>nested(()=>loanScheduleForm(loan))):'']));
    table('Payment history',['Date','Amount','Reference','Status','Action'],data.payments.filter(p=>p.loanId===loan.id).sort((a,b)=>b.date.localeCompare(a.date)).map(payment=>[payment.date,money(payment.amountMinor,loan.currency),payment.reference||'—',payment.status,payment.status==='CONFIRMED'?button('Reverse payment',()=>{const confirmation=el('div'),reversalId=uuid();append(confirmation,el('p','','Reverse '+money(payment.amountMinor,loan.currency)+' paid on '+payment.date+'? Its history will remain.'),button('Cancel',()=>openLoan(loan.id)),button('Confirm reversal',()=>action(async()=>{await rpc('apiSave','ReverseLoanPayment',{id:payment.id},payment._token,reversalId);await refresh();await openLoan(loan.id);})));openDialog('Reverse loan payment',confirmation);dialogReturn=()=>openLoan(loan.id);}):'']));
    loanNestedReturn=null;openDialog('Loan details',box);
  }
  async function renderLoans(){const c=$('content'),seq=state.sequence;state.entity='Loans';return action(async()=>{const data=await rpc('apiList','LoanList',state.filters,state.page,state.sort);if(seq!==state.sequence)return;state.page=data.page;const metrics=el('div','metrics loan-metrics');for(const [currency,t]of Object.entries(data.loanTotals)){const panel=el('section','metric');append(panel,el('h3','',currency+' loan schedule'),el('p','','Known remaining scheduled payments: '+money(t.remaining,currency)),el('p','','Past due: '+money(t.overdue,currency)),el('p','subtle',t.unknown+' installments need a lender amount'));metrics.append(panel);}c.append(metrics);renderToolbar();const box=el('div');c.append(box);renderTable(box,data);});}
  function fixReviewTransaction(row,kind){
    if(kind==='type'){columnChoices.get('Transactions')?.add('type');document.querySelectorAll('.review-transactions [data-field="type"]').forEach(cell=>cell.hidden=false);inlineRows.add(row.id);paintInlineRows();updateReviewFooter();document.querySelector('[data-transaction-row="'+CSS.escape(row.id)+'"] [data-inline-field="type"]')?.focus({preventScroll:true});return;}
    if(kind==='shares'){shareEditor(row);return;}
    if(transactionDrafts.has(row.id)){notice('Save pending edits for this transaction before fixing its linked details.','error');return;}
    editRecord('Transactions',row);if(kind==='installment')requestAnimationFrame(()=>document.querySelector('.installment-editor')?.scrollIntoView({block:'nearest'}));
  }
  async function renderReview(){
    const c=$('content');renderDuplicateReview(c);const section=el('section','card review-transactions');append(section,el('h2','','Transactions needing attention'));c.append(section);section.addEventListener('focusin',e=>{const row=e.target.closest('[data-transaction-row]');if(row)reviewFocus={id:row.dataset.transactionRow,field:e.target.dataset.inlineField||''};});state.entity='Transactions';const seq=state.sequence;
    return action(async()=>{const result=await rpc('apiList','ReviewTransactions',{},state.page,state.sort||'transactionDate:desc');if(seq!==state.sequence)return;state.page=result.page;state.pageResult=result;
      const edit=button('Edit',()=>{result.rows.forEach(r=>inlineRows.add(r.id));paintInlineRows();updateReviewFooter();});edit.id='edit-page';section.append(edit);renderTable(section,result);
      const list=el('div','issues');for(const issue of result.otherIssues||[]){const row=el('section','card');append(row,el('h3','',label(issue.entity)),el('p','',issue.message));
        if(issue.message.startsWith('A tracked row was removed')){for(const mode of ['restore','accept'])row.append(button(mode==='restore'?'Restore record':'Accept intentional deletion',()=>action(async()=>{await rpc('apiResolveMissing',issue.entity,issue.id,mode,uuid());await refresh();})));}
        else if(issue.entity==='Operations')row.append(button('Resume operation',()=>action(async()=>{await rpc('apiRecover',issue.id);await refresh();})));
        else if(issue.entity==='Settings'&&!issue.id)row.append(button('Repair missing settings',()=>action(async()=>{await rpc('repairSettings');await refresh();})));
        else row.append(button('Fix record',()=>action(async()=>{const data=await rpc('apiList',issue.entity,{recordId:issue.id},0,'updatedAt:desc');if(!data.rows[0])throw Error('Record unavailable. Restore its linked record or resolve the pending operation first.');editRecord(issue.entity,data.rows[0]);})));
        list.append(row);
      }c.append(list);
    });
  }
  function shareEditor(transaction){action(async()=>{const data=await rpc('apiList','Shares',{transactionId:transaction.id,status:'ACTIVE'},0,'updatedAt:asc');if(data.total>30)throw Error('This transaction has more than 30 shares; edit individual shares in Money owed.');const box=el('div','share-editor'),rows=el('div','share-rows'),message=el('p','subtle'),items=[];const add=share=>{const line=el('div','share-line'),person=select(state.boot.lookups.People||[],share.personId||''),amount=input(share.amountMinor===undefined?'':decimal(share.amountMinor,transaction.currency));person.setAttribute('aria-label','Person');amount.setAttribute('aria-label','Share amount');append(line,field('Person',person),field('Amount',amount));if(!share.id)line.append(button('Remove',()=>{line.remove();items.splice(items.findIndex(i=>i.line===line),1);}));items.push({share,person,amount,line});rows.append(line);};data.rows.forEach(add);if(!data.rows.length)add({});const total=input(decimal(transaction.amountMinor,transaction.currency));total.setAttribute('aria-label','Total to split');append(box,el('h3','',transaction.description),field('Total to split',total),rows,button('Add person',()=>add({})),button('Split equally',()=>{try{const sum=toMinor(total.value,transaction.currency);if(!items.length||sum<=0)throw Error('Enter a positive total.');const each=Math.floor(sum/items.length),remainder=sum-each*items.length;items.forEach((item,i)=>item.amount.value=decimal(each+(i<remainder?1:0),transaction.currency));message.textContent=remainder?'Rounding: the first '+remainder+' shares receive one extra minor unit.':'Equal amounts; no rounding remainder.';}catch(e){message.textContent=e.message;}}),message);const request=uuid(),save=button('Save shares',()=>action(async()=>{save.disabled=true;try{await rpc('apiSave','ShareBatch',{transactionId:transaction.id,items:items.map(i=>({id:i.share.id,token:i.share._token,personId:i.person.value,amountMinor:toMinor(i.amount.value,transaction.currency)}))},transaction._token,request);$('dialog').close();await refresh();}finally{save.disabled=false;}}),'primary');const secondary=el('div','editor-secondary');[...box.children].filter(n=>n.tagName==='BUTTON').forEach(n=>secondary.append(n));box.insertBefore(secondary,message);box.append(append(el('div','form-actions'),save));openDialog('Assign shares',box);});}
  function renderDuplicateReview(container,page=0){
    const section=el('section','card');append(section,el('h2','','Possible duplicates'));container.append(section);const sequence=state.sequence;
    action(async()=>{const result=await rpc('apiList','DuplicateReview',{},page,'updatedAt:desc');if(!section.isConnected||sequence!==state.sequence)return;section.append(el('p','subtle',result.total?result.total+' possible duplicate pairs. Nothing changes until you choose an action.':'No possible duplicates found.'));
      result.rows.forEach(pair=>{const box=el('div','duplicate-pair'),comparison=el('div','split');pair.records.forEach(r=>{const card=el('article','card');append(card,el('h3','',r.description),el('p','',lookup('Cards',r.cardId)+' · '+lookup('Accounts',r.accountId)),el('p','',money(r.amountMinor,r.currency)+' · '+r.transactionDate),el('p','subtle','Posted: '+(r.postingDate||'—')+' · Due: '+(r.dueDate||'—')),el('p','',label(r.type)+' · '+label(r.reviewStatus)),el('p','subtle','Source: '+(r.sourceRef||r.sourceKey||'Manual entry')),el('p','subtle','Statement: '+lookup('Statements',r.statementId)),button('View record',()=>showDetails('Transactions',r)));comparison.append(card);});box.append(comparison);pair.blockers.forEach(reason=>box.append(el('p','subtle',reason)));
        const actions=el('div','toolbar'),keepId=uuid();const keep=button('Keep both',async()=>{keep.disabled=true;try{await resolveDuplicate(pair,{mode:'keep'},keepId);await render();}catch(e){notice(e.message,'error');}finally{keep.disabled=false;}}),merge=button('Review merge',()=>reviewDuplicateMerge(pair));merge.disabled=pair.blockers.length>0;append(actions,keep,merge,button('Decide later',()=>box.remove()));box.append(actions);section.append(box);
      });const pager=el('div','pager'),prev=button('Previous',()=>{section.remove();renderDuplicateReview(container,page-1);}),next=button('Next',()=>{section.remove();renderDuplicateReview(container,page+1);});prev.disabled=page===0;next.disabled=(page+1)*20>=result.total;append(pager,prev,next);if(result.total>20)section.append(pager);
    });
  }
  async function resolveDuplicate(pair,decision,requestId){if(pair.records.some(r=>transactionDrafts.has(r.id)))throw Error('Save or discard pending selections for these transactions first.');return rpc('apiSave','DuplicateResolution',{ids:pair.records.map(r=>r.id),fingerprint:pair.fingerprint,...decision},'',requestId);}
  function reviewDuplicateMerge(pair){
    const box=el('div'),choice=select(pair.records.map((r,i)=>({id:r.id,label:'Record '+(i+1)+' · '+(r.sourceRef||r.description)})),pair.records[0].id,false),fields=el('div','form-grid'),controls={};choice.setAttribute('aria-label','Keep transaction');append(box,field('Keep transaction',choice),el('p','subtle','Choose the final details. The other transaction will be voided, with its history retained.'),fields);
    function populate(){fields.replaceChildren();const survivor=pair.records.find(r=>r.id===choice.value);['description','originalDescription','postingDate','dueDate','type','category','tags','notes','reviewStatus'].forEach(k=>{let control;if(['notes','tags','description','originalDescription','category'].includes(k)){control=k==='notes'?el('textarea'):input();control.value=survivor[k]||'';}else control=select([...new Set(pair.records.map(r=>r[k]||''))].map(value=>({id:value,label:value||'No value'})),survivor[k]||'',false);controls[k]=control;const wrapper=field(k,control);if(k==='notes')wrapper.classList.add('wide');fields.append(wrapper);});}
    populate();choice.addEventListener('change',populate);box.append(button('Continue to confirmation',()=>{const survivor=pair.records.find(r=>r.id===choice.value),duplicate=pair.records.find(r=>r.id!==choice.value),values=Object.fromEntries(Object.entries(controls).map(([k,n])=>[k,n.value])),confirm=el('div');append(confirm,el('p','','Keep: '+survivor.id),el('p','','Void duplicate: '+duplicate.id),el('p','','Active transaction amount changes from '+money(Number(survivor.amountMinor)+Number(duplicate.amountMinor),survivor.currency)+' to '+money(survivor.amountMinor,survivor.currency)+'. The amounts will not be added together.'));const spendingTypes=['PURCHASE','FEE','INTEREST','CASH_ADVANCE','INSTALLMENT'],beforeSpending=pair.records.reduce((sum,r)=>sum+(spendingTypes.includes(r.type)?Number(r.amountMinor):0),0),afterSpending=spendingTypes.includes(values.type)?Number(survivor.amountMinor):0;confirm.append(el('p','','Classified spending for these records changes from '+money(beforeSpending,survivor.currency)+' to '+money(afterSpending,survivor.currency)+'.'));Object.entries(values).forEach(([k,v])=>confirm.append(el('p','subtle',label(k)+': '+(v||'—'))));const requestId=uuid(),commit=button('Confirm merge',async()=>{commit.disabled=true;try{const result=await resolveDuplicate(pair,{mode:'merge',survivorId:survivor.id,fields:values,confirmed:true},requestId);applyWorkflowResult(result);$('dialog').close();await refresh();notice('Duplicate merged. One charge remains active.');}catch(e){$('dialog-error').textContent=e.message;}finally{commit.disabled=false;}});append(confirm,append(el('div','form-actions'),button('Back',()=>reviewDuplicateMerge(pair)),button('Cancel',()=>$('dialog').close()),commit));openDialog('Confirm duplicate merge',confirm);}));openDialog('Review duplicate merge',box);
  }
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
    manual.disabled=!!d.backupRunning;append(controls,enable,manual);box.append(controls);c.append(box);const calendar=el('section','card');append(calendar,el('h2','','Calendar synchronization'),el('p','',state.boot.settings.SyncEnabled==='true'?'Enabled for statements and loans':'Disabled'),el('p','subtle','Statements retain their individual Calendar settings. Loan reminders include known unpaid installments.'));const buttons=el('div','toolbar');for(const [title,fn]of [['Select calendar',chooseCalendar],['Test Calendar',()=>action(async()=>{await rpc('apiCalendarTest');notice('Calendar access verified.');})],['Preview synchronization',()=>action(async()=>{const rows=await rpc('apiSyncPreview'),list=el('div','table-scroll'),table=el('table');for(const r of rows){const tr=el('tr');[r.entity,r.label||r.id,r.dueDate,r.action].forEach(v=>tr.append(el('td','',v||'')));table.append(tr);}list.append(table);openDialog('Calendar preview',list);})],['Enable Calendar sync',()=>action(async()=>{const r=await rpc('apiEnableCalendarSync');await refresh();notice(r.message);})],['Synchronize now',synchronizeStatements]])buttons.append(button(title,fn));calendar.append(buttons);c.append(calendar);
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
        if(p.format!=='cardbills-reviewed-v1'||!Array.isArray(p.records)||p.records.length<1||p.records.length>6000||!/^[-a-f0-9]{36}$/.test(p.id)||!/^[a-f0-9]{64}$/.test(p.sourceHash)||!p.expected)throw Error('Choose a BillBills reviewed package.');
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
