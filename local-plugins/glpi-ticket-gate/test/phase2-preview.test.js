import test from 'node:test';
import assert from 'node:assert/strict';
import { hooksHarness, input } from './support/harness.js';
import { createFlowStore } from '../lib/state.js';
import { handleEntityLookup, handleEntityConfirm, handleCreateCheck, handleCreateResult, recordPreflightEvidence } from '../lib/handlers.js';
import { maskId } from '../lib/log.js';
import { resolveConfig } from '../lib/config.js';

function setup() {
  const h = hooksHarness();
  const ctx = { channelId: 'feishu', sessionKey: 'fixture-session', senderId: 'fixture-tech-a', runId: 'fixture-run-a', trigger: 'user' }; // Synthetic host fields.
  const toolctx = { sessionKey: ctx.sessionKey, requesterSenderId: ctx.senderId };
  const hookctx = { sessionKey: ctx.sessionKey, runId: ctx.runId, requester: { senderId: ctx.senderId, senderIsOwner: true } };
  h.emit('message_received', { content: '新增工单', messageId: 'm-start' }, ctx);
  h.emit('before_prompt_build', {}, ctx);
  const tool = h.factory(toolctx);
  let n = 0;
  return { h, ctx, hookctx, tool, async prepare(data = input, bind = true) {
    const toolCallId = `pf-${++n}`;
    if (bind) h.emit('before_tool_call', { toolName: 'glpi_ticket_preflight', toolCallId }, hookctx);
    return (await tool.execute(toolCallId, data)).details;
  }, send(details, overrides = {}, context = ctx) {
    h.emit('message_sent', { content: details.final_preview, success: true, messageId: 'm-preview', ...overrides }, context);
  }, confirm(content = '确认录入', sender = ctx.senderId, replyToId = 'm-preview') {
    h.emit('message_received', { content, messageId: `confirm-${++n}`, replyToId }, { ...ctx, senderId: sender });
  }, async snapshot() { return (await tool.execute(`snapshot-${++n}`, input)).details.flow_evidence; },
    query() {
      h.emit('after_tool_call', { toolName: 'glpi__glpi_list_entities', result: [{ id: 12 }] }, hookctx);
      h.emit('after_tool_call', { toolName: 'glpi__glpi_get_entity', params: { id: 12 }, result: { id: 12 } }, hookctx);
    }, create(details, params = {}) {
      const event = { toolName: 'glpi__glpi_create_ticket', toolCallId: `create-${++n}`, params: {
        name: input.title, content: details.create_content, entity_id: input.entity_id,
        priority: 3, category_id: input.category_id, user_id_assign: input.assignee_user_id, ...params,
      } };
      const before = structuredClone(event);
      assert.deepEqual(h.emit('before_tool_call', event, hookctx), [undefined]);
      assert.deepEqual(event, before);
      return h.logs.at(-1);
    } };
}

test('DEV-05 final preview -> initiating technician confirmation -> Shadow allow, no leader approval', async () => {
  const f = setup(); const d = await f.prepare(); f.query();
  f.send(d); f.confirm();
  assert.equal((await f.snapshot()).confirmed, true);
  assert.match(f.create(d), /decision=WOULD_ALLOW/);
});
test('DEV-05 missing requester/run/toolCall binding or message ID never records final preview', async () => {
  for (const kind of ['preflight', 'run', 'message', 'conflict', 'other-run']) {
    const f = setup(); const d = await f.prepare(input, kind !== 'preflight');
    const ctx = kind === 'run' ? { sessionKey: f.ctx.sessionKey } : kind === 'other-run' ? { ...f.ctx, runId: 'other' } : f.ctx;
    f.send(d, kind === 'message' ? { messageId: undefined } : kind === 'conflict' ? { runId: 'other' } : {}, ctx);
    f.confirm();
    assert.equal((await f.snapshot()).preview_sent, false);
    assert.equal((await f.snapshot()).confirmed, false);
  }
});
test('DEV-05 unsuccessful, incomplete or altered outbound content is not a final preview', async () => {
  for (const success of [false, undefined, 'true', 1]) {
    const f = setup(); const d = await f.prepare(); f.send(d, { success });
    assert.equal((await f.snapshot()).preview_sent, false);
  }
  for (const content of ['补齐发生时间', '已拟定', '默认=发起人', '待录入预览', '确认录入', '缺项']) {
    const f = setup(); const d = await f.prepare(); f.send(d, { content });
    assert.equal((await f.snapshot()).preview_sent, false);
  }
  const f = setup(); const d = await f.prepare();
  f.send(d, { content: d.final_preview.replace(input.method, 'altered method') });
  assert.equal((await f.snapshot()).preview_sent, false);
});
test('DEV-05 unrelated sender, unbound confirmation, quoted prose, wrong preview and stale token fail closed', async () => {
  for (const [text, sender, reply] of [['确认', 'other', 'm-preview'], ['确认', 'fixture-tech-a', undefined],
    ['确认', 'fixture-tech-a', 'old-message'], ['他说确认录入', 'fixture-tech-a', 'm-preview'],
    ['确认录入 0000000000000000', 'fixture-tech-a', 'm-preview']]) {
    const f = setup(); const d = await f.prepare(); f.send(d);
    f.h.emit('message_received', { content: text, messageId: 'confirm', replyToId: reply }, { ...f.ctx, senderId: sender });
    assert.equal((await f.snapshot()).confirmed, false);
  }
});
test('DEV-05 exact confirmation token binds draft without a reply-to message', async () => {
  const f = setup(); const d = await f.prepare(); f.send(d);
  const command = /确认录入 [a-f0-9]{16}/.exec(d.final_preview)[0];
  f.h.emit('message_received', { content: command, messageId: 'confirm-token' }, f.ctx);
  assert.equal((await f.snapshot()).confirmed, true);
});
test('DEV-05 every canonical field change invalidates old preview and confirmation; FAIL invalidates too', async () => {
  for (const key of Object.keys(input)) {
    const f = setup(); const before = await f.prepare(); f.send(before); f.confirm();
    const value = typeof input[key] === 'number' ? (key === 'target_status' ? 2 : input[key] + 1) : `${input[key]} changed`;
    const after = await f.prepare({ ...input, [key]: value });
    assert.equal(after.flow_evidence.preview_sent, false);
    assert.equal(after.flow_evidence.confirmed, false);
    f.send(before); f.confirm(/确认录入 [a-f0-9]{16}/.exec(before.final_preview)[0]);
    const unchanged = await f.prepare({ ...input, [key]: value });
    assert.equal(unchanged.flow_evidence.confirmed, false);
  }
  const f = setup(); const d = await f.prepare(); f.send(d); f.confirm();
  const failed = await f.prepare({ ...input, result: '' });
  assert.equal(failed.final_preview, null);
  assert.equal(failed.flow_evidence.confirmed, false);
});
test('DEV-05 structured fill-in and assignee overrides invalidate authorization until a new final preview', async () => {
  for (const content of ['1、发生时间修改 2、故障修改', '负责人：另一技术员，其他确认']) {
    const f = setup(); const d = await f.prepare(); f.send(d); f.confirm(content);
    const next = await f.prepare();
    assert.equal(next.flow_evidence.confirmed, false);
    assert.equal(next.flow_evidence.preview_sent, false);
  }
});
test('DEV-05 create body, missing fields, conflicting aliases and status cannot drift after confirmation', async () => {
  for (const params of [{ content: 'altered' }, { user_id_assign: undefined },
    { name: undefined }, { entities_id: 999 }, { title: 'other' }, { users_id_assign: 999 }]) {
    const f = setup(); const d = await f.prepare(); f.query(); f.send(d); f.confirm();
    assert.match(f.create(d, params), /decision=WOULD_BLOCK.*reason=CONTENT_MISMATCH/);
  }
  const f = setup(); const d = await f.prepare(); f.query(); f.send(d); f.confirm();
  assert.match(f.create(d, { status: 5 }), /CREATE_STATUS_UNSUPPORTED/);
});
test('DEV-05 trusted owner bit alone cannot bypass final preview or confirmation (boss exception BLOCKED)', async () => {
  const f = setup(); const d = await f.prepare(); f.query();
  assert.match(f.create(d), /PREVIEW_NOT_SENT/);
  f.send(d);
  assert.match(f.create(d), /CONFIRMATION_REQUIRED/);
});
test('DEV-03 missing sender cannot mutate any authorization evidence, even with one Flow', () => {
  const store = createFlowStore(); const flow = store.start('s', 'a').flow;
  const deps = { store, log: { info() {}, warn() {}, debug() {} } };
  assert.equal(handleEntityLookup(deps, { sessionKey: 's', result: [{ id: 12 }] }).recorded, false);
  assert.equal(handleEntityConfirm(deps, { sessionKey: 's', params: { id: 12 }, result: { id: 12 } }).recorded, false);
  assert.equal(recordPreflightEvidence(deps, { sessionKey: 's', result: { PREFLIGHT_STATUS: 'PASS', data: input } }).recorded, false);
  assert.equal(handleCreateCheck(deps, { sessionKey: 's', params: {} }).decisions[0].reason, 'NO_ACTIVE_TICKET_FLOW');
  flow.submissions.set('c', { allowed: true });
  assert.equal(handleCreateResult(deps, { sessionKey: 's', toolCallId: 'c', result: { id: 1 } }).completed, false);
  assert.equal(store.get('s', 'a'), flow);
});
test('privacy: identities, canonical content, confirmation token and error strings never enter logs', async () => {
  const f = setup(); const d = await f.prepare(); f.query(); f.send(d); f.confirm(); f.create(d);
  const logs = f.h.logs.join('\n');
  for (const value of [f.ctx.sessionKey, f.ctx.senderId, input.customer_name, input.symptom, input.method, input.result,
    /确认录入 ([a-f0-9]{16})/.exec(d.final_preview)[1]]) assert.equal(logs.includes(value), false);
  assert.match(maskId('malicious\nidentity'), /^sha256:[a-f0-9]{12}$/);
  assert.equal(resolveConfig({ mode: 'enforce' }).mode, 'shadow');
});

test('DEV-05 two technicians cannot deliver or confirm each other’s preview in a shared group', async () => {
  const h = hooksHarness(); const drafts = {}; const tools = {};
  for (const who of ['a', 'b']) {
    const ctx = { channelId: 'feishu', sessionKey: 'group', senderId: who, runId: `run-${who}` };
    h.emit('message_received', { content: '新增工单', messageId: `fixture-start-${who}` }, ctx);
    h.emit('before_prompt_build', {}, ctx);
    const toolCallId = `pf-${who}`;
    h.emit('before_tool_call', { toolName: 'glpi_ticket_preflight', toolCallId }, { ...ctx, requester: { senderId: who } });
    tools[who] = h.factory({ sessionKey: 'group', requesterSenderId: who });
    drafts[who] = (await tools[who].execute(toolCallId, input)).details;
  }
  h.emit('message_sent', { content: drafts.a.final_preview, success: true, messageId: 'p-a' }, { sessionKey: 'group', runId: 'run-b' });
  for (const who of ['a', 'b']) assert.equal((await tools[who].execute(`s-${who}`, input)).details.flow_evidence.preview_sent, false);
  h.emit('message_sent', { content: drafts.a.final_preview, success: true, messageId: 'p-a' }, { sessionKey: 'group', runId: 'run-a' });
  h.emit('message_received', { content: /确认录入 [a-f0-9]{16}/.exec(drafts.a.final_preview)[0], messageId: 'c-b', replyToId: 'p-a' }, { channelId: 'feishu', sessionKey: 'group', senderId: 'b' });
  assert.equal((await tools.a.execute('s-a2', input)).details.flow_evidence.confirmed, false);
});
