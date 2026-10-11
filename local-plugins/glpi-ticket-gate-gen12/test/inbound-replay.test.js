import test from 'node:test';
import assert from 'node:assert/strict';
import { createInboundReplayGuard, projectInboundMessage } from '../lib/inbound-replay.js';
import { createFlowStore } from '../lib/state.js';
import { handleInbound, handlePreflightCall, handleSent } from '../lib/handlers.js';
import { createFlowGatedToolFactory } from '../lib/tool.js';
import { input as preflightInput, hooksHarness } from './support/harness.js';

// All identity, transport, delivery and business values are synthetic. No live
// host/GLPI authentication is asserted, and missing-field cases stay missing.
const identity = { channelId: 'feishu', accountId: 'fixture-account', conversationId: 'fixture-chat', sessionKey: 'fixture-session', senderId: 'fixture-a' };
const initial = { ...identity, messageId: 'fixture-initial', text: '新增工单' };
const confirmation = { ...identity, messageId: 'fixture-confirmation', text: '确认', replyToId: 'fixture-preview' };
async function confirmed({ ttl = 100, capacity = 4096 } = {}) {
  let now = 1, seq = 0;
  const store = createFlowStore(ttl, () => now, () => `fixture-flow-${++seq}`, { capacity });
  const logs = []; const log = { info: x => logs.push(x), warn: x => logs.push(x), debug: x => logs.push(x) };
  const deps = { store, log, cfg: {} };
  const { flow } = handleInbound(deps, initial);
  handlePreflightCall(deps, { ...identity, runId: 'fixture-run', toolCallId: 'fixture-pf' });
  const tool = createFlowGatedToolFactory(deps)({ ...identity, requesterSenderId: identity.senderId });
  const result = await tool.execute('fixture-pf', preflightInput);
  assert.equal(handleSent(deps, { ...identity, runId: 'fixture-run', content: result.details.final_preview, messageId: 'fixture-preview', success: true }).previewRecorded, true);
  assert.equal(handleInbound(deps, confirmation).decision, 'CONFIRMED');
  return { store, deps, flow, logs, tick: value => { now = value; }, receive: msg => handleInbound(deps, msg) };
}

test('replay preserves every confirmed Flow/workflow field before any Flow read', async () => {
  const h = await confirmed();
  h.flow.workflow.ticket_id = 91; h.flow.workflow.operations.set('fixture-call', { kind: 'read' });
  h.flow.submissions.set('fixture-create', { allowed: true });
  const before = structuredClone(h.flow);
  h.store.get = () => { throw new Error('Replay must not read/purge Flow'); };
  assert.equal(h.receive(initial).decision, 'DUPLICATE_IGNORED');
  assert.deepEqual(h.flow, before);
});

test('duplicate confirmation neither reauthorizes nor changes timestamps', async () => {
  const h = await confirmed(); const before = structuredClone(h.flow); h.tick(50);
  assert.equal(h.receive(confirmation).decision, 'DUPLICATE_IGNORED'); assert.deepEqual(h.flow, before);
  h.receive({ ...identity, messageId: 'fixture-edit', text: '修改处理方法' });
  assert.equal(h.flow.confirmed, false);
  assert.equal(h.receive(confirmation).decision, 'DUPLICATE_IGNORED'); assert.equal(h.flow.confirmed, false);
});

test('confirmation rejected before a Flow exists cannot become valid by replay after preview', async () => {
  const store = createFlowStore(); const deps = { store, cfg: {}, log: { info() {}, warn() {} } };
  assert.equal(handleInbound(deps, confirmation).decision, 'CONFIRM_IGNORED_NOT_AUTHORIZED');
  const flow = handleInbound(deps, initial).flow;
  const tool = createFlowGatedToolFactory(deps)({ ...identity, requesterSenderId: identity.senderId });
  await tool.execute('fixture-pf', preflightInput);
  flow.preview_sent = true; flow.preview_hash = flow.draft.hash; flow.preview_message_id = 'fixture-preview';
  assert.equal(handleInbound(deps, confirmation).decision, 'DUPLICATE_IGNORED'); assert.equal(flow.confirmed, false);
  assert.equal(handleInbound(deps, { ...confirmation, messageId: 'fixture-new-confirmation' }).decision, 'CONFIRMED');
});

for (const patch of [{ text: '修改处理方法' }, { replyToId: 'different' }, { replyToIdFull: 'different-full' },
  { replyToBody: 'different body' }, { replyToSender: 'different sender' }, { replyToIsQuote: true }, { threadId: 'different-thread' }]) {
  test(`same native ID conflicting ${Object.keys(patch)[0]} preserves original evidence and receipt`, async () => {
    const h = await confirmed(); const before = structuredClone(h.flow);
    h.store.get = () => { throw new Error('Conflict must not read Flow'); };
    assert.equal(h.receive({ ...initial, ...patch }).decision, 'MESSAGE_ID_CONFLICT');
    assert.equal(h.receive(initial).decision, 'DUPLICATE_IGNORED'); assert.deepEqual(h.flow, before);
  });
}

for (const text of ['新增工单', '修改处理方法', '优先级：高', '普通聊天']) test(`new native ID remains substantive input: ${text}`, async () => {
  const h = await confirmed(); h.receive({ ...identity, messageId: 'fixture-new-message', text });
  assert.equal(h.flow.confirmed, false); assert.equal(h.flow.preflight_ok, false);
  assert.equal(h.flow.preview_sent, false); assert.equal(h.flow.draft, null);
  assert.equal(h.flow.priority_instruction?.value ?? null, text === '优先级：高' ? 4 : null);
});

test('completion/replacement retains original and confirmation tombstones', async () => {
  const h = await confirmed(); h.store.complete(h.flow);
  assert.equal(h.receive(initial).decision, 'DUPLICATE_IGNORED'); assert.equal(h.store.flows.size, 0);
  const newer = h.receive({ ...initial, messageId: 'fixture-second-flow' }).flow;
  assert.notEqual(newer.flow_id, h.flow.flow_id);
  const before = structuredClone(newer);
  assert.equal(h.receive(initial).decision, 'DUPLICATE_IGNORED');
  assert.equal(h.receive(confirmation).decision, 'DUPLICATE_IGNORED'); assert.deepEqual(newer, before);
});

test('Flow TTL never expires or evicts receipts; late replay does not purge Flow', async () => {
  const h = await confirmed(); h.tick(101); const before = structuredClone(h.flow);
  assert.equal(h.receive(initial).decision, 'DUPLICATE_IGNORED'); assert.deepEqual(h.flow, before);
  assert.equal(h.store.flows.size, 1); // No store.get happened on replay.
  assert.equal(h.store.get(identity.sessionKey, identity.senderId), undefined);
  assert.equal(h.receive(initial).decision, 'DUPLICATE_IGNORED');
  assert.equal(h.receive({ ...initial, messageId: 'fixture-after-ttl' }).decision, 'FLOW_STARTED');
});

test('capacity exhaustion denies new mutation without evicting completed/expired receipts', async () => {
  const h = await confirmed({ capacity: 2 }); const before = structuredClone(h.flow);
  assert.equal(h.receive({ ...initial, messageId: 'new', text: '修改处理方法' }).decision, 'CAPACITY_BLOCKED');
  assert.deepEqual(h.flow, before); h.store.complete(h.flow); h.tick(100000);
  assert.equal(h.receive(initial).decision, 'DUPLICATE_IGNORED');
  assert.equal(h.receive({ ...initial, messageId: 'new' }).decision, 'CAPACITY_BLOCKED'); assert.equal(h.store.flows.size, 0);
});

for (const field of ['senderId', 'sessionKey', 'channelId', 'messageId']) test(`missing ${field} denies both existing mutation and new Flow`, async () => {
  const h = await confirmed(); const before = structuredClone(h.flow); const msg = { ...initial, [field]: undefined };
  assert.equal(h.receive(msg).decision, field === 'messageId' ? 'MISSING_MESSAGE_ID' : 'NO_IDENTITY');
  assert.deepEqual(h.flow, before); h.store.complete(h.flow); h.receive(msg); assert.equal(h.store.flows.size, 0);
});

test('same group users, sessions and host-routed account/channel sessions do not cross-deduplicate', () => {
  const store = createFlowStore(); const deps = { store, log: { info() {}, warn() {} } };
  const inputs = [initial, { ...initial, senderId: 'fixture-b' }, { ...initial, sessionKey: 'fixture-other-session' },
    { ...initial, accountId: 'fixture-other-account', sessionKey: 'fixture-account-session' },
    { ...initial, channelId: 'slack', sessionKey: 'fixture-slack-session' }];
  for (const msg of inputs) assert.equal(handleInbound(deps, msg).decision, 'FLOW_STARTED');
  assert.equal(store.flows.size, 5);
  for (const msg of inputs) assert.equal(handleInbound(deps, msg).decision, 'DUPLICATE_IGNORED');
});

for (const field of ['accountId', 'channelId', 'conversationId']) test(`colliding session/sender with different ${field} cannot touch existing Flow`, async () => {
  const h = await confirmed(); const before = structuredClone(h.flow);
  assert.equal(h.receive({ ...initial, [field]: 'different', messageId: 'new', text: '修改处理方法' }).decision, 'FLOW_SCOPE_CONFLICT');
  assert.deepEqual(h.flow, before);
  assert.equal(h.receive({ ...initial, [field]: undefined, messageId: 'new' }).decision, field === 'channelId' ? 'NO_IDENTITY' : 'FLOW_SCOPE_CONFLICT');
});

test('receipt precedes synchronous reentry and survives handler exception', () => {
  const guard = createInboundReplayGuard(); let mutations = 0;
  assert.throws(() => guard.run(initial, snapshot => {
    mutations++; assert.ok(Object.isFrozen(snapshot));
    assert.equal(guard.run(initial, () => mutations++).decision, 'DUPLICATE_IGNORED');
    throw new Error('fixture failure after partial effect');
  }), /fixture failure/);
  assert.equal(mutations, 1); assert.equal(guard.run(initial, () => mutations++).decision, 'DUPLICATE_IGNORED');
  assert.equal(guard.run({ ...initial, text: 'different' }, () => mutations++).decision, 'MESSAGE_ID_CONFLICT');
  assert.equal(mutations, 1);
});

test('actual handler exception consumes its receipt and cannot be retried into a new Flow', () => {
  const store = createFlowStore(); const deps = { store, log: { info() {}, warn() {} } }; const get = store.get;
  store.get = () => { throw new Error('fixture interrupted handler'); };
  assert.throws(() => handleInbound(deps, initial), /fixture interrupted handler/); store.get = get;
  assert.equal(handleInbound(deps, initial).decision, 'DUPLICATE_IGNORED'); assert.equal(store.flows.size, 0);
  assert.equal(handleInbound(deps, { ...initial, messageId: 'fixture-explicit-new-command' }).decision, 'FLOW_STARTED');
});

test('distinct IDs process arrival order only; late unseen ID still invalidates confirmation', async () => {
  const h = await confirmed();
  h.receive({ ...identity, messageId: 'older-but-unseen', text: '修改处理方法', timestamp: 0 });
  assert.equal(h.flow.confirmed, false); // No fabricated transport ordering guarantee.
});

test('closed generation denies callbacks; fresh instance/multi-Gateway has NO cross-process dedup guarantee', () => {
  const old = createInboundReplayGuard(); let calls = 0;
  old.run(initial, () => calls++); old.close();
  assert.equal(old.run(initial, () => calls++).decision, 'GENERATION_CLOSED');
  assert.equal(old.run({ ...initial, messageId: 'new' }, () => calls++).decision, 'GENERATION_CLOSED');
  createInboundReplayGuard().run(initial, () => calls++); assert.equal(calls, 2);
  const fresh = createFlowStore(); assert.equal(fresh.flows.size, 0); // No restored confirmation.
});

test('same ID with changed runId/timestamp is still a replay, never a new authorization', () => {
  const g = createInboundReplayGuard(); let calls = 0; g.run(initial, () => calls++);
  assert.equal(g.run({ ...initial, runId: 'new-run', timestamp: Date.now() }, () => calls++).decision, 'DUPLICATE_IGNORED');
  assert.equal(calls, 1);
});

for (const field of ['sessionKey', 'senderId', 'messageId', 'channelId', 'accountId', 'conversationId', 'replyToId', 'replyToIdFull', 'replyToBody', 'replyToSender', 'replyToIsQuote']) {
  test(`registered host projection rejects conflicting ${field}`, () => {
    const ctx = { ...identity, messageId: initial.messageId, replyToId: 'preview', replyToIdFull: 'full', replyToBody: 'body', replyToSender: 'owner', replyToIsQuote: false };
    const event = { content: initial.text, [field]: field === 'replyToIsQuote' ? true : 'conflict' };
    assert.equal(projectInboundMessage(event, ctx).decision, 'IDENTITY_OR_LINK_CONFLICT');
  });
}

test('registered message hook rejects missing ID and conflicting scope before mutating a Flow', async () => {
  const h = hooksHarness(); h.emit('message_received', { content: initial.text, messageId: initial.messageId }, identity);
  const tc = { sessionKey: identity.sessionKey, requesterSenderId: identity.senderId };
  const tool = h.factory(tc); await tool.execute('fixture-pf', preflightInput);
  for (const [event, ctx] of [[{ content: '修改处理方法' }, identity],
    [{ content: '修改处理方法', messageId: 'new', accountId: 'forged' }, identity]]) {
    h.emit('message_received', event, ctx);
  }
  assert.ok(h.logs.some(x => x.includes('MISSING_MESSAGE_ID')));
  assert.ok(h.logs.some(x => x.includes('IDENTITY_OR_LINK_CONFLICT')));
  assert.equal(h.logs.some(x => x.includes('forged') || x.includes('修改处理方法')), false);
});

test('invalid receipt capacity and invalid message links deny before mutation', () => {
  assert.throws(() => createInboundReplayGuard({ capacity: 0 }), TypeError);
  const g = createInboundReplayGuard(); const fail = () => assert.fail('invalid input mutated');
  for (const patch of [{ replyToId: 3 }, { replyToIsQuote: 'true' }, { threadId: {} }]) assert.equal(g.run({ ...initial, ...patch }, fail).decision, 'INVALID_MESSAGE_LINK');
  assert.equal(g.run({ ...initial, accountId: '' }, fail).decision, 'INVALID_SCOPE');
  assert.equal(g.run({ ...initial, text: ' ' }, fail).decision, 'NONE'); assert.equal(g.size(), 0);
});
