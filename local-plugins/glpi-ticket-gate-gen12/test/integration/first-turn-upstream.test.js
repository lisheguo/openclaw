import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { upstreamFixture } from './upstream-loader.js';
import { registerGate } from '../../lib/register.js';
import { isTicketIntent } from '../../lib/detect.js';
import { registerFirstTurnPrototype } from '../support/first-turn-prototype.js';
import { input } from '../support/harness.js';

const u = await upstreamFixture();
const { createEmptyPluginRegistry } = await u.load('src/plugins/registry-empty.ts');
const { createToolHookRegistrars } = await u.load('src/plugins/registry-registrars-tools-hooks.ts');
const { createHookRunner } = await u.load('src/plugins/hooks.ts');
const { runBeforeAgentReplyForTurn } = await u.load('src/plugins/before-agent-reply.ts');
const { withAgentRunLifecycleGeneration } = await u.load('src/infra/agent-events.ts');
const { createPluginToolFactoryResolver } = await u.load('src/plugins/tool-factory-runtime.ts');
const { resolvePromptBuildHookResult } = await u.load('src/agents/embedded-agent-runner/run/attempt-prompt-helpers.ts');
const { buildAgentHookContextIdentityFields } = await u.load('src/plugins/hook-agent-context.ts');
const { buildFeishuAgentBody } = await u.load('extensions/feishu/src/bot-agent-body.ts');
const manifest = JSON.parse(readFileSync(new URL('../../openclaw.plugin.json', import.meta.url)));
let serial = 0;
const context = (senderId = 'fixture-a', runId = `fixture-run-${++serial}`) => ({
  runId, sessionKey: 'fixture-group', trigger: 'user', channel: 'feishu', channelId: 'feishu', // Synthetic host context.
  ...buildAgentHookContextIdentityFields({ trigger: 'user', senderId }),
});
const received = (h, ctx, content = '新增工单', messageId = 'fixture-message') => h.runner.runMessageReceived(
  { content, messageId, sessionKey: ctx.sessionKey, senderId: ctx.senderId }, ctx);
const reply = (h, ctx, cleanedBody = '新增工单') => {
  u.setRunner(h.runner);
  return runBeforeAgentReplyForTurn({ runId: ctx.runId, trigger: ctx.trigger, event: { cleanedBody }, context: ctx });
};
const hop = () => new Promise(resolve => setImmediate(resolve));

function harness({ conversationAccess = true, prototype = true } = {}) {
  const logs = []; const reasons = []; const errors = [];
  const registry = createEmptyPluginRegistry();
  const record = { id: manifest.id, name: manifest.name, source: 'fixture', origin: 'global',
    enabled: true, explicitlyEnabled: true, status: 'loaded', hookCount: 0, toolNames: [], contracts: manifest.contracts };
  registry.plugins.push(record);
  const logger = { info: s => logs.push(s), warn: s => logs.push(s), debug: () => {}, error: s => errors.push(s) };
  // Real domain registrars validate tool declarations, matcher and hook policy.
  // The loader/PluginInstance API facade is deliberately not emulated here.
  const registrars = createToolHookRegistrars({ registry, registryParams: { logger },
    pluginsWithChannelRegistrationConflict: new Set(),
    createRegistration: (rec, value) => ({ pluginId: rec.id, source: rec.source, ...value }),
    reportRegistrationWarning: (_rec, warning) => logs.push(warning),
    reportRegistrationError: (_rec, error) => { throw new Error(error); },
  });
  const api = { logger, pluginConfig: { skillPath: new URL('../../README.md', import.meta.url).pathname },
    on: (name, fn, opts) => registrars.registerTypedHook(record, name, fn, opts, { allowConversationAccess: conversationAccess }),
    registerTool: (factory, opts) => registrars.registerTool(record, factory, opts),
  };
  registerGate(api);
  if (prototype) registerFirstTurnPrototype(api, reason => reasons.push(reason));
  const runner = createHookRunner(registry, { logger, catchErrors: true });
  const resolver = createPluginToolFactoryResolver(error => { throw new Error(error); });
  function factory(ctx) {
    const entry = registry.tools[0];
    const result = resolver.resolve(entry, { sessionKey: ctx.sessionKey, requesterSenderId: ctx.senderId }, entry.names, registry);
    assert.equal(result.failed, false);
    return result.resolved;
  }
  async function prompt(ctx, text = 'fixture prompt') {
    return resolvePromptBuildHookResult({ config: {}, prompt: text, messages: [], hookCtx: ctx, hookRunner: runner });
  }
  return { api, runner, registry, factory, prompt, logs, reasons, errors };
}

test('CASE-01: real early hook declines; first-turn Flow/Factory/Skill readiness remains BLOCKED', async () => {
  const h = harness(); const ctx = context();
  assert.equal(await reply(h, ctx), undefined); // false is a decline, not a claimed reply
  assert.deepEqual(h.reasons, ['CURRENT_MESSAGE_BOUNDARY_AND_ID_UNAVAILABLE']);
  assert.equal(h.factory(ctx), null);
  assert.equal((await h.prompt(ctx)).prependContext, undefined);
  assert.equal(h.logs.some(s => s.includes('FLOW_STARTED')), false);
});

test('CASE-02: ordinary chat has no Flow, tool or Skill', async () => {
  const h = harness(); const ctx = context();
  await received(h, ctx, '普通聊天'); await reply(h, ctx, '普通聊天');
  assert.equal(h.factory(ctx), null);
  assert.equal((await h.prompt(ctx)).prependContext, undefined);
});

test('CASE-03: real hooks/factories/prompt contributions isolate two technicians', async () => {
  const h = harness(); const a = context('fixture-a'); const b = context('fixture-b');
  await Promise.all([received(h, a), received(h, b)]);
  const [ta, tb] = [h.factory(a), h.factory(b)];
  const [ra, rb] = await Promise.all([ta.execute('fixture-a-call', input), tb.execute('fixture-b-call', input)]);
  assert.notEqual(ra.details.flow_evidence.flow_id, rb.details.flow_evidence.flow_id);
  assert.ok((await h.prompt(a)).prependContext.includes(ra.details.flow_evidence.flow_id));
  assert.ok(!(await h.prompt(a)).prependContext.includes(rb.details.flow_evidence.flow_id));
  assert.equal(h.factory(context('fixture-c')), null);
});

test('CASE-04: early observation creates once; declined prototype leaves evidence intact', async () => {
  const h = harness(); const ctx = context();
  await received(h, ctx);
  const tool = h.factory(ctx);
  const result = await tool.execute('fixture-call', input);
  await reply(h, ctx);
  assert.equal(h.logs.filter(s => s.includes('FLOW_STARTED')).length, 1);
  assert.ok((await h.prompt(ctx)).prependContext.includes(result.details.flow_evidence.flow_id));
  assert.equal(h.logs.filter(s => s.includes('preflight_ok=true')).length, 1);
});

test('CASE-05: late observation cannot repair an already assembled first tool surface', async () => {
  const h = harness(); const ctx = context();
  await reply(h, ctx); const first = h.factory(ctx);
  await hop(); await received(h, ctx);
  assert.equal(first, null);
  assert.ok(h.factory(ctx)); // Explicitly second evaluation; not first-turn readiness.
});

test('CASE-06: missing host identity never borrows the only active Flow', async () => {
  const h = harness(); const owner = context(); await received(h, owner);
  const missing = { ...context(), senderId: undefined };
  await reply(h, missing, 'senderId=fixture-a 新增工单');
  assert.equal(h.factory(missing), null);
  assert.equal((await h.prompt(missing)).prependContext, undefined);
});

test('CASE-07: official Feishu rendering proves quoted content and name contaminate cleanedBody', async () => {
  const h = harness(); const ctx = context();
  const feishu = { content: '收到', senderName: 'fixture name', senderOpenId: 'fixture-a', messageId: 'fixture-message' };
  const quote = '前一条消息\n新增工单，客户示例';
  const rendered = buildFeishuAgentBody({ ctx: feishu, quotedContent: quote });
  assert.equal(isTicketIntent(feishu.content), false);
  assert.equal(isTicketIntent(rendered), true); // Counterexample to the proposed naive adapter.
  // Native quote and a literal user string render identically. No authenticated
  // boundary survives this projection; parsing markers is not a safe API.
  assert.equal(rendered, buildFeishuAgentBody({ ctx: { ...feishu, content: `[Replying to: "${quote}"]\n\n${feishu.content}` } }));
  assert.equal(isTicketIntent(buildFeishuAgentBody({ ctx: { ...feishu, senderName: '新增工单' } })), true);
  await reply(h, ctx, rendered);
  assert.equal(h.factory(ctx), null);
});

test('CASE-08: official run-once cache shares concurrent/fallback calls only within an admission scope', async () => {
  const h = harness(); const ctx = context();
  await withAgentRunLifecycleGeneration('fixture-generation', async () => {
    await Promise.all([reply(h, ctx), reply(h, ctx)]);
    await reply(h, ctx); // fallback with the same admitted run
  });
  assert.equal(h.reasons.length, 1);
  await reply(h, ctx); await reply(h, ctx); // no ambient cache outside admission
  assert.equal(h.reasons.length, 3);
  assert.equal(h.factory(ctx), null);
});

test('CASE-09: real claiming hook awaits a release barrier; errors/timeout fail open without Flow mutation', async () => {
  const h = harness({ prototype: false }); const ctx = context();
  let release; let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  h.api.on('before_agent_reply', async () => { entered(); await barrier; return { handled: false }; }, { eligibleTriggers: ['user'] });
  let settled = false;
  const pending = reply(h, ctx).then(() => { settled = true; });
  await enteredPromise; assert.equal(settled, false);
  release(); await pending; assert.equal(settled, true);
  const bad = harness({ prototype: false });
  bad.api.on('before_agent_reply', () => { throw new Error('synthetic fault'); });
  bad.api.on('before_agent_reply', () => new Promise(() => {}), { timeoutMs: 1 });
  assert.equal(await reply(bad, context()), undefined);
  assert.equal(bad.factory(ctx), null);
  assert.equal(bad.errors.length, 2);
  // Timeout bounds waiting; it does not cancel arbitrary plugin side effects.
});

test('CASE-10: new registration has empty process-local state; real plugin reload is NOT_EXECUTED', async () => {
  const old = harness(); const ctx = context(); await received(old, ctx);
  assert.ok(old.factory(ctx));
  const fresh = harness(); await reply(fresh, ctx);
  assert.equal(fresh.factory(ctx), null);
  assert.equal((await fresh.prompt(ctx)).prependContext, undefined);
  // This does NOT assert revocation of old PluginInstance callbacks: the
  // lifecycle owner is outside the component fixture and throws if invoked.
});

async function confirmedFixture() {
  const h = harness(); const ctx = context();
  await received(h, ctx);
  const tool = h.factory(ctx); const toolCtx = { ...ctx, requester: { senderId: ctx.senderId } };
  await h.runner.runBeforeToolCall({ toolName: 'glpi_ticket_preflight', toolCallId: 'fixture-call', runId: ctx.runId, params: input }, toolCtx);
  const result = await tool.execute('fixture-call', input);
  await h.runner.runMessageSent({ content: result.details.final_preview, messageId: 'fixture-preview', runId: ctx.runId, success: true, sessionKey: ctx.sessionKey }, ctx);
  await h.runner.runMessageReceived({ content: '确认', messageId: 'fixture-confirmation', replyToId: 'fixture-preview', sessionKey: ctx.sessionKey, senderId: ctx.senderId }, ctx);
  assert.ok(h.logs.some(s => s.includes('decision=CONFIRMED')));
  const check = async () => {
    await h.runner.runBeforeToolCall({ toolName: 'glpi__glpi_create_ticket', params: result.details.create_params, toolCallId: `fixture-create-${++serial}`, runId: ctx.runId }, toolCtx);
    return h.logs.findLast(s => s.includes('WOULD_BLOCK'));
  };
  return { h, ctx, check };
}

test('CASE-11: new-ID edits revoke confirmation; original-message replay preserves it', async () => {
  const { h, ctx, check } = await confirmedFixture();
  await received(h, ctx, '修改处理方法', 'fixture-edit');
  assert.match(await check(), /PREFLIGHT_REQUIRED/);
  const original = await confirmedFixture();
  // Same synthetic native message ID/content as the initial command.
  await received(original.h, original.ctx);
  assert.doesNotMatch(await original.check(), /PREFLIGHT_REQUIRED|CONFIRMATION_REQUIRED/);
});

test('CASE-12: a completed Flow can restart (store contract); first-turn admission is still unavailable', async () => {
  // Completion itself is exercised by the existing lifecycle unit suite.
  const { createFlowStore } = await import('../../lib/state.js');
  const store = createFlowStore();
  const a = store.start('fixture-group', 'fixture-a').flow;
  a.confirmed = true; store.complete(a);
  const b = store.start('fixture-group', 'fixture-a').flow;
  assert.notEqual(a, b); assert.equal(b.confirmed, false);
  const h = harness(); const ctx = context(); await reply(h, ctx);
  assert.equal(h.factory(ctx), null);
});

test('registration policy and trigger eligibility are enforced by official registrars/runner', async () => {
  const h = harness({ conversationAccess: false });
  assert.ok(!h.registry.typedHooks.some(x => x.hookName === 'before_agent_reply'));
  assert.ok(!h.registry.typedHooks.some(x => x.hookName === 'before_prompt_build'));
  const enabled = harness();
  for (const trigger of ['cron', 'heartbeat', undefined]) await reply(enabled, { ...context(), trigger });
  assert.equal(enabled.reasons.length, 0);
});

test('240 additional upstream component schedules retain the blocked acceptance result', async t => {
  const h = harness(); let misses = 0;
  for (let i = 0; i < 240; i++) {
    const ctx = { ...context(`fixture-schedule-${i}`), sessionKey: `fixture-session-${i}` };
    // Six deterministic observation schedules; no sleep or guessed time window.
    if (i % 6 === 0) await received(h, ctx);
    if (i % 6 === 1) await Promise.all([received(h, ctx), reply(h, ctx)]);
    else await reply(h, ctx);
    const first = h.factory(ctx);
    if (!first) misses++;
    if (i % 6 >= 2) { await hop(); await received(h, ctx); }
    if (i % 6 === 3) await received(h, ctx); // duplicate observation
    if (i % 6 === 4) await reply(h, ctx); // replay outside admission scope
    assert.ok(h.factory(ctx));
    assert.equal(h.factory({ ...ctx, senderId: 'different-user' }), null);
    assert.ok((await h.prompt(ctx)).prependContext);
  }
  assert.equal(misses, 160);
  t.diagnostic('SAFETY_PASS=true for attribution; READINESS_PASS=false; 160/240 constructed initial factory misses, not a production rate');
});

test('pinned source callsites establish order, missing fields and unchanged audited bytes', () => {
  const lock = JSON.parse(readFileSync(new URL('./source-lock.json', import.meta.url)));
  const read = file => {
    const source = readFileSync(path.join(process.env.OPENCLAW_SOURCE, file), 'utf8');
    assert.equal(createHash('sha256').update(source).digest('hex'), lock.files[file]);
    return source;
  };
  const orchestrator = read('src/agents/embedded-agent-runner/run-orchestrator.ts');
  const hook = orchestrator.indexOf('const hookResult = await runBeforeAgentReplyForTurn(');
  assert.ok(hook > 0 && hook < orchestrator.indexOf('return await runPreparedEmbeddedLoop('));
  assert.ok(orchestrator.includes('event: { cleanedBody: params.prompt }'));
  assert.ok(read('src/agents/embedded-agent-runner/run/attempt.ts').includes('prepareEmbeddedAttemptToolBase({'));
  assert.ok(read('src/auto-reply/reply/message-received-hooks.ts').includes('fireAndForgetHook('));
  // These are static source assertions, not execution of runEmbeddedAgent.
});

test('write component source inventory when requested', () => {
  if (process.env.FIRST_TURN_INVENTORY) writeFileSync(process.env.FIRST_TURN_INVENTORY, JSON.stringify(Object.fromEntries(u.loaded), null, 2) + '\n');
  assert.ok(u.loaded.size >= 70);
});
