import test from 'node:test';
import assert from 'node:assert/strict';
import { createInboundReplayGuard, INBOUND_RECEIPT_CAPACITY } from '../lib/inbound-replay.js';
import { reportReplayCapacity } from '../lib/replay-metrics.js';
import { createFlowStore } from '../lib/state.js';
import { handleInbound } from '../lib/handlers.js';

// Explicit synthetic host data. No production flow/volume or time source claims.
const identity = { channelId: 'feishu', accountId: 'fixture-private-account', conversationId: 'fixture-private-chat', sessionKey: 'fixture-private-session', senderId: 'fixture-private-user' };
const message = (messageId, patch = {}) => ({ ...identity, messageId, text: 'fixture private ordinary chat', ...patch });
const mutation = () => ({ decision: 'fixture-mutated' });

test('metrics reads are immutable, anonymous and do not allocate receipts/scopes or change counters', () => {
  const g = createInboundReplayGuard(); const before = g.metrics();
  for (let i = 0; i < 10000; i++) { g.metrics(); assert.equal(g.scopeMetrics({ ...identity, senderId: `unseen-${i}` }), null); }
  assert.deepEqual(g.metrics(), before); assert.equal(g.size(), 0);
  g.run(message('fixture-private-message'), mutation); const scope = g.scopeMetrics(identity);
  assert.equal(scope.RESERVED, 1); assert.ok(Object.isFrozen(scope));
  assert.throws(() => { scope.RESERVED = 999; }, TypeError);
  const snapshot = g.metrics(); assert.ok(Object.isFrozen(snapshot.counters));
  assert.throws(() => { snapshot.counters.RESERVED = 999; }, TypeError);
  const serialized = JSON.stringify([snapshot, scope]);
  for (const secret of Object.values(identity).concat('fixture-private-message', 'fixture private ordinary chat')) assert.equal(serialized.includes(secret), false);
  assert.doesNotMatch(serialized, /[a-f0-9]{32,}/); assert.equal(g.scopeMetrics({}), null);
});

test('default 4096 capacity pressure: four first-cross alerts, then permanent fail-closed despite long traffic', () => {
  const g = createInboundReplayGuard(); const warnings = []; let writes = 0;
  const log = { warn: line => warnings.push(line) };
  for (let i = 0; i < INBOUND_RECEIPT_CAPACITY; i++) {
    g.run(message(`fixture-${i}`), () => { writes++; }); reportReplayCapacity(g, log);
  }
  assert.equal(writes, 4096); assert.equal(g.size(), 4096);
  assert.deepEqual(warnings.map(line => Number(/threshold_pct=(\d+)/.exec(line)[1])), [70, 85, 95, 100]);
  assert.deepEqual(warnings.map(line => Number(/used=(\d+)/.exec(line)[1])), [2868, 3482, 3892, 4096]);
  const stop = () => assert.fail('full guard authorized new input');
  for (let i = 0; i < 20000; i++) {
    assert.equal(g.run(message(`overflow-${i}`, { senderId: `unseen-${i}` }), stop).decision, 'CAPACITY_BLOCKED');
    reportReplayCapacity(g, log);
  }
  assert.equal(warnings.length, 4);
  const m = g.metrics(); assert.equal(m.used, 4096); assert.equal(m.capacity, 4096); assert.equal(m.remaining, 0);
  assert.equal(m.scope_count, 1); assert.equal(m.counters.CAPACITY_BLOCKED, 20000); assert.equal(m.unattributed.CAPACITY_BLOCKED, 20000);
  assert.equal(m.rejected_total, 20000); assert.equal(g.scopeMetrics(identity).RESERVED, 4096);
  assert.equal(g.run(message('fixture-0'), stop).decision, 'DUPLICATE_IGNORED');
  assert.equal(g.run(message('fixture-0', { text: 'conflict' }), stop).decision, 'MESSAGE_ID_CONFLICT');
  assert.equal(g.run(message('other', { accountId: 'scope-conflict' }), stop).decision, 'FLOW_SCOPE_CONFLICT');
  assert.equal(g.metrics().counters.CAPACITY_BLOCKED, 20000); // Existing decision order preserved.
  assert.equal(g.scopeMetrics(identity).DUPLICATE_IGNORED, 1);
  assert.equal(g.scopeMetrics(identity).MESSAGE_ID_CONFLICT, 1);
});

test('anonymous per-scope counters isolate senders; refusals for untracked scopes never grow metrics state', () => {
  const g = createInboundReplayGuard({ capacity: 3 }); const a = identity, b = { ...identity, senderId: 'fixture-b' };
  g.run(message('one'), mutation); g.run(message('two'), mutation); g.run(message('one', b), mutation);
  g.run(message('one'), mutation); g.run(message('one', { ...b, text: 'different' }), mutation);
  g.run(message('overflow', b), mutation);
  const sa = g.scopeMetrics(a), sb = g.scopeMetrics(b);
  assert.equal(sa.RESERVED, 2); assert.equal(sa.DUPLICATE_IGNORED, 1); assert.equal(sa.MESSAGE_ID_CONFLICT, 0);
  assert.equal(sb.RESERVED, 1); assert.equal(sb.MESSAGE_ID_CONFLICT, 1); assert.equal(sb.CAPACITY_BLOCKED, 1);
  g.run(message('untracked', { accountId: 'different' }), mutation);
  assert.equal(g.metrics().scope_count, 2); assert.equal(g.metrics().unattributed.FLOW_SCOPE_CONFLICT, 1);
});

test('missing identity/message, invalid link/scope and projection conflicts count without receipt mutation', () => {
  const g = createInboundReplayGuard(); const stop = () => assert.fail('invalid input mutated');
  for (const field of ['channelId', 'sessionKey', 'senderId']) g.run(message('x', { [field]: undefined }), stop);
  g.run(message(undefined), stop); g.run(message('x', { accountId: '' }), stop);
  g.run(message('x', { replyToIsQuote: 'not-boolean' }), stop); g.run(message('x', { text: ' ' }), stop);
  g.recordProjectionConflict();
  const m = g.metrics(); assert.equal(m.used, 0); assert.equal(m.scope_count, 0);
  assert.equal(m.counters.NO_IDENTITY, 3); assert.equal(m.counters.MISSING_MESSAGE_ID, 1);
  assert.equal(m.counters.INVALID_SCOPE, 1); assert.equal(m.counters.INVALID_MESSAGE_LINK, 1);
  assert.equal(m.counters.IDENTITY_OR_LINK_CONFLICT, 1); assert.equal(m.counters.NONE, 1); assert.equal(m.rejected_total, 7);
});

test('handler errors retain receipts, count once, and monitoring cannot replace the original exception', () => {
  const g = createInboundReplayGuard({ capacity: 1 }); const error = new Error('fixture business failure');
  assert.throws(() => g.run(message('one'), () => { throw error; }), e => e === error);
  assert.equal(g.metrics().counters.RESERVED, 1); assert.equal(g.metrics().counters.HANDLER_ERROR, 1);
  assert.equal(g.scopeMetrics(identity).HANDLER_ERROR, 1);
  assert.equal(g.run(message('one'), mutation).decision, 'DUPLICATE_IGNORED');
  assert.doesNotThrow(() => reportReplayCapacity(g, { warn() { throw new Error('fixture logger failure'); } }));
  assert.equal(g.takeCapacityWarnings().length, 0); assert.equal(g.size(), 1);
  assert.doesNotThrow(() => reportReplayCapacity({ takeCapacityWarnings() { throw new Error('fixture monitor failure'); } }, {}));
});

test('warning callbacks run only after mutation/receipt, and throwing telemetry never changes a Flow result', () => {
  const store = createFlowStore(undefined, undefined, undefined, { capacity: 1 }); let warnings = 0;
  const deps = { store, cfg: {}, log: { info() {}, warn(line) {
    assert.ok(line.includes('inbound_replay_capacity'));
    assert.equal(store.inboundReplay.size(), 1); assert.equal(store.flows.size, 1);
    assert.equal(store.inboundReplay.run(message('one', { text: '新增工单' }), () => assert.fail()).decision, 'DUPLICATE_IGNORED');
    warnings++; throw new Error('fixture logger unavailable');
  } } };
  assert.equal(handleInbound(deps, message('one', { text: '新增工单' })).decision, 'FLOW_STARTED');
  assert.equal(warnings, 4); assert.equal(store.inboundReplay.metrics().counters.RESERVED, 1);
});

test('long-lived completed/expired Flows keep receipt usage and warning history, while new IDs keep old rules', () => {
  let now = 1; const logs = [];
  const store = createFlowStore(2, () => now, undefined, { capacity: 100 });
  const deps = { store, cfg: {}, log: { info() {}, warn: x => logs.push(x) } };
  for (let i = 0; i < 100; i++) {
    const flow = handleInbound(deps, message(`long-${i}`, { text: '新增工单' })).flow;
    if (i % 2) store.complete(flow);
    else { now += 3; assert.equal(store.get(identity.sessionKey, identity.senderId), undefined); }
  }
  assert.equal(store.inboundReplay.metrics().used, 100); assert.equal(store.flows.size, 0);
  assert.equal(logs.filter(x => x.includes('inbound_replay_capacity')).length, 4);
  assert.equal(handleInbound(deps, message('long-0', { text: '新增工单' })).decision, 'DUPLICATE_IGNORED');
  assert.equal(handleInbound(deps, message('new-flow', { text: '新增工单' })).decision, 'CAPACITY_BLOCKED');
  assert.equal(store.flows.size, 0);
  for (const line of logs.filter(x => x.includes('inbound_replay_capacity'))) {
    assert.match(line, /^mode=shadow event=inbound_replay_capacity threshold_pct=(70|85|95|100) used=\d+ capacity=100 scope_count=1$/);
    assert.doesNotMatch(line, /[a-f0-9]{32,}|fixture|long-/);
  }
});

test('metrics lifetime follows the existing instance boundary, without silently reopening a closed guard', () => {
  const old = createInboundReplayGuard({ capacity: 1 }); old.run(message('one'), mutation);
  old.close(); assert.equal(old.run(message('one'), mutation).decision, 'GENERATION_CLOSED');
  assert.equal(old.metrics().used, 1); assert.equal(old.metrics().counters.GENERATION_CLOSED, 1);
  const fresh = createInboundReplayGuard({ capacity: 1 }); assert.equal(fresh.metrics().used, 0);
  assert.equal(fresh.run(message('one'), mutation).decision, 'fixture-mutated');
  // Explicitly demonstrates NO cross-restart deduplication guarantee.
});
