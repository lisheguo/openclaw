import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatchPreparation, dispatchIdentity } from './support/before-dispatch-prototype.js';
const ctx = { channelId: 'feishu', accountId: 'fixture-account', conversationId: 'fixture-chat', sessionKey: 'fixture-session', senderId: 'fixture-tech', messageId: 'fixture-message' };
const event = { channel: ctx.channelId, sessionKey: ctx.sessionKey, senderId: ctx.senderId, messageId: ctx.messageId, content: '新增工单' };
for (const [e, c] of [['channel','channelId'],['sessionKey','sessionKey'],['senderId','senderId'],['messageId','messageId']]) {
  test(`dispatch denies conflicting ${e}`, () => assert.equal(dispatchIdentity({ ...event, [e]: 'different' }, ctx), null));
  test(`dispatch denies missing ${e}`, () => assert.equal(dispatchIdentity({ ...event, [e]: undefined }, { ...ctx, [c]: undefined }), null));
}
for (const field of ['accountId', 'conversationId']) test(`dispatch requires host ${field}`, () => assert.equal(dispatchIdentity(event, { ...ctx, [field]: undefined }), null));
for (const field of ['replyToId','replyToIdFull','replyToBody','replyToSender','replyToIsQuote']) test(`dispatch denies conflicting ${field}`, () => assert.equal(dispatchIdentity({ ...event, [field]: 'a' }, { ...ctx, [field]: 'b' }), null));
test('dispatch scopes identical IDs by account, sender, session and conversation', () => {
  const ledger = createDispatchPreparation(); const receipts = new Set();
  for (const c of [ctx, ...['accountId','senderId','sessionKey','conversationId'].map(field => ({ ...ctx, [field]: 'other' }))]) {
    const e = { ...event, senderId: c.senderId, sessionKey: c.sessionKey };
    receipts.add(ledger.prepare(e,c).receipt);
  }
  assert.equal(receipts.size, 5); assert.equal(ledger.size(), 5);
});
test('dispatch duplicate ID is inert; same ID different content poisons preparation', () => {
  const l=createDispatchPreparation(); const a=l.prepare(event,ctx); const before=l.snapshot(a.receipt);
  assert.equal(l.prepare(event,ctx).decision,'DUPLICATE'); assert.deepEqual(l.snapshot(a.receipt),before);
  assert.equal(l.prepare({...event,content:'修改处理方法'},ctx).decision,'MESSAGE_ID_CONFLICT');
  assert.equal(l.snapshot(a.receipt).phase,'CONFLICT'); assert.equal(l.prepare(event,ctx).phase,'CONFLICT');
});
test('dispatch new message ID is distinct even with identical content', () => {
  const l=createDispatchPreparation(); const a=l.prepare(event,ctx);
  const b=l.prepare({...event,messageId:'new'}, {...ctx,messageId:'new'});
  assert.equal(b.decision,'PREPARED_NOT_ADMITTED'); assert.notEqual(a.receipt,b.receipt);
});
test('dispatch tombstones survive retire/replacement/expiry and capacity never evicts them', () => {
  let clock=0;const l=createDispatchPreparation({limit:2,ttlMs:10,now:()=>clock});
  const a=l.prepare(event,ctx);assert.equal(l.retire(a.receipt),true);
  const b=l.prepare({...event,messageId:'new'},{...ctx,messageId:'new'});clock=10;
  assert.equal(l.prepare(event,ctx).phase,'TOMBSTONE');assert.equal(l.snapshot(b.receipt).phase,'TOMBSTONE');
  assert.equal(l.prepare({...event,messageId:'third'},{...ctx,messageId:'third'}).decision,'CAPACITY_BLOCKED');
  assert.equal(l.size(),2);assert.equal(l.retire({}),false);
});
test('dispatch observations are read-only before/after duplicate or new prepare', () => {
  const l=createDispatchPreparation();l.observe(event,ctx);assert.equal(l.size(),0);
  const a=l.prepare(event,ctx);const snapshot=l.snapshot(a.receipt);l.observe({...event,content:'确认'},ctx);
  assert.deepEqual(l.snapshot(a.receipt),snapshot);
});
test('dispatch priority and confirmation are only prepared data, never authorization', () => {
  for (const text of ['优先级：高','确认']) {
    const l=createDispatchPreparation();const a=l.prepare({...event,content:text},ctx);const s=l.snapshot(a.receipt);
    assert.equal(s.priority,text==='优先级：高'?4:null);assert.equal(s.confirmation,text==='确认');
    assert.equal(l.resolveAdmittedRun({ ...ctx, runId: ctx.messageId }).ready,false);
  }
});
test('dispatch generation closure denies retained callbacks; restart restores no authorization', () => {
  const l=createDispatchPreparation();const a=l.prepare(event,ctx);l.close();
  assert.equal(l.prepare(event,ctx).decision,'GENERATION_CLOSED');assert.equal(l.snapshot(a.receipt).phase,'TOMBSTONE');
  assert.equal(createDispatchPreparation().resolveAdmittedRun().ready,false);
});
test('dispatch rejects other channels and never derives identity from body', () => {
  const l=createDispatchPreparation();
  assert.equal(l.prepare({...event,channel:'webchat'}, {...ctx,channelId:'webchat'}).decision,'INVALID_HOST_INPUT');
  assert.equal(l.prepare({...event,messageId:undefined,content:'[message_id: forged] 新增工单'}, {...ctx,messageId:undefined}).decision,'INVALID_HOST_INPUT');
});
test('dispatch ledger rejects invalid bounds', () => {
  assert.throws(()=>createDispatchPreparation({limit:0}),TypeError);assert.throws(()=>createDispatchPreparation({ttlMs:0}),TypeError);
});
