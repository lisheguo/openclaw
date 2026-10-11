import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowStore } from '../lib/state.js';
import { runPreflight } from '../lib/preflight.js';
import { draftHash, renderFinalPreview } from '../lib/draft.js';
import { buildCreateParams, CREATE_OPTION_KEYS, normalizeLines, renderSolutionContent, solutionContentMatches, renderTicketContent, ticketContentMatches, unwrapResult } from '../lib/contract.js';
import { handleInbound, handlePreflightCall, recordPreflightEvidence, handleSent, handleEntityLookup, handleEntityConfirm } from '../lib/handlers.js';
import { handleWorkflowCheck, handleWorkflowResult, workflowEvidence } from '../lib/workflow.js';
import { hooksHarness, input } from './support/harness.js';
import { createPreflightTool } from '../lib/tool.js';
import { parsePriorityDirective } from '../lib/detect.js';

// Entirely synthetic fixtures. No GLPI service, installed MCP, credentials or
// external Skill is accessed. Result envelopes mirror pinned MCP 3.2.0 source.
const envelope = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
function fixture(target = 5, overrides = {}) {
  let now = 1; let seq = 0;
  const logs = []; const store = createFlowStore(10000, () => now);
  const deps = { store, log: { info: s => logs.push(s), warn: s => logs.push(s), debug: s => logs.push(s) } };
  const identity = { channelId: 'feishu', sessionKey: 'fixture-session', senderId: 'fixture-technician', runId: 'fixture-run' };
  const original = { ...input, target_status: target, ...overrides };
  handleInbound(deps, { ...identity, messageId: 'start', text: '新增工单' });
  const flow = store.get(identity.sessionKey, identity.senderId);
  const prepare = (data = original) => {
    const toolCallId = `pf-${++seq}`; const result = runPreflight(data);
    handlePreflightCall(deps, { ...identity, toolCallId });
    recordPreflightEvidence(deps, { ...identity, toolCallId, result });
    return result;
  };
  prepare();
  handleEntityLookup(deps, { ...identity, result: [{ id: input.entity_id }] });
  handleEntityConfirm(deps, { ...identity, params: { id: input.entity_id }, result: { id: input.entity_id } });
  const confirm = () => {
    assert.equal(handleSent(deps, { ...identity, messageId: 'preview', success: true, content: renderFinalPreview(flow) }).previewRecorded, true);
    assert.equal(handleInbound(deps, { ...identity, messageId: `fixture-confirm-${++seq}`, replyToId: 'preview', text: '确认录入' }).decision, 'CONFIRMED');
  };
  confirm();
  const check = (kind, params, overrides = {}) => {
    const call = { ...identity, kind, params, toolCallId: `call-${++seq}`, ...overrides };
    return { call, decision: handleWorkflowCheck(deps, call).decisions[0] };
  };
  const done = (attempt, result, overrides = {}) => handleWorkflowResult(deps, { ...attempt.call, result: envelope(result), ...overrides });
  const perform = (kind, params, result) => {
    const attempt = check(kind, params);
    assert.equal(attempt.decision.would_allow, true, `${kind}: ${attempt.decision.reason}`);
    return done(attempt, result);
  };
  const create = (id = 101) => perform('create', buildCreateParams(flow.preflight_data), { success: true, id });
  const solution = () => perform('solution', { ticket_id: 101, content: renderSolutionContent(original) }, { success: true, solution_id: 202 });
  const ticket = (status, changes = {}) => ({ id: 101, status, name: original.title, entities_id: original.entity_id,
    priority: original.priority ?? 3, itilcategories_id: original.category_id,
    content: renderTicketContent(runPreflight(original).data), counts: { solutions: flow.workflow.solution_id ? 1 : 0 }, ...changes });
  const read = (status, changes = {}) => perform('read', { id: 101 }, ticket(status, changes));
  const update = status => perform('update', { id: 101, status }, { success: true, id: 101 });
  return { deps, store, flow, identity, logs, prepare, confirm, check, done, perform, create, solution, ticket, read, update,
    tick: delta => { now += delta; } };
}

test('Contract body: exactly three sections, occurrence and device/location preserved, benign presentation changes accepted', () => {
  const data = runPreflight({ ...input, symptom: 'Room A\nRouter B unavailable' }).data;
  const body = renderTicketContent(data);
  assert.match(body, /^一、故障现象\n发生时间：/);
  for (const text of [body, body.replaceAll('\n', '\r\n'), body.split('\n').map(s => `  ${s}  `).join('\n\n'),
    body.replace('一、故障现象', '## 一、故障现象：').replace('二、故障处理方法', '# 二、故障处理方法:'),
    body.replace('发生时间：', `客户：${data.customer_name}\n发生时间：`)]) {
    assert.equal(ticketContentMatches(text, data), true);
  }
  for (const text of [body.replace(data.occurred_at, 'other time'), body.replace('Router B', 'Router C'),
    body.replace(data.method, 'different method'), body.replace(data.result, 'different result'),
    body.replace('发生时间：', '客户：different customer\n发生时间：'), `preamble\n${body}`,
    body.replace('二、故障处理方法', '三、故障修复结果'), `${body}\n一、故障现象`, `<p>${body}</p>`, '', null]) {
    assert.equal(ticketContentMatches(text, data), false);
  }
});

test('Reviewed Skill: solution requires both confirmed method and result, preserves business punctuation', () => {
  const data = { ...input, method: 'Set value="a-b"\nRestart service', result: 'Response: OK, no packet loss' };
  const canonical = renderSolutionContent(data);
  for (const content of [canonical, canonical.replaceAll('\n', '\r\n'),
    canonical.replace('二、故障处理方法', '## 二、故障处理方法：').replace('三、故障修复结果', '### 三、故障修复结果:')]) {
    assert.equal(solutionContentMatches(content, data), true);
  }
  for (const content of [data.result, data.method, '', '二、故障处理方法\n\n三、故障修复结果',
    canonical.replace('a-b', 'ab'), canonical.replace('no packet loss', 'packet loss'),
    canonical.replace(data.method, ''), canonical.replace(data.result, ''),
    canonical.replace('二、故障处理方法', '三、故障修复结果'), `${canonical}\nextra facts`, `<p>${canonical}</p>`]) {
    assert.equal(solutionContentMatches(content, data), false);
  }
});

for (const target of [5, 6]) test(`Reviewed Skill target ${target}: result-only solution denied; method+result accepts and binds call`, async () => {
  const f = fixture(target); f.create();
  const params = { ticket_id: 101, content: input.result };
  const denied = f.check('solution', params);
  assert.equal(denied.decision.reason, 'SOLUTION_CONTENT_MISMATCH');
  assert.equal(f.done(denied, { success: true, solution_id: 999 }).recorded, false);
  assert.equal(f.flow.workflow.solution_id, null);
  assert.equal(f.check('update', { id: 101, status: 5 }).decision.reason, 'SOLUTION_REQUIRED');
  const tool = createPreflightTool(f.deps, { sessionKey: f.identity.sessionKey, requesterSenderId: f.identity.senderId });
  const preflight = await tool.execute('solution-preview', { ...input, target_status: target });
  const details = preflight.details;
  assert.equal(details.solution_content, renderSolutionContent(f.flow.preflight_data));
  assert.ok(details.final_preview.includes(details.solution_content));
  assert.ok(preflight.content[0].text.includes(details.solution_content));
  assert.equal(details.flow_evidence.next_step, 'ADD_CONFIRMED_METHOD_AND_RESULT_AS_SOLUTION_THEN_READ_BACK');
  const call = f.check('solution', { ...params, content: details.solution_content });
  assert.equal(call.decision.would_allow, true);
  assert.equal(f.done(call, { success: true, solution_id: 202 }, { params }).recorded, false);
  assert.equal(f.done(call, { success: true, solution_id: 202 }).completed, false);
  assert.equal(f.flow.workflow.solution_id, '202');
});

test('Reviewed Skill: category must be derived and bound; missing or out-of-rule category/priority fails preflight', async () => {
  for (const category_id of [undefined, null, 0, 9, 1.5, 'unknown']) {
    const p = runPreflight({ ...input, category_id });
    assert.equal(p.PREFLIGHT_STATUS, 'FAIL'); assert.ok(p.MISSING_FIELDS.includes('category_id'));
  }
  for (const priority of [0, 6, 10, -1, 1.5, 'urgent']) {
    const p = runPreflight({ ...input, priority });
    assert.equal(p.PREFLIGHT_STATUS, 'FAIL'); assert.ok(p.MISSING_FIELDS.includes('priority'));
  }
  for (const category_id of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const f = fixture(5, { category_id });
    assert.equal(f.flow.preflight_ok, true);
    assert.equal(buildCreateParams(f.flow.preflight_data).category_id, category_id);
    assert.match(renderFinalPreview(f.flow), new RegExp(`分类：.+（${category_id}）`));
  }
  const f = fixture(2);
  const d = (await createPreflightTool(f.deps, { sessionKey: f.identity.sessionKey, requesterSenderId: f.identity.senderId }).execute('snapshot', { ...input, target_status: 2 })).details;
  assert.equal(d.solution_content, null); assert.equal(d.data.priority, 3);
  assert.equal(d.create_params.time_to_resolve, undefined);
  assert.equal(d.create_params.occurred_at, undefined);
  assert.equal(d.create_params.source_channel, undefined);
  assert.match(d.create_content, new RegExp(input.occurred_at));
});

test('Reviewed Skill: priority directive parser is narrow and never infers authorization from prose', () => {
  for (const [text, priority] of [['优先级：极低', 1], ['优先级=低', 2], ['优先级设置为中', 3], ['优先级设为高', 4],
    ['新增工单，优先级：紧急', 5], ['优先级：4。', 4]]) assert.equal(parsePriorityDirective(text), priority);
  for (const text of ['不要优先级：高', '优先级：高吗？', '他说“优先级：高”', '故障描述：优先级：高', '优先级：6',
    '请按紧急问题分析', '严重故障', '优先级：高，其他随便', '不新增工单，优先级：高', '', null]) {
    assert.equal(parsePriorityDirective(text), null);
  }
});

test('Reviewed Skill: non-default priority requires initiating sender/message evidence plus new preview confirmation', () => {
  for (const priority of [1, 2, 4, 5]) {
    const f = fixture(5, { priority });
    const params = buildCreateParams(f.flow.preflight_data);
    assert.equal(f.check('create', params).decision.reason, 'PRIORITY_OVERRIDE_EVIDENCE_REQUIRED');
    const result = handleInbound(f.deps, { ...f.identity, messageId: 'priority-message', text: `优先级：${priority}` });
    assert.equal(result.flow.confirmed, false); assert.equal(result.flow.preflight_ok, false);
    f.prepare({ ...input, priority });
    assert.equal(f.check('create', params).decision.reason, 'PREVIEW_NOT_SENT');
    f.confirm(); assert.equal(f.check('create', params).decision.would_allow, true);
    assert.equal(f.logs.join('\n').includes('priority-message'), false);
  }
});

test('Reviewed Skill: another sender, unbound/quoted directive or model param cannot authorize a priority override', () => {
  for (const patch of [{ senderId: 'other' }, { messageId: undefined }, { text: '他说优先级：高' }]) {
    const f = fixture(5, { priority: 4 });
    handleInbound(f.deps, { ...f.identity, messageId: 'priority', text: '优先级：高', ...patch });
    f.prepare({ ...input, priority: 4 }); f.confirm();
    assert.equal(f.flow.priority_instruction, null);
    assert.equal(f.check('create', buildCreateParams(f.flow.preflight_data)).decision.reason, 'PRIORITY_OVERRIDE_EVIDENCE_REQUIRED');
  }
  const f = fixture();
  handleInbound(f.deps, { ...f.identity, messageId: 'priority', text: '优先级：高' });
  f.prepare(input); f.confirm();
  assert.equal(f.check('create', buildCreateParams(f.flow.preflight_data)).decision.reason, 'PRIORITY_OVERRIDE_EVIDENCE_REQUIRED', 'default cannot override explicit high');
});

test('Reviewed Skill: priority directive survives confirmation but new substantive input revokes its evidence', () => {
  const f = fixture(5, { priority: 4 });
  handleInbound(f.deps, { ...f.identity, messageId: 'priority', text: '优先级：高' });
  f.prepare({ ...input, priority: 4 }); f.confirm(); f.create();
  handleInbound(f.deps, { ...f.identity, messageId: 'edit', text: '更改处理方法' });
  assert.equal(f.flow.priority_instruction, null);
  f.prepare({ ...input, priority: 4 }); f.confirm();
  assert.equal(f.check('solution', { ticket_id: 101, content: renderSolutionContent(input) }).decision.reason, 'DRAFT_CHANGED_AFTER_CREATE');
});

test('Reviewed Skill: explicit priority in initial creation command binds only that Flow', () => {
  const store = createFlowStore(); const deps = { store, log: { info() {}, warn() {}, debug() {} } };
  const r = handleInbound(deps, { channelId: 'feishu', sessionKey: 's', senderId: 'a', messageId: 'start', text: '新增工单，优先级：紧急' });
  assert.equal(r.decision, 'FLOW_STARTED'); assert.deepEqual(r.flow.priority_instruction, { value: 5, message_id: 'start' });
  const other = handleInbound(deps, { channelId: 'feishu', sessionKey: 's', senderId: 'b', messageId: 'other', text: '新增工单' });
  assert.equal(other.flow.priority_instruction, null);
});

test('Contract create schema: no status, exact option binding, only verified MCP defaults may be omitted', () => {
  const f = fixture(5, { category_id: 4, group_id_assign: 9, requester_user_id: 6, requester_group_id: 11,
    impact: 2, time_to_resolve: '2026-10-09 10:00' });
  const p = buildCreateParams(f.flow.preflight_data);
  assert.equal(Object.hasOwn(p, 'status'), false); assert.equal(p.priority, 3);
  for (const key of ['name', 'content', 'entity_id', 'user_id_assign', ...CREATE_OPTION_KEYS]) {
    if (!Object.hasOwn(p, key)) continue;
    const changed = { ...p, [key]: typeof p[key] === 'number' ? p[key] + 1 : `${p[key]} altered` };
    assert.equal(f.check('create', changed).decision.would_block, true, key);
  }
  for (const status of [2, 5, 6, undefined]) assert.equal(f.check('create', { ...p, status }).decision.reason, 'CREATE_STATUS_UNSUPPORTED');
  for (const other of [{ ...p, priority: undefined }, { ...p, target_status: 5 }, { ...p, itilcategories_id: 4 }, { ...p, title: p.name }]) {
    assert.equal(f.check('create', other).decision.would_block, true);
  }
  delete p.urgency; delete p.type;
  assert.equal(f.check('create', p).decision.would_allow, true);
});

test('Contract options are previewed and hashed; changed option requires a new self-confirmation', () => {
  for (const key of CREATE_OPTION_KEYS) {
    const f = fixture(); const oldHash = f.flow.draft.hash;
    const value = key === 'time_to_resolve' ? '2026-10-10 09:00' : key === 'type' ? 2 : 4;
    f.prepare({ ...input, [key]: value });
    assert.notEqual(f.flow.draft.hash, oldHash, key);
    assert.equal(f.flow.confirmed, false); assert.equal(f.flow.preview_sent, false);
    assert.ok(renderFinalPreview(f.flow).includes(JSON.stringify(key)));
    assert.equal(f.check('create', buildCreateParams(f.flow.preflight_data)).decision.would_block, true);
  }
  for (const patch of [{ type: 3 }, { priority: 0 }, { category_id: -1 }, { impact: {} }, { time_to_resolve: '待补' }]) {
    assert.equal(runPreflight({ ...input, ...patch }).PREFLIGHT_STATUS, 'FAIL');
  }
});

test('Workflow target 2: create receipt binds ID; explicit update and fresh readback complete', () => {
  const f = fixture(2); assert.equal(f.create().completed, false);
  assert.equal(f.flow.workflow.ticket_id, '101'); assert.equal(f.flow.workflow.last_status, null);
  assert.equal(f.check('create', buildCreateParams(f.flow.preflight_data)).decision.reason, 'TICKET_ALREADY_CREATED');
  assert.equal(f.check('solution', { ticket_id: 101, content: input.result }).decision.reason, 'SOLUTION_NOT_REQUIRED');
  assert.equal(f.read(2).completed, false, 'initial status 2 is not an explicit update');
  assert.equal(f.update(2).completed, false);
  assert.equal(f.read(1).completed, false);
  assert.equal(workflowEvidence(f.flow).next_step, 'REQUEST_STATUS_2_THEN_READ_BACK');
  f.update(2); assert.equal(f.read(2).completed, true);
  assert.equal(f.store.get(f.identity.sessionKey, f.identity.senderId), undefined);
});

test('Workflow preflight feedback exposes pending/unknown/created stages and never offers duplicate create params', async () => {
  const f = fixture();
  const tool = createPreflightTool(f.deps, { sessionKey: f.identity.sessionKey, requesterSenderId: f.identity.senderId });
  const call = f.check('create', buildCreateParams(f.flow.preflight_data));
  const pending = await tool.execute('snapshot-1', input);
  assert.equal(pending.details.create_params, null);
  assert.equal(pending.details.flow_evidence.next_step, 'WAIT_FOR_CORRELATED_RESULT');
  f.done(call, { success: true, id: 101 });
  const created = await tool.execute('snapshot-2', input);
  assert.equal(created.details.create_params, null); assert.match(created.content[0].text, /工单ID=101/);
  assert.match(created.content[0].text, /迁移规则=UNKNOWN/);
  const u = fixture(); const unknown = u.check('create', buildCreateParams(u.flow.preflight_data)); u.done(unknown, null);
  const result = await createPreflightTool(u.deps, { sessionKey: u.identity.sessionKey, requesterSenderId: u.identity.senderId }).execute('snapshot', input);
  assert.equal(result.details.create_params, null);
  assert.equal(result.details.flow_evidence.next_step, 'BLOCKED_RECONCILE_CREATE_OUTCOME_DO_NOT_RECREATE');
});

test('Workflow target 5: solution receipt never implies automatic 5; observed auto-solve completes', () => {
  const f = fixture(); f.create(); assert.equal(f.solution().completed, false);
  assert.equal(f.flow.workflow.last_status, null);
  assert.equal(workflowEvidence(f.flow).transition_runtime_verified, false);
  assert.equal(f.read(5).completed, true);
});

test('Workflow target 5: non-auto-solve path observes actual state before candidate update, then reads 5', () => {
  const f = fixture(); f.create(); f.solution();
  assert.equal(f.check('update', { id: 101, status: 5 }).decision.reason, 'STATUS_STAGE_NOT_OBSERVED');
  assert.equal(f.read(3).completed, false);
  assert.equal(f.update(5).completed, false);
  assert.equal(f.read(5).completed, true);
});

test('Workflow target 6: must record solution, observe 5, request 6 and read 6', () => {
  const f = fixture(6); f.create();
  assert.equal(f.check('update', { id: 101, status: 6 }).decision.reason, 'SOLUTION_REQUIRED');
  f.solution();
  assert.equal(f.read(6).completed, false, 'no observed resolved stage or close request');
  assert.equal(f.check('update', { id: 101, status: 6 }).decision.reason, 'STATUS_STAGE_NOT_OBSERVED');
  assert.equal(f.read(2).completed, false); f.update(5);
  assert.equal(f.read(5).completed, false); assert.equal(f.flow.workflow.observed_resolved, true);
  assert.equal(f.update(6).completed, false); assert.equal(f.read(6).completed, true);
});

for (const result of [null, { id: 101 }, { success: false, id: 101 }, { success: true, id: 0 },
  { success: 'true', id: 101 }, { success: true, solution_id: 101 }, { success: true, id: Number.MAX_SAFE_INTEGER + 1 }]) {
  test(`Workflow ambiguous create receipt ${JSON.stringify(result)} preserves Flow and denies recreate`, () => {
    const f = fixture(); const a = f.check('create', buildCreateParams(f.flow.preflight_data));
    assert.equal(f.done(a, result).completed, false);
    assert.equal(f.flow.workflow.phase, 'CREATE_OUTCOME_UNKNOWN');
    assert.equal(f.check('create', a.call.params).decision.reason, 'CREATE_OUTCOME_UNKNOWN');
    assert.equal(f.done(a, { success: true, id: 101 }).recorded, false, 'duplicate after cannot reinterpret consumed outcome');
  });
}

test('Workflow errors: unknown create/solution cannot auto-retry; failed close resumes by same-ID read/update', () => {
  const a = fixture(); const create = a.check('create', buildCreateParams(a.flow.preflight_data));
  a.done(create, { success: true, id: 101 }, { error: 'sensitive network error' });
  assert.equal(a.flow.workflow.phase, 'CREATE_OUTCOME_UNKNOWN');
  const b = fixture(); b.create(); const sol = b.check('solution', { ticket_id: 101, content: renderSolutionContent(input) });
  b.done(sol, { success: true, solution_id: 202 }, { error: 'timeout' });
  assert.equal(b.read(5, { counts: { solutions: 1 } }).completed, false);
  assert.equal(b.check('solution', sol.call.params).decision.reason, 'SOLUTION_OUTCOME_UNKNOWN');
  const c = fixture(6); c.create(); c.solution(); c.read(5);
  const close = c.check('update', { id: 101, status: 6 }); c.done(close, null, { error: 'timeout' });
  assert.equal(c.check('update', close.call.params).decision.reason, 'STATUS_STAGE_NOT_OBSERVED');
  assert.equal(c.read(5).completed, false); assert.equal(c.flow.workflow.ticket_id, '101');
  c.update(6); assert.equal(c.read(6).completed, true);
  const d = fixture(2); d.create(); const update = d.check('update', { id: 101, status: 2 }); d.done(update, null, { error: 'lost ack' });
  assert.equal(d.read(2).completed, true, 'fresh read proves state despite lost ack');
});

test('Workflow all callbacks require exact sender/session/run/call/params/kind and are consumed once', () => {
  const f = fixture(); const a = f.check('create', buildCreateParams(f.flow.preflight_data));
  for (const patch of [{ senderId: 'other' }, { senderId: undefined }, { sessionKey: 'other' }, { runId: 'other' },
    { runId: undefined }, { toolCallId: 'other' }, { params: { ...a.call.params, name: 'altered' } }, { kind: 'update' }]) {
    assert.equal(f.done(a, { success: true, id: 101 }, patch).recorded, false);
    assert.equal(f.flow.workflow.ticket_id, null);
  }
  assert.equal(f.done(a, { success: true, id: 101 }).created, true);
  assert.equal(f.done(a, { success: true, id: 999 }).recorded, false);
  assert.equal(f.flow.workflow.ticket_id, '101');
  assert.equal(handleWorkflowCheck(f.deps, a.call).decisions[0].reason, 'CALL_ALREADY_SEEN');
});

test('Workflow missing correlation, wrong ticket IDs and unsupported continuation args fail closed', () => {
  const f = fixture(); const p = buildCreateParams(f.flow.preflight_data);
  for (const patch of [{ runId: undefined }, { toolCallId: undefined }, { runId: '' }]) {
    assert.equal(f.check('create', p, patch).decision.reason, 'NO_CALL_CORRELATION');
  }
  f.create();
  for (const [kind, params] of [['solution', { ticket_id: 999, content: input.result }], ['update', { id: 999, status: 5 }], ['read', { id: 999 }],
    ['solution', { ticket_id: 101, content: 'changed' }], ['solution', { ticket_id: 101, content: input.result, solutiontypes_id: 4 }],
    ['read', { id: 101, with_logs: 'yes' }], ['read', { id: 101, extra: true }], ['update', { id: 101, status: 5, name: 'changed' }]]) {
    assert.equal(f.check(kind, params).decision.would_block, true, kind);
  }
  f.solution(); assert.equal(f.check('solution', { ticket_id: 101, content: input.result }).decision.reason, 'SOLUTION_ALREADY_RECORDED');
});

for (const [label, patch] of [['wrong id', { id: 999 }], ['missing body', { content: undefined }], ['changed body', { content: 'different' }],
  ['wrong entity', { entities_id: 999 }], ['wrong title', { name: 'changed' }], ['status string', { status: '5' }],
  ['missing status', { status: undefined }], ['invalid status', { status: 9 }], ['missing counts', { counts: undefined }],
  ['changed priority', { priority: 5 }], ['missing priority', { priority: undefined }],
  ['changed category', { itilcategories_id: 1 }], ['missing category', { itilcategories_id: undefined }],
  ['negative count', { counts: { solutions: -1 } }], ['string count', { counts: { solutions: '1' } }], ['failed result', { success: false }]]) {
  test(`Workflow readback ${label} does not complete or leave stale status evidence`, () => {
    const f = fixture(6); f.create(); f.solution(); f.read(5);
    assert.equal(f.read(6, patch).completed, false);
    assert.equal(f.flow.workflow.last_status, null);
    assert.equal(f.flow.workflow.phase, 'READBACK_INVALID_OR_CONTENT_MISMATCH');
  });
}

test('Workflow solution count alone or solution receipt without a visible solution cannot complete', () => {
  const a = fixture(); a.create(); assert.equal(a.read(5, { counts: { solutions: 2 } }).completed, false);
  const b = fixture(); b.create(); b.solution(); assert.equal(b.read(5, { counts: { solutions: 0 } }).completed, false);
});

test('Workflow changed/revoked draft or entity evidence cannot authorize continuation or completion', () => {
  for (const mutate of [f => { f.flow.confirmed = false; }, f => { f.flow.preview_sent = false; },
    f => { f.flow.entity_lookup_ok = false; }, f => { f.flow.narrow_entity_id = '999'; },
    f => { f.flow.preflight_data = { ...f.flow.preflight_data, method: 'tampered' }; }, f => f.prepare({ ...input, target_status: 2, method: 'changed' })]) {
    const f = fixture(2); f.create(); f.update(2); mutate(f);
    assert.equal(f.read(2).completed, false);
    assert.equal(f.check('update', { id: 101, status: 2 }).decision.reason, 'DRAFT_CHANGED_AFTER_CREATE');
    assert.equal(f.check('create', buildCreateParams(f.flow.preflight_data)).decision.reason, 'TICKET_ALREADY_CREATED');
  }
  const f = fixture(); const a = f.check('create', buildCreateParams(f.flow.preflight_data));
  const originalHash = f.flow.draft.hash; f.prepare({ ...input, result: 'new result' }); f.confirm();
  f.done(a, { success: true, id: 101 });
  assert.equal(f.flow.workflow.draft_hash, originalHash);
  assert.notEqual(draftHash(f.flow.preflight_data), originalHash);
  assert.equal(f.check('solution', { ticket_id: 101, content: 'new result' }).decision.reason, 'DRAFT_CHANGED_AFTER_CREATE');
});

test('Workflow stale result after TTL/replacement and stale complete cannot mutate replacement Flow', () => {
  const f = fixture(); const a = f.check('create', buildCreateParams(f.flow.preflight_data));
  f.tick(10001); const replacement = f.store.start(f.identity.sessionKey, f.identity.senderId).flow;
  assert.equal(f.done(a, { success: true, id: 101 }).recorded, false);
  f.store.complete(f.flow);
  assert.equal(f.store.get(f.identity.sessionKey, f.identity.senderId), replacement);
  assert.equal(replacement.workflow.ticket_id, null);
});

test('Workflow strict MCP envelope parser rejects truncated, multi-record and error payloads', () => {
  for (const value of ['{"id":101', [{ id: 101 }], { isError: true, ...envelope({ id: 101 }) },
    { content: [] }, { content: [{ type: 'image', text: '{}' }] }, { content: [...envelope({ id: 101 }).content, ...envelope({ id: 999 }).content] },
    Array.from({ length: 8 }).reduce(value => JSON.stringify(value), '{}')]) {
    assert.equal(unwrapResult(value), null);
  }
  assert.deepEqual(unwrapResult(envelope({ success: true, id: 101 })), { success: true, id: 101 });
  assert.equal(normalizeLines(123), null);
});

for (const target of [2, 5, 6]) test(`Registered Shadow hooks: target ${target}, actual API args, no tool/event mutation`, async () => {
  const h = hooksHarness(); const data = { ...input, target_status: target };
  const ctx = { channelId: 'feishu', sessionKey: 'registered-session', senderId: 'registered-tech', runId: 'registered-run', trigger: 'user' };
  const hookctx = { ...ctx, requester: { senderId: ctx.senderId } };
  h.emit('message_received', { content: '新增工单', messageId: 'start' }, ctx);
  h.emit('before_prompt_build', {}, ctx);
  const tool = h.factory({ sessionKey: ctx.sessionKey, requesterSenderId: ctx.senderId });
  h.emit('before_tool_call', { toolName: 'glpi_ticket_preflight', toolCallId: 'pf' }, hookctx);
  const initial = (await tool.execute('pf', data)).details;
  h.emit('after_tool_call', { toolName: 'glpi__glpi_list_entities', result: [{ id: 12 }] }, hookctx);
  h.emit('after_tool_call', { toolName: 'glpi__glpi_get_entity', params: { id: 12 }, result: { id: 12 } }, hookctx);
  h.emit('message_sent', { content: initial.final_preview, success: true, messageId: 'preview' }, ctx);
  h.emit('message_received', { content: '确认录入', messageId: 'confirm', replyToId: 'preview' }, ctx);
  let seq = 0;
  const call = (name, params, result, allow = true) => {
    const event = { toolName: `glpi__glpi_${name}`, toolCallId: `op-${++seq}`, params }; const before = structuredClone(event);
    assert.deepEqual(h.emit('before_tool_call', event, hookctx), [undefined]); assert.deepEqual(event, before);
    assert.match(h.logs.at(-1), allow ? /decision=WOULD_ALLOW/ : /decision=WOULD_BLOCK/);
    const after = { ...event, result: envelope(result) }; const saved = structuredClone(after);
    assert.deepEqual(h.emit('after_tool_call', after, hookctx), [undefined]); assert.deepEqual(after, saved);
  };
  assert.equal(Object.hasOwn(initial.create_params, 'status'), false);
  call('create_ticket', initial.create_params, { success: true, id: 101 });
  const active = (await tool.execute('snapshot', data)).details;
  assert.equal(active.create_params, null); assert.equal(active.flow_evidence.workflow.ticket_id, '101');
  call('create_ticket', initial.create_params, { success: true, id: 999 }, false);
  if (target === 2) call('update_ticket', { id: 101, status: 2 }, { success: true, id: 101 });
  else {
    call('add_solution', { ticket_id: 101, content: data.result }, { success: true, solution_id: 999 }, false);
    call('add_solution', { ticket_id: 101, content: initial.solution_content }, { success: true, solution_id: 202 });
  }
  const ticket = status => ({ id: 101, status, name: data.title, content: initial.create_content, entities_id: 12,
    priority: data.priority ?? 3, itilcategories_id: data.category_id, counts: { solutions: target === 2 ? 0 : 1 } });
  if (target === 6) {
    call('get_ticket', { id: 101 }, ticket(5));
    call('update_ticket', { id: 101, status: 6 }, { success: true, id: 101 });
  }
  call('get_ticket', { id: 101 }, ticket(target));
  assert.equal(h.factory({ sessionKey: ctx.sessionKey, requesterSenderId: ctx.senderId }), null);
  for (const secret of [ctx.sessionKey, ctx.senderId, data.customer_name, data.method, data.result]) assert.equal(h.logs.join('\n').includes(secret), false);
});

test('Workflow asynchronous pending operations serialize; late duplicate/cross-sender callbacks cannot complete', async t => {
  await Promise.all(Array.from({ length: 24 }, (_, i) => t.test(`workflow-schedule-${i + 1}`, async () => {
    const f = fixture(2); const a = f.check('create', buildCreateParams(f.flow.preflight_data));
    await new Promise(resolve => i % 2 ? setImmediate(resolve) : queueMicrotask(resolve));
    assert.equal(f.check('create', a.call.params).decision.reason, 'CREATE_IN_PROGRESS');
    assert.equal(f.done(a, { success: true, id: 999 }, { senderId: 'other' }).recorded, false);
    assert.equal(f.done(a, { success: true, id: 101 }).completed, false);
    const update = f.check('update', { id: 101, status: 2 });
    assert.equal(f.check('read', { id: 101 }).decision.reason, 'OPERATION_IN_PROGRESS');
    await new Promise(resolve => i % 2 ? queueMicrotask(resolve) : setImmediate(resolve));
    f.done(update, { success: true, id: 101 });
    assert.equal(f.done(a, { success: true, id: 999 }).recorded, false);
    assert.equal(f.read(2).completed, true);
  })));
});
