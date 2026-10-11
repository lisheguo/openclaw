import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowStore } from '../lib/state.js';
import { setDraft, renderTicketContent } from '../lib/draft.js';
import { evaluateCreate } from '../lib/gate.js';
import { runPreflight } from '../lib/preflight.js';
import { buildCreateParams } from '../lib/contract.js';
import { input } from './support/harness.js';

// Synthetic contract tests, not production acceptance. Contract comment
// #6060561318 and pinned MCP 3.2.0 source supersede the old P0 reproductions.
function localConfirmedFixture(targetStatus) {
  const flow = createFlowStore().start('review-fixture', 'fixture-tech').flow;
  const data = runPreflight({ ...input, target_status: targetStatus }).data;
  setDraft(flow, data, 'fixture-run');
  Object.assign(flow, { preflight_ok: true, preflight_data: data, entity_lookup_ok: true,
    narrow_entity_id: String(data.entity_id), preview_sent: true, preview_hash: flow.draft.hash,
    confirmed: true, confirmed_hash: flow.draft.hash, confirmed_by: flow.initiator_sender_id });
  const params = buildCreateParams(data);
  return { flow, data, params };
}

test('Review P0 contract: three-section content preserves occurrence time and business text', () => {
  const { flow, data, params } = localConfirmedFixture(2);
  const sample = `一、故障现象\n${data.symptom}\n二、故障处理方法\n${data.method}\n三、故障修复结果\n${data.result}`;
  assert.notEqual(params.content, sample);
  assert.equal(evaluateCreate(flow, { ...params, content: sample }).reason, 'CONTENT_MISMATCH');
  const complete = sample.replace(data.symptom, `发生时间：${data.occurred_at}\n${data.symptom}`);
  assert.equal(evaluateCreate(flow, { ...params, content: complete }).would_allow, true);
  assert.equal(complete, renderTicketContent(data).replaceAll('\n\n', '\n'));
});

test('Review P0 contract: all targets omit unsupported create status; creation is a separate stage', () => {
  for (const targetStatus of [2, 5, 6]) {
    const { flow, params } = localConfirmedFixture(targetStatus);
    assert.equal(Object.hasOwn(params, 'status'), false);
    assert.equal(evaluateCreate(flow, { ...params, status: 2 }).reason, 'CREATE_STATUS_UNSUPPORTED');
    assert.equal(evaluateCreate(flow, params).would_allow, true);
    assert.equal(flow.workflow.ticket_id, null);
  }
});
