import test from 'node:test';
import assert from 'node:assert/strict';
import { registerGate, matchingField } from '../lib/register.js';
import { createFlowStore } from '../lib/state.js';
import { createFlowGatedToolFactory } from '../lib/tool.js';

import { hooksHarness, input } from './support/harness.js';
// Explicit synthetic host context and message IDs; no fixture auto-fills missing identity.
const ctx = { channelId: 'feishu', sessionKey: 'test-session', senderId: 'test-sender' };
const tc = { sessionKey: ctx.sessionKey, requesterSenderId: ctx.senderId };
test('DEV-03 registered adapters accept only requester for tool hooks', async () => {
  const h = hooksHarness();
  h.emit('message_received', { content: '新增工单', messageId: 'fixture-start' }, ctx);
  const tool = h.factory(tc);
  const event = { toolName: 'glpi__glpi_list_entities', result: [{ id: 12 }] };
  h.emit('after_tool_call', event, { ...ctx, requesterSenderId: ctx.senderId });
  assert.equal((await tool.execute('p', input)).details.flow_evidence.entity_lookup_ok, false);
  h.emit('after_tool_call', event, { ...ctx, requester: { senderId: 'other' } });
  assert.equal((await tool.execute('p', input)).details.flow_evidence.entity_lookup_ok, false);
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
