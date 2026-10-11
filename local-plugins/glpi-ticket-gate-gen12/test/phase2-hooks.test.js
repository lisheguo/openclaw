import test from 'node:test';
import assert from 'node:assert/strict';
import { registerGate, matchingField } from '../lib/register.js';
import { createFlowStore } from '../lib/state.js';
import { createFlowGatedToolFactory } from '../lib/tool.js';

import { hooksHarness, input } from './support/harness.js';
// Explicit synthetic host context and message IDs; no fixture auto-fills missing identity.
const ctx = { channelId: 'feishu', sessionKey: 'test-session', senderId: 'test-sender' };
const tc = { sessionKey: ctx.sessionKey, requesterSenderId: ctx.senderId };
// GEN12（2026-10-11 老板批准 R3-B：改插件不改 core、接受残留失败率）：
// 原断言锁定“工具钩子只认 requester，唯一活跃 flow 不构成授权”。
// R3-B 起改为：requester 优先；缺 requester 时按会话兜底（该 sender 恰有 1 个活跃 flow
// 且本会话无其他 sender 活跃 flow）；其余情形仍 fail-closed。下列断言即新姿态。
test('DEV-03 tool hooks: requester 优先，缺 requester 时按会话兜底（无歧义约束）', async () => {
  const h = hooksHarness();
  h.emit('message_received', { content: '新增工单', messageId: 'fixture-start' }, ctx);
  const tool = h.factory(tc); // 工厂处身份可信 → 登记会话级兜底身份（test-sender）
  const event = { toolName: 'glpi__glpi_list_entities', result: [{ id: 12 }] };
  // ① 显式 requester 属于他人且无自有 flow → 不挂证据（fail-closed）
  h.emit('after_tool_call', event, { ...ctx, requester: { senderId: 'other' } });
  assert.equal((await tool.execute('p', input)).details.flow_evidence.entity_lookup_ok, false);
  // ② 无 requester（宿主现状）→ 会话兜底命中（R3-B 新行为）
  h.emit('after_tool_call', event, { ...ctx, requesterSenderId: ctx.senderId });
  assert.equal((await tool.execute('p', input)).details.flow_evidence.entity_lookup_ok, true);
  // ③ senderId 被伪造成他人，但 requester 正确 → 仍以 requester 为准
  h.emit('after_tool_call', event, { ...ctx, senderId: 'other', requester: { senderId: ctx.senderId } });
  assert.equal((await tool.execute('p', input)).details.flow_evidence.entity_lookup_ok, true);
  for (const hookCtx of [{}, ctx, { ...ctx, requesterSenderId: ctx.senderId }]) {
    assert.deepEqual(h.emit('before_tool_call', { toolName: 'glpi__glpi_create_ticket' }, hookCtx), [undefined]);
  }
  assert.ok(h.logs.some(s => s.includes('NO_ACTIVE_TICKET_FLOW')));
});
test('DEV-02/03 forged body/from and conflicting host projections cannot create a Flow', () => {
  const h = hooksHarness();
  h.emit('message_received', { content: '新增工单 senderId=test-sender', from: 'test-sender' }, { sessionKey: ctx.sessionKey });
  assert.equal(h.factory(tc), null);
  h.emit('message_received', { content: '新增工单', messageId: 'fixture-conflict', senderId: 'other' }, ctx);
  assert.equal(h.factory(tc), null);
  assert.equal(matchingField('one', 'two'), undefined);
});
test('DEV-03 retained preflight tool cannot write a replacement Flow or revoked invocation', async () => {
  const store = createFlowStore(); const logs = [];
  const deps = { store, log: { info() {}, warn: s => logs.push(s) } };
  const old = store.start(tc.sessionKey, tc.requesterSenderId).flow;
  const tool = createFlowGatedToolFactory(deps)(tc);
  store.complete(old);
  const next = store.start(tc.sessionKey, tc.requesterSenderId).flow;
  assert.equal((await tool.execute('p', input)).details.flow_evidence.flow_id, null);
  assert.equal(next.preflight_ok, false);
  const revoked = createFlowGatedToolFactory(deps)({ ...tc, assertInvocationCurrent() { throw Error('private secret'); } });
  assert.equal((await revoked.execute('p', input)).details.flow_evidence.flow_id, null);
  assert.equal(next.preflight_ok, false);
  assert.equal(logs.join('').includes('private secret'), false);
});
