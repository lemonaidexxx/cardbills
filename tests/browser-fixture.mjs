import fs from 'node:fs';
import {createDomain} from '../worker/domain.generated.mjs';
import {fixture} from './backend-fixture.mjs';
const f=fixture();f.context.setup();
const save=(e,r)=>f.context.apiSave(e,r,'',crypto.randomUUID()).id;
const a=save('Accounts',{bank:'Example Bank',nickname:'Everyday account',currency:'PHP',status:'ACTIVE',reviewStatus:'VERIFIED'});
const c=save('Cards',{accountId:a,product:'Everyday card',nickname:'Everyday card',lastFour:'1111',relationship:'PRIMARY',status:'ACTIVE'});
for(const [description,amount] of [['Groceries',125050],['Home supplies',45000],['Transport',8500]])save('Transactions',{accountId:a,cardId:c,transactionDate:'2026-09-08',postingDate:'2026-09-09',originalDescription:description,description,amountMinor:amount,currency:'PHP',type:'PURCHASE',reviewStatus:'VERIFIED',status:'ACTIVE'});
save('Statements',{accountId:a,statementDate:'2026-09-09',dueDate:'2026-09-29',balanceMinor:178550,minimumMinor:10000,currency:'PHP',status:'OPEN',reconciliation:'UNVERIFIED',calendarMode:'OFF'});
save('People',{name:'Alex',status:'ACTIVE'});
const tables={};for(const [name,sheet]of f.sheets){const [columns,...rows]=sheet.data;tables[name.slice(3)]=rows.flatMap((r,i)=>r?.some(v=>v!=='')?[{...Object.fromEntries(columns.map((c,j)=>[c,r[j]??''])),_slot:i+2}]:[]);}
tables.Shares=[{id:'synthetic-share',transactionId:tables.Transactions[1].id,personId:tables.People[0].id,amountMinor:10000,currency:'PHP',requestStatus:'NOT_REQUESTED',status:'ACTIVE',_slot:2}];
tables.Transactions.push({...tables.Transactions[0],id:'duplicate-browser-tx',_slot:99});
const owner={id:'11111111-1111-4111-8111-111111111111',email:'owner@example.test'},domain=createDomain({ownerId:owner.id,sourceSheetId:'synthetic-workbook',version:1,properties:{},tables},owner);

const boot=domain.call('apiBootstrap',[]);
const lists=Object.fromEntries(['DuplicateReview','Accounts','Cards','Transactions','Statements','People','Shares','BankPayments','PaymentAllocations','Repayments','InstallmentPlans','SavedViews','Labels','ReportConfig'].map(e=>[e,domain.call('apiList',[e,{},0,'updatedAt:desc'])]));
console.log(JSON.stringify({boot,lists}));
