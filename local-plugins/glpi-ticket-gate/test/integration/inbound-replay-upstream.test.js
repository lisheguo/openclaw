import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dispatchFixtureSource } from './dispatch-loader.js';
import { registerGate } from '../../lib/register.js';
import { input } from '../support/harness.js';

// Real fixed registrars/runner/inbound builder/finalizer/mapper/emitter. Transport
// authentication and outbound delivery are explicitly synthetic, not executed.
// No before_dispatch or first-turn prototype is imported/registered here.
const u = await dispatchFixtureSource();
const { createEmptyPluginRegistry } = await u.load('src/plugins/registry-empty.ts');
const { createToolHookRegistrars } = await u.load('src/plugins/registry-registrars-tools-hooks.ts');
const { createHookRunner } = await u.load('src/plugins/hooks.ts');
const { createPluginToolFactoryResolver } = await u.load('src/plugins/tool-factory-runtime.ts');
const { buildChannelInboundEventContext } = await u.load('src/channels/inbound-event/context.ts');
const { emitMessageReceivedHooks } = await u.load('src/auto-reply/reply/message-received-hooks.ts');
const manifest = JSON.parse(readFileSync(new URL('../../openclaw.plugin.json', import.meta.url)));
const host = { channelId: 'feishu', accountId: 'fixture-account', conversationId: 'fixture-chat', sessionKey: 'fixture-session', senderId: 'fixture-a', runId: 'fixture-run' };

function harness() {
  const logs = []; const registry = createEmptyPluginRegistry();
  const record = { id: manifest.id, source: 'fixture', origin: 'global', enabled: true, explicitlyEnabled: true, status: 'loaded', hookCount: 0, toolNames: [], contracts: manifest.contracts };
  registry.plugins.push(record);
  const logger = { info: s => logs.push(s), warn: s => logs.push(s), debug() {}, error: s => logs.push(s) };
  const registrars = createToolHookRegistrars({ registry, registryParams: { logger }, pluginsWithChannelRegistrationConflict: new Set(),
    createRegistration: (r, value) => ({ pluginId: r.id, source: r.source, ...value }),
    reportRegistrationWarning: (_r, s) => logs.push(s), reportRegistrationError: (_r, s) => { throw new Error(s); } });
  registerGate({ logger, pluginConfig: { skillPath: new URL('../../README.md', import.meta.url).pathname },
    on: (name, fn, options) => registrars.registerTypedHook(record, name, fn, options, { allowConversationAccess: true }),
    registerTool: (factory, options) => registrars.registerTool(record, factory, options) });
  const runner = createHookRunner(registry, { logger, catchErrors: true });
  const resolver = createPluginToolFactoryResolver(s => { throw new Error(s); });
  function factory(ctx = host) {
    const entry = registry.tools[0];
    const result = resolver.resolve(entry, { sessionKey: ctx.sessionKey, requesterSenderId: ctx.senderId, agentAccountId: ctx.accountId }, entry.names, registry);
    assert.equal(result.failed, false); return result.resolved;
  }
  async function receive({ text = '新增工单', messageId = 'fixture-initial', replyToId, ctx = host, missingMessageId = false } = {}) {
    const inbound = buildChannelInboundEventContext({ channel: ctx.channelId, accountId: ctx.accountId,
      from: 'fixture-from', messageId: missingMessageId ? undefined : messageId,
      sender: { id: ctx.senderId }, conversation: { id: ctx.conversationId, kind: 'group', label: 'fixture-group' },
      route: { agentId: 'fixture-agent', accountId: ctx.accountId, routeSessionKey: ctx.sessionKey },
      reply: { to: ctx.conversationId, replyToId }, message: { rawBody: text, commandBody: text, body: text, bodyForAgent: text } });
    let done; const pending = new Promise(resolve => { done = resolve; });
    emitMessageReceivedHooks({ ctx: inbound, sessionKey: undefined, hookRunner: { hasHooks: runner.hasHooks,
      runMessageReceived: async (...args) => { try { await runner.runMessageReceived(...args); } finally { done(); } } } });
    await pending; // Test coordination only; official emitter remains fire-and-forget.
  }
  async function confirmed() {
    await receive(); const tool = factory(); const toolCtx = { ...host, requester: { senderId: host.senderId } };
    await runner.runBeforeToolCall({ toolName: 'glpi_ticket_preflight', toolCallId: 'fixture-pf', runId: host.runId, params: input }, toolCtx);
    const result = await tool.execute('fixture-pf', input);
    await runner.runMessageSent({ content: result.details.final_preview, success: true, messageId: 'fixture-preview', runId: host.runId }, host);
    await receive({ text: '确认', messageId: 'fixture-confirm', replyToId: 'fixture-preview' });
    assert.equal((await tool.execute('fixture-observe', input)).details.flow_evidence.confirmed, true);
    return tool;
  }
  return { registry, logs, runner, factory, receive, confirmed };
}

test('REPLAY-C01 official registration/mapper/emitter preserves initial and confirmation replays', async () => {
  const h = harness(); const tool = await h.confirmed();
  assert.equal(h.registry.typedHooks.filter(x => x.hookName === 'message_received').length, 1);
  assert.equal(h.registry.typedHooks.some(x => x.hookName === 'before_dispatch'), false);
  await Promise.all([h.receive(), h.receive(), h.receive({ text: '确认', messageId: 'fixture-confirm', replyToId: 'fixture-preview' })]);
  assert.equal((await tool.execute('fixture-observe-again', input)).details.flow_evidence.confirmed, true);
  assert.equal(h.logs.filter(x => x.includes('decision=CONFIRMED')).length, 1);
  assert.equal(h.logs.filter(x => x.includes('decision=DUPLICATE_IGNORED')).length, 3);
});

test('REPLAY-C02 official path rejects same-ID text/reply conflict; true new ID revokes confirmation', async () => {
  const h = harness(); const tool = await h.confirmed();
  await h.receive({ text: '修改处理方法' }); await h.receive({ replyToId: 'different-preview' });
  assert.equal((await tool.execute('fixture-observe', input)).details.flow_evidence.confirmed, true);
  assert.equal(h.logs.filter(x => x.includes('MESSAGE_ID_CONFLICT')).length, 2);
  await h.receive({ messageId: 'fixture-new-edit', text: '新增工单' });
  assert.equal((await tool.execute('fixture-observe-new-edit', input)).details.flow_evidence.confirmed, false);
});

test('REPLAY-C03 missing/conflicting official identity never changes accepted evidence', async () => {
  const h = harness(); const tool = await h.confirmed();
  await h.receive({ text: '修改处理方法', missingMessageId: true });
  await h.receive({ text: '修改处理方法', ctx: { ...host, senderId: undefined } });
  await h.runner.runMessageReceived({ content: '修改处理方法', messageId: 'fixture-new', senderId: 'conflict' }, host);
  assert.equal((await tool.execute('fixture-observe', input)).details.flow_evidence.confirmed, true);
  for (const reason of ['MISSING_MESSAGE_ID', 'NO_IDENTITY', 'IDENTITY_OR_LINK_CONFLICT']) assert.ok(h.logs.some(x => x.includes(reason)));
});

test('REPLAY-C04 real host scope projection separates routed owners and rejects a colliding Flow scope', async () => {
  const h = harness(); const tool = await h.confirmed();
  await h.receive({ ctx: { ...host, accountId: 'other-account' }, messageId: 'fixture-new' });
  assert.ok(h.logs.some(x => x.includes('FLOW_SCOPE_CONFLICT')));
  assert.equal((await tool.execute('fixture-observe', input)).details.flow_evidence.confirmed, true);
  const others = [{ ...host, senderId: 'fixture-b' }, { ...host, accountId: 'other-account', sessionKey: 'other-session' }];
  await Promise.all(others.map(ctx => h.receive({ ctx })));
  const ids = await Promise.all([host, ...others].map(async ctx => (await h.factory(ctx).execute('fixture-id', input)).details.flow_evidence.flow_id));
  assert.equal(new Set(ids).size, 3);
});

test('REPLAY-C05 official registered path emits four anonymous warnings and remains blocked at 4096', async () => {
  const h = harness();
  for (let i = 0; i < 4096; i++) await h.receive({ messageId: `capacity-${i}`, text: '普通聊天' });
  const warnings = h.logs.filter(x => x.includes('event=inbound_replay_capacity'));
  assert.equal(warnings.length, 4);
  assert.deepEqual(warnings.map(x => Number(/threshold_pct=(\d+)/.exec(x)[1])), [70, 85, 95, 100]);
  for (const line of warnings) assert.doesNotMatch(line, /fixture|capacity-\d|[a-f0-9]{32,}/);
  await h.receive({ messageId: 'new-ticket-after-capacity' });
  assert.equal(h.factory(), null); assert.ok(h.logs.some(x => x.includes('CAPACITY_BLOCKED')));
  await h.receive({ messageId: 'capacity-0', text: '普通聊天' });
  assert.ok(h.logs.some(x => x.includes('DUPLICATE_IGNORED')));
  assert.equal(h.logs.filter(x => x.includes('event=inbound_replay_capacity')).length, 4);
});
