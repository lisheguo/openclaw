// Deliberately separate from the passing safety/regression suites. These are
// positive acceptance gates; failures MUST be reported, never counted as PASS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDispatchHarness } from './dispatch-harness.js';
import { handleInbound } from '../../lib/handlers.js';
import { createFlowStore } from '../../lib/state.js';
import { createFlowGatedToolFactory } from '../../lib/tool.js';
import { input } from '../support/harness.js';
const { inbound, create } = await loadDispatchHarness();
const ready = { flow: true, tool: true, skill: true };

test('ACCEPT-01 first command must have first Flow + Factory + Skill ready', async () => {
  const h = create(); const ctx = inbound(); await h.dispatch(ctx);
  assert.deepEqual(await h.readiness(ctx), ready);
});

test('ACCEPT-05 late observation must not be needed to repair first Factory/Skill', async () => {
  const h = create(); const ctx = inbound(); await h.dispatch(ctx);
  const first = await h.readiness(ctx); await h.observation(ctx);
  assert.deepEqual(first, ready); // Never substitute a second factory result.
});

test('ACCEPT-11 current runtime handler must preserve confirmation on replay of initial host message ID', async () => {
  // Direct current handler gate; official component CASE-11 independently
  // covers the registered path. No dispatch-to-run association is invented.
  const store = createFlowStore(); const noop = () => {};
  const deps = { store, cfg: {}, log: { info: noop, warn: noop, debug: noop } };
  const identity = { channelId: 'feishu', sessionKey: 'fixture-session', senderId: 'fixture-a' }; // Synthetic host context.
  const message = { ...identity, text: '新增工单', messageId: 'fixture-initial' };
  const { flow } = handleInbound(deps, message);
  const factory = createFlowGatedToolFactory(deps);
  await factory({ ...identity, requesterSenderId: identity.senderId }).execute('fixture-preflight', input);
  flow.preview_sent = true; flow.preview_hash = flow.draft.hash; flow.preview_message_id = 'fixture-preview';
  assert.equal(handleInbound(deps, { ...identity, text: '确认', messageId: 'fixture-confirm', replyToId: 'fixture-preview' }).decision, 'CONFIRMED');
  const evidence = structuredClone(flow);
  handleInbound(deps, message);
  assert.equal(flow.confirmed, true, 'same host message replay must not revoke the confirmed draft');
  assert.deepEqual(flow, evidence, 'all existing Flow and workflow evidence must remain unchanged');
});
