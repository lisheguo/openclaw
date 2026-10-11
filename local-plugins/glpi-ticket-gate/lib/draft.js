import { CATEGORY_LABELS, PRIORITY_LABELS, CREATE_OPTION_KEYS, renderTicketContent } from "./contract.js";
export { renderTicketContent } from "./contract.js";
import { createHash, randomBytes } from 'node:crypto';

// Exact, deterministic representation; no model reconstruction or inferred fields.
export function draftHash(data) {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
export function renderFinalPreview(flow) {
  if (!flow?.draft || flow.preflight_ok !== true) return null;
  const d = flow.preflight_data;
  return `待录入工单最终预览\n标题：${d.title}\n客户：${d.customer_name}\n客户实体ID：${d.entity_id}\n分类：${CATEGORY_LABELS[d.category_id]}（${d.category_id}）\n优先级：${PRIORITY_LABELS[d.priority]}（${d.priority}）\n负责人ID：${d.assignee_user_id}\n目标状态：${d.target_status}\n创建选项：${JSON.stringify(Object.fromEntries(CREATE_OPTION_KEYS.filter(k => d[k] != null).map(k => [k, d[k]])))}\n\n${renderTicketContent(d)}\n请本人回复“确认录入 ${flow.draft.token}”或回复本消息“确认录入”。`;
}
export function invalidateDraft(flow) {
  flow.preview_sent = false;
  flow.preview_message_id = null;
  flow.preview_sent_at = null;
  flow.preview_hash = null;
  flow.confirmed = false;
  flow.confirmed_by = null;
  flow.confirmation_message_id = null;
  flow.confirmed_at = null;
  flow.confirmed_hash = null;
  flow.assignee_default_confirmed = false;
  flow.assignee_default_confirmed_at = null;
  flow.assignee_default = null;
  flow.assignee_override = null;
  flow.draft = null;
}
export function setDraft(flow, data, runId) {
  const hash = draftHash(data);
  if (flow.draft?.hash !== hash) {
    invalidateDraft(flow);
    flow.draft = { hash, token: randomBytes(8).toString('hex'), runId: null };
  }
  // Supplied only from a host-requester/run/toolCallId preflight binding.
  if (runId) flow.draft.runId = runId;
}
