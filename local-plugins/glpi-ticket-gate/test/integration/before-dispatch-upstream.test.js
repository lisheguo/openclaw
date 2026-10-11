import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { loadDispatchHarness } from './dispatch-harness.js';

const { u, inbound, create } = await loadDispatchHarness();
const hop = () => new Promise(resolve => setImmediate(resolve));
const denied = { flow: false, tool: false, skill: false };
after(() => {
  if (process.env.DISPATCH_SOURCE_INVENTORY) writeFileSync(process.env.DISPATCH_SOURCE_INVENTORY, JSON.stringify(Object.fromEntries(u.loaded), null, 2));
});

test('DISPATCH-01 official registrar accepts before_dispatch without conversation access; decline continues', async () => {
  const h = create(); const ctx = inbound();
  assert.ok(h.registry.typedHooks.some(x => x.hookName === 'before_dispatch'));
  const result = await h.dispatch(ctx);
  assert.equal(result.status, 'ready');
  assert.deepEqual(h.trace, ['prepared', 'admission']);
  assert.equal(h.prepared[0].decision, 'PREPARED_NOT_ADMITTED');
  assert.equal(h.seen[0].event.runId, undefined);
  assert.equal(h.seen[0].ctx.runId, undefined);
  assert.deepEqual(await h.readiness(ctx), denied); // Safety assertion, NOT positive readiness acceptance.
});

test('DISPATCH-02 actual claiming runner/choose-route await a barrier before final admission', async () => {
  const h = create(); let entered, release;
  const started = new Promise(r => { entered = r; });
  const barrier = new Promise(r => { release = r; });
  h.api.on('before_dispatch', async () => { entered(); await barrier; return { handled: false }; });
  const pending = h.dispatch(inbound()); await started;
  assert.deepEqual(h.trace, ['prepared']);
  release(); await pending; assert.deepEqual(h.trace, ['prepared', 'admission']);
});

for (const [name, options, expected] of [
  ['normal group', {}, '新增工单'],
  ['quote only', { content: '收到', quote: '新增工单' }, '收到'],
  ['display name only', { content: '收到', name: '新增工单' }, '收到'],
  ['mention rendering', { content: '收到', mention: true }, '收到'],
  ['audio transcript projection (ASR excluded)', { content: '[audio]', audioTranscript: '新增工单' }, '新增工单'],
  ['direct chat', { kind: 'direct' }, '新增工单'],
  ['thread route', { thread: 'fixture-thread', session: 'fixture-session-thread' }, '新增工单'],
]) test(`DISPATCH-03 real Feishu body + inbound builder/finalizer + mapper + dispatch: ${name}`, async () => {
  const h = create(); const ctx = inbound(options); await h.dispatch(ctx);
  const { event, ctx: hookCtx } = h.seen[0];
  assert.equal(event.content, expected);
  assert.equal(hookCtx.senderId, 'fixture-a'); assert.equal(hookCtx.accountId, 'fixture-account');
  assert.equal(event.messageId, 'fixture-message');
  assert.equal(event.isGroup, options.kind !== 'direct');
  assert.equal(h.ledger.snapshot(h.prepared[0].receipt).intent, expected === '新增工单');
  assert.ok(ctx.Body.includes('fixture history: 新增工单'));
  assert.notEqual(event.body, expected); // Rendered channel context remains separate.
});

test('DISPATCH-04 ordinary chat: no Flow, first tool or Skill', async () => {
  const h = create(); const ctx = inbound({ content: '今天天气不错', quote: '新增工单', name: '新增工单' });
  await h.dispatch(ctx); assert.deepEqual(await h.readiness(ctx), denied);
  assert.equal(h.ledger.snapshot(h.prepared[0].receipt).intent, false);
});

test('DISPATCH-04b blank command/raw falls back to rendered history: content provenance remains unproved', async () => {
  const h = create(); const ctx = inbound({ content: '', quote: '新增工单' });
  await h.dispatch(ctx);
  assert.equal(ctx.BodyForCommands, ''); assert.equal(ctx.RawBody, '');
  assert.equal(h.seen[0].event.content, ctx.Body);
  assert.equal(h.ledger.snapshot(h.prepared[0].receipt).intent, true); // Counterexample, NOT intent correctness PASS.
  assert.deepEqual(await h.readiness(ctx), denied); // Candidate never grants active Flow authority.
});

test('DISPATCH-05 official fire-and-forget observation early/late remains read-only in candidate', async () => {
  for (const early of [true, false]) {
    const h = create(); const ctx = inbound();
    if (early) { await h.observation(ctx); assert.equal(h.ledger.size(), 0); }
    await h.dispatch(ctx); const before = h.ledger.snapshot(h.prepared[0].receipt);
    await h.observation(ctx); await h.observation(ctx);
    assert.deepEqual(h.ledger.snapshot(h.prepared[0].receipt), before);
    for (const field of ['messageId', 'senderId', 'sessionKey', 'accountId', 'channelId']) {
      assert.equal(h.observed.at(-1).ctx[field], h.seen[0].ctx[field]);
    }
    assert.equal(h.observed.at(-1).ctx.runId, undefined); // Shared message projection is not a Run bridge.
    assert.equal(h.ledger.size(), 1); assert.deepEqual(await h.readiness(ctx), denied);
  }
});

test('DISPATCH-06 repeated ID is inert, distinct ID prepares separately, conflicting copies fail closed', async () => {
  const h = create(); const ctx = inbound(); await h.dispatch(ctx); await h.dispatch(ctx);
  assert.equal(h.prepared[1].decision, 'DUPLICATE'); assert.equal(h.ledger.size(), 1);
  await h.dispatch(inbound({ message: 'fixture-edit', content: '修改处理方法' }));
  assert.equal(h.ledger.size(), 2);
  await h.dispatch(inbound({ content: '更改内容' }));
  assert.equal(h.prepared.at(-1).decision, 'MESSAGE_ID_CONFLICT');
  const seen = h.seen[0];
  await h.runner.runBeforeDispatch({ ...seen.event, senderId: 'forged' }, seen.ctx);
  assert.equal(h.prepared.at(-1).decision, 'INVALID_HOST_INPUT');
});

test('DISPATCH-07 two users, accounts and threaded sessions have separate preparation scopes', async () => {
  const h = create();
  const contexts = [{}, {sender:'fixture-b'}, {account:'other-account'}, {thread:'other-thread',session:'other-thread-session'}].map(inbound);
  await Promise.all(contexts.map(ctx => h.dispatch(ctx)));
  assert.equal(h.ledger.size(), 4);
  assert.equal(new Set(h.prepared.map(p => h.ledger.snapshot(p.receipt).scope)).size, 4);
  for (const ctx of contexts) assert.deepEqual(await h.readiness(ctx), denied);
});

test('DISPATCH-08 missing host sender/message never borrows a preparation', async () => {
  const h = create(); await h.dispatch(inbound());
  for (const field of ['SenderId', 'MessageSid']) {
    const ctx = inbound(); delete ctx[field];
    await h.dispatch(ctx); assert.equal(h.prepared.at(-1).decision, 'INVALID_HOST_INPUT');
    assert.deepEqual(await h.readiness(ctx), denied);
  }
  assert.equal(h.ledger.size(), 1);
});

for (const status of ['busy', 'aborted']) test(`DISPATCH-09 real dispatch owner: prepared message can subsequently be ${status}`, async () => {
  const h = create(); const ctx = inbound(); const result = await h.dispatch(ctx, { status });
  assert.deepEqual(h.trace, ['prepared', 'admission']);
  assert.equal(result.status, 'complete'); assert.equal(result.result.fixture, status);
  assert.deepEqual(await h.readiness(ctx), denied);
  assert.equal(h.ledger.resolveAdmittedRun().ready, false);
});

test('DISPATCH-10 later claiming handler or substituted takeover can prevent model admission', async () => {
  const h = create(); h.api.on('before_dispatch', () => ({ handled: true }));
  assert.equal((await h.dispatch(inbound())).status, 'complete'); assert.deepEqual(h.trace, ['prepared']);
  const takeover = create();
  assert.equal((await takeover.dispatch(inbound(), { takeover: true })).status, 'complete');
  assert.deepEqual(takeover.trace, ['prepared']); // takeover service is substituted, not ACP integration.
  assert.deepEqual(await takeover.readiness(inbound()), denied);
});

test('DISPATCH-11 native abort wrapper fences an already aborted dispatch', async () => {
  const h = create(); const signal = AbortSignal.abort();
  await assert.rejects(h.dispatch(inbound(), { signal }), { name: 'AbortError' });
  assert.equal(h.ledger.size(), 0);
});

test('DISPATCH-11b abort during a later handler leaves only unadmitted preparation', async () => {
  const h = create(); const controller = new AbortController();
  h.api.on('before_dispatch', () => { controller.abort(); return { handled: false }; });
  await assert.rejects(h.dispatch(inbound(), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(h.ledger.size(), 1); assert.deepEqual(h.trace, ['prepared']);
  assert.deepEqual(await h.readiness(inbound()), denied);
});

test('DISPATCH-12 real eligibility excludes heartbeat-style state and restricted admitted settings', async () => {
  for (const options of [{ allow: false }, { settings: { permissionMode: 'read-only' } }, { settings: { toolOverrides: { webSearch: false } } }]) {
    const h = create(); await h.dispatch(inbound(), options);
    assert.equal(h.ledger.size(), 0); assert.deepEqual(h.trace, ['admission']);
  }
});

test('DISPATCH-13 exception and timeout fail open; candidate never authorizes the prepared message', async () => {
  const h = create();
  h.api.on('before_dispatch', () => { throw new Error('fixture fault'); });
  h.api.on('before_dispatch', () => new Promise(() => {}), { timeoutMs: 1 });
  assert.equal((await h.dispatch(inbound())).status, 'ready');
  assert.deepEqual(await h.readiness(inbound()), denied);
  // Actual claiming timeout; no sleep. Timeout does not cancel arbitrary side effects.
});

test('DISPATCH-14 replay/fallback-shaped duplicate and closed generation do not authorize; actual reload excluded', async () => {
  const h = create(); const ctx = inbound();
  await Promise.all([h.dispatch(ctx), h.dispatch(ctx)]); await h.dispatch(ctx);
  assert.equal(h.ledger.size(), 1); assert.equal(h.prepared.filter(p => p.decision === 'DUPLICATE').length, 2);
  h.ledger.close(); await h.dispatch(ctx); assert.equal(h.prepared.at(-1).decision, 'GENERATION_CLOSED');
  assert.deepEqual(await create().readiness(ctx), denied);
});

test('DISPATCH-15 240 mixed asynchronous component schedules keep preparation isolated; readiness is not passed', async t => {
  const h = create();
  for (let i = 0; i < 240; i++) {
    const ctx = inbound({ sender: `fixture-${i}`, message: `fixture-message-${i}` });
    if (i % 6 === 0) await h.observation(ctx);
    if (i % 6 === 1) await Promise.all([h.dispatch(ctx), h.observation(ctx)]);
    else await h.dispatch(ctx, { status: i % 6 === 5 ? 'busy' : 'accepted' });
    if (i % 6 >= 2) { await hop(); await h.observation(ctx); }
    if (i % 6 === 3) await h.dispatch(ctx);
    if (i % 6 === 4) await Promise.all([h.observation(ctx), h.observation(ctx)]);
    assert.deepEqual(await h.readiness(ctx), denied);
  }
  assert.equal(h.ledger.size(), 240);
  t.diagnostic('PREPARATION_SAFETY_PASS=true; FIRST_TURN_READINESS_PASS=false; these are constructed schedules, not production rates');
});
