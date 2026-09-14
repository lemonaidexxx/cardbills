import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fixture } from './backend-fixture.mjs';

function signed(f, override = {}, secret = f.properties.BRIDGE_SECRET) {
  const payload = JSON.stringify({ version: 1, timestamp: Date.now(), nonce: crypto.randomBytes(16).toString('hex'), actor: f.properties.OWNER_USER_ID, action: 'apiIdentity', args: [], ...override });
  return { postData: { contents: JSON.stringify({ payload, signature: crypto.createHmac('sha256', secret).update(payload).digest('hex') }) } };
}

test('public financial functions require an authorized caller', () => {
  const f = fixture(); f.setActive('');
  for (const action of ['apiIdentity','apiBootstrap','apiList','apiSave','apiReport','apiPackageCommit','apiPackageReceipt']) assert.throws(() => f.context[action](), /ACCESS_DENIED/);
});
test('a different Google account is rejected', () => { const f = fixture(); f.setActive('other@example.test'); assert.throws(() => f.context.setup(), /ACCESS_DENIED/); });
test('signed owner gateway requests succeed', () => { const f = fixture(); f.setActive(''); const r = JSON.parse(f.context.doPost(signed(f)).text); assert.equal(r.ok, true); assert.equal(r.data.authorized, true); });
test('bad signatures are rejected', () => { const f = fixture(); assert.equal(JSON.parse(f.context.doPost(signed(f, {}, 'b'.repeat(64))).text).ok, false); });
test('old signed requests are rejected', () => { const f = fixture(); assert.equal(JSON.parse(f.context.doPost(signed(f, { timestamp: Date.now() - 91000 })).text).ok, false); });
test('wrong owner claims are rejected', () => { const f = fixture(); assert.equal(JSON.parse(f.context.doPost(signed(f, { actor: 'other' })).text).ok, false); });
test('replayed signed requests are rejected', () => { const f = fixture(), request = signed(f); assert.equal(JSON.parse(f.context.doPost(request).text).ok, true); assert.equal(JSON.parse(f.context.doPost(request).text).ok, false); });
test('private and inherited method dispatch is rejected', () => { const f = fixture(); for (const action of ['setup','owner_','constructor','__proto__']) assert.equal(JSON.parse(f.context.doPost(signed(f, { action })).text).ok, false); });
test('authorization is cleared after request completion', () => { const f = fixture(); f.context.doPost(signed(f)); f.setActive(''); assert.throws(() => f.context.apiIdentity(), /ACCESS_DENIED/); });
test('currency arithmetic preserves cents and sign', () => { const f = fixture(); assert.equal(f.context.minor_('1234.56','PHP'),123456); assert.equal(f.context.minor_('-0.01','PHP'),-1); assert.throws(() => f.context.minor_('1.001','PHP')); });
test('calendar date validation includes leap days', () => { const f = fixture(); assert.equal(f.context.dateValid_('2024-02-29'),true); assert.equal(f.context.dateValid_('2025-02-29'),false); assert.equal(f.context.dateValid_('2026-13-01'),false); });
test('reminder time normalization preserves noon and midnight', () => { const f = fixture(); assert.equal(f.context.normalizeTime_('12:00 AM','Asia/Manila'),'00:00'); assert.equal(f.context.normalizeTime_('12:00 PM','Asia/Manila'),'12:00'); assert.equal(f.context.normalizeTime_(0.5,'Asia/Manila'),'12:00'); assert.throws(() => f.context.normalizeTime_('25:00','Asia/Manila')); });
test('setup is repeat-safe', () => { const f = fixture(); f.context.setup(); const count = f.sheets.size, settings = f.sheets.get('CC_Settings').getLastRow(); f.context.setup(); assert.equal(f.sheets.size,count); assert.equal(f.sheets.get('CC_Settings').getLastRow(),settings); });
test('data text is protected from formula interpretation', () => { const f = fixture(); assert.equal(f.context.sheetValue_('=1+1'),"'=1+1"); assert.equal(f.context.sheetValue_(-100),-100); });
test('package records restrict metadata and full card numbers', () => { const f = fixture(); assert.throws(() => f.context.packageRecord_('Accounts',{id:crypto.randomUUID(),revision:500})); assert.throws(() => f.context.packageRecord_('Cards',{id:crypto.randomUUID(),nickname:'4111111111111111'})); assert.throws(() => f.context.packageRecord_('AuditHistory',{id:crypto.randomUUID()})); });
test('unknown statement balances remain unknown', () => { const f = fixture(); const result = f.context.statementTotals_({id:'statement',balanceMinor:'',minimumMinor:'',currency:'PHP'}, {PaymentAllocations:[],BankPayments:[]}); assert.equal(result.remainingMinor,''); assert.equal(result.settlement,'UNKNOWN'); });

test('unknown-only statement totals remain unknown in overview',()=>{
  const f=fixture();f.context.setup();
  const a=f.context.apiSave('Accounts',{bank:'Example',nickname:'Example',currency:'PHP',status:'ACTIVE',reviewStatus:'VERIFIED'},'',crypto.randomUUID()).id;
  f.context.apiSave('Statements',{accountId:a,statementDate:'2026-01-01',dueDate:'2026-01-20',balanceMinor:'',minimumMinor:'',currency:'PHP',status:'OPEN',reconciliation:'UNVERIFIED',calendarMode:'OFF'},'',crypto.randomUUID());
  const overview=f.context.apiBootstrap().overview;
  assert.equal(overview.totals.PHP.statementRemainingMinor,'');
  assert.equal(overview.totals.PHP.unknownStatements,1);
});
