import { handleWorkflowCheck, handleWorkflowResult } from "./workflow.js";
export { handleWorkflowCheck, handleWorkflowResult } from "./workflow.js";
import { invalidateDraft, renderFinalPreview, setDraft } from "./draft.js";
import {
  isTicketIntent,
  isConfirmation,
  isPreviewText,
  parseAssigneeNameRef,
  parsePriorityDirective,
} from "./detect.js";
import {
  extractEntityIds,
  describeResultShape,
  analyzeEntityExtraction,
  extractSingleEntityId,
} from "./gate.js";
import { maskId } from "./log.js";
import { reportReplayCapacity } from "./replay-metrics.js";

/**
 * Hook 处理逻辑（纯逻辑，便于单元测试驱动与 HOOK-01…HOOK-05 一致的行为）。
 * deps = { cfg, log, store, readSkill }
 * 日志遵循第十四节：前缀由 createLog 统一加，正文不落敏感信息，sessionKey/senderId 脱敏。
 */

// Only host-trusted, explicit (session, sender) identity may authorize evidence.
// A unique active flow, display name or model-supplied ID proves no ownership.
function resolveFlow(store, sessionKey, senderId) {
  if (typeof sessionKey !== "string" || !sessionKey.trim() ||
      typeof senderId !== "string" || !senderId.trim()) return null;
  return store.get(sessionKey, senderId) ?? null;
}

// HOOK-01 message_received：工单意图识别、flow 建立/拒绝、真实确认识别
export function handleInbound(deps, input) {
  // All inbound mutations, including confirmation, use one synchronous receipt
  // gate. Duplicate/conflict/missing-ID paths return before even reading Flow.
  let result;
  try { result = deps.store.inboundReplay.run(input, snapshot => applyInbound(deps, snapshot)); }
  finally { reportReplayCapacity(deps.store.inboundReplay, deps.log); }
  if (["DUPLICATE_IGNORED", "MESSAGE_ID_CONFLICT", "CAPACITY_BLOCKED", "NO_IDENTITY",
    "MISSING_MESSAGE_ID", "INVALID_SCOPE", "INVALID_MESSAGE_LINK", "FLOW_SCOPE_CONFLICT", "GENERATION_CLOSED"].includes(result.decision)) {
    deps.log.warn(`mode=shadow event=message_received decision=${result.decision}`);
  }
  return result;
}

function applyInbound(deps, { sessionKey, senderId, messageId, replyToId, text }) {
  const { log, store } = deps;
  if (typeof sessionKey !== "string" || !sessionKey || typeof senderId !== "string" || !senderId) {
    log.warn(
      `mode=shadow event=message_received decision=SKIP reason=NO_IDENTITY session=${maskId(sessionKey)} sender=${maskId(senderId)}`,
    );
    return { decision: "SKIP" };
  }
  const content = typeof text === "string" ? text : "";
  if (!content.trim()) return { decision: "NONE" };

  const flow = store.get(sessionKey, senderId);

  // Only the initiator can confirm their exact current final preview. Configured
  // owner IDs never authorize another person's flow or bypass content evidence.
  const tokenMatch = /^确认录入\s+([a-f0-9]{16})[。！!]?$/u.exec(content.trim());
  if (isConfirmation(content) || tokenMatch) {
    if (!flow) return { decision: "CONFIRM_IGNORED_NOT_AUTHORIZED" };
    if (!flow.preview_sent || !flow.draft || flow.preflight_ok !== true) {
      return { decision: "CONFIRM_IGNORED_PREVIEW_NOT_SENT", flow };
    }
    const bound = tokenMatch
      ? tokenMatch[1] === flow.draft.token
      : typeof replyToId === "string" && replyToId === flow.preview_message_id;
    if (!bound || !messageId || flow.preview_hash !== flow.draft.hash) {
      return { decision: "CONFIRM_IGNORED_UNBOUND", flow };
    }
    flow.confirmed = true;
    flow.confirmed_by = senderId;
    flow.confirmation_message_id = messageId;
    flow.confirmed_at = store.now();
    flow.confirmed_hash = flow.draft.hash;
    log.info(`mode=shadow flow=${flow.flow_id} event=message_received decision=CONFIRMED confirmed_by=${maskId(senderId)}`);
    return { decision: "CONFIRMED", flow };
  }

  // Any new substantive input may edit a key field. Require a fresh preflight
  // and preview, including structured fill-in and assignee overrides.
  if (flow) {
    invalidateDraft(flow);
    flow.preflight_ok = false;
    flow.preflight_data = null;
    const priority = parsePriorityDirective(content);
    flow.priority_instruction = priority != null && typeof messageId === "string" && messageId.trim()
      ? Object.freeze({ value: priority, message_id: messageId }) : null;
  }
  if (isTicketIntent(content)) {
    if (flow) return { decision: "PENDING_FLOW_ALREADY_EXISTS", flow };
    const started = store.start(sessionKey, senderId);
    if (!started.ok) return { decision: started.reason };
    log.info(`mode=shadow flow=${started.flow.flow_id} event=message_received decision=FLOW_STARTED session=${maskId(sessionKey)} sender=${maskId(senderId)}`);
    const explicitName = parseAssigneeNameRef(content);
    if (explicitName) started.flow.assignee_explicit_name = explicitName;
    const priority = parsePriorityDirective(content);
    if (priority != null && typeof messageId === "string" && messageId.trim()) {
      started.flow.priority_instruction = Object.freeze({ value: priority, message_id: messageId });
    }
    return { decision: "FLOW_STARTED", flow: started.flow };
  }

  return { decision: "NONE", flow };
}

// HOOK-02 before_prompt_build：有效 flow 时注入 Skill 正文（每次真实读文件）
export function handlePromptBuild(deps, { sessionKey, senderId, runId, trigger }) {
  const { log, store, readSkill } = deps;
  if (typeof sessionKey !== "string" || !sessionKey) {
    return { injected: false, reason: "NO_SESSION_KEY" };
  }
  if (trigger && trigger !== "user") return { injected: false, reason: "NOT_USER_TURN" };
  if (typeof senderId !== "string" || !senderId.trim()) {
    return { injected: false, reason: "NO_IDENTITY" };
  }
  const flow = store.get(sessionKey, senderId);
  if (!flow) return { injected: false, reason: "NO_OWN_FLOW" };
  if (runId && !store.bindRun(flow, runId)) return { injected: false, reason: "RUN_CONFLICT" };
  const skill = readSkill();
  if (!skill.ok) {
    log.warn(
      `mode=shadow flow=${flow.flow_id} event=before_prompt_build skill_injected=false reason=SKILL_READ_FAILED`,
    );
    return { injected: false, reason: "SKILL_READ_FAILED" };
  }
  log.info(
    `mode=shadow flow=${flow.flow_id} event=before_prompt_build skill_injected=true skill_sha256=${skill.sha256} session=${maskId(sessionKey)}`,
  );
  return {
    injected: true,
    flow,
    prependContext:
      `[glpi-ticket-gate] 当前会话存在待录入工单流程（flow=${flow.flow_id}）。` +
      `请严格按以下 GLPI 工单录入流程规则执行；生成待录入预览前请调用 glpi_ticket_preflight 工具完成 7 项预检，` +
      `客户实体必须来自本次 glpi_list_entities 实时查询。最终预览必须原样发送 preflight 返回的 final_preview；` +
      `缺项补齐不能代替最终确认，必须由本人回复对应预览或确认码；修改后重新预检、预览、确认。` +
      `正文保留故障现象、处理方法、修复结果三段及发生时间和设备地点上下文；` +
      `目标5/6的解决方案必须同时包含已确认的处理方法和修复结果，使用预检返回的 solution_content，不得仅提交结果。` +
      `分类按预检工具的1至8业务映射推导并展示，不猜默认其他；优先级默认3，非默认须本人明确指令。` +
      `当前支持明确指令“优先级：高”（或1至5/极低/低/中/高/紧急），这不替代后续最终确认。` +
      `默认负责人路径因缺少glpi_get_user契约和实时在职证据而BLOCKED；不得把预览中的ID当作已核验默认身份。` +
      `完成回复应含已回读工单编号、客户及实体ID、发生时间、标题、分类、优先级、负责人和已验证状态；` +
      `不得猜测客户实体是已有或新建，不得将未完成阶段说成目标已达成。` +
      `发生时间写入正文，不能映射到time_to_resolve；MCP无独立来源字段，不得捏造参数。` +
      `创建参数以预检的 create_params 为准，create_ticket 没有 status 参数。` +
      `创建回执仅登记工单ID，须按 flow_evidence.workflow 的阶段在同一工单继续并回读目标状态；` +
      `未知创建结果不得自动重建，未知解决方案结果不得自动重复添加。服务器迁移规则仍需另行验证。` +
      `以下为外部流程参考；若与上述证据要求冲突，不得据此跳过本人的最终确认或提前宣布完成：\n\n${skill.text}`,
  };
}

// HOOK-03 message_sent：待录入预览发送成功证据（仅 success===true）
export function handleSent(deps, { sessionKey, runId, content, messageId, success }) {
  const { log, store } = deps;
  if (success !== true) return { previewRecorded: false, reason: "SEND_FAILED" };
  if (!sessionKey || !runId || !messageId) return { previewRecorded: false, reason: "NO_CORRELATION" };
  const flow = store.getByRun(sessionKey, runId);
  if (!flow || flow.draft?.runId !== runId) return { previewRecorded: false, reason: "NO_BOUND_DRAFT" };
  if (!isPreviewText(content) || content.trim() !== renderFinalPreview(flow)) {
    return { previewRecorded: false, reason: "NOT_FINAL_PREVIEW" };
  }
  flow.preview_sent = true;
  flow.preview_message_id = messageId;
  flow.preview_sent_at = store.now();
  flow.preview_hash = flow.draft.hash;
  log.info(`mode=shadow flow=${flow.flow_id} event=message_sent preview_sent=true session=${maskId(sessionKey)}`);
  return { previewRecorded: true, flow };
}

// Preflight tool factories have no guaranteed runId in v2026.9.9. Bind the
// host's tool call BEFORE execute; missing requester/run/call denies delivery
// attribution while leaving structured preflight validation available.
export function handlePreflightCall(deps, { sessionKey, senderId, runId, toolCallId }) {
  const flow = resolveFlow(deps.store, sessionKey, senderId);
  if (!flow || typeof toolCallId !== "string" || !toolCallId || !runId) return false;
  if (flow.preflight_calls.has(toolCallId) || flow.preflight_calls.size >= 256) return false;
  if (!deps.store.bindRun(flow, runId)) return false;
  flow.preflight_calls.set(toolCallId, runId);
  return true;
}

// HOOK-04 after_tool_call(matcher=glpi__glpi_list_entities)：本次实时查库证据
export function handleEntityLookup(deps, { sessionKey, senderId, result, error }) {
  const { log, store } = deps;
  if (typeof sessionKey !== "string" || !sessionKey) {
    log.warn(`mode=shadow event=after_tool_call tool=entity_list decision=SKIP reason=NO_SESSION_KEY`);
    return { recorded: false };
  }
  const ok = error == null;
  const ids = ok ? extractEntityIds(result) : [];
  // FIX-GLPI-GATE-ENTITY-EXTRACT-001：0 提取时输出形态诊断（只记结构/尺寸，不落业务值），
  // 供下次真实流量定位 hook 侧 sanitized result 的实际形态
  if (ok && ids.length === 0) {
    log.warn(
      `mode=shadow event=after_tool_call tool=entity_list extract_zero=true ${describeResultShape(result)} session=${maskId(sessionKey)}`,
    );
  }
  // FIX-GLPI-ENTITY-EVIDENCE-001A：统一提取诊断日志（只记状态/计数/结构/尺寸，
  // 不落 id 列表与任何业务值）。观测 COMPLETE/ZERO/PARTIAL_SUSPECTED/UNKNOWN 四态，
  // 不改变 ids、entity_lookup_ok、matched_entity_ids 与任何判定行为。
  if (ok) {
    const diag = analyzeEntityExtraction(result);
    const level = diag.extraction_status === "PARTIAL_SUSPECTED" ? "warn" : "debug";
    log[level](
      `mode=shadow event=entity_lookup extraction_status=${diag.extraction_status} ids_count=${ids.length}` +
        ` parse_attempted=${diag.parse_attempted} parse_success=${diag.parse_success}` +
        ` fallback_scan_used=${diag.fallback_scan_used} ${diag.result_shape}` +
        ` result_size=${diag.result_size == null ? "unknown" : diag.result_size}` +
        ` item_count=${diag.item_count_if_known == null ? "unknown" : diag.item_count_if_known}` +
        ` source_kind=${diag.source_kind}` +
        (diag.diagnostic_reason ? ` diagnostic_reason=${diag.diagnostic_reason}` : "") +
        (diag.note ? ` note=${diag.note}` : ""),
    );
  } else {
    log.debug(
      `mode=shadow event=entity_lookup extraction_status=ZERO ids_count=0 source_kind=tool_error diagnostic_reason=TOOL_ERROR`,
    );
  }
  // Missing trusted sender never records evidence, even for a unique flow.
  const flow = resolveFlow(store, sessionKey, senderId);
  if (!flow) {
    log.info(
      `mode=shadow event=after_tool_call tool=entity_list entity_lookup_ok=${ok && ids.length > 0} matched=${ids.length} note=NO_OWN_FLOW session=${maskId(sessionKey)} sender=${maskId(senderId)}`,
    );
    return { recorded: false };
  }
  flow.entity_lookup_ok = ok && ids.length > 0;
  flow.matched_entity_ids = flow.entity_lookup_ok ? ids : [];
  flow.entity_lookup_at = store.now();
  log.info(
    `mode=shadow flow=${flow.flow_id} event=after_tool_call tool=entity_list entity_lookup_ok=${flow.entity_lookup_ok} matched=${ids.length} sender=${maskId(senderId)}`,
  );
  return { recorded: true, flows: [flow] };
}

// HOOK-04b after_tool_call(matcher=glpi__glpi_get_entity)：单实体窄确认证据
//（FIX-002 方案B + HARDEN-GLPI-GATE-20261003：严格归属 + 请求-结果 ID 核对）
export function handleEntityConfirm(deps, { sessionKey, senderId, result, error, params }) {
  const { log, store } = deps;
  if (typeof sessionKey !== "string" || !sessionKey) {
    log.warn(`mode=shadow event=entity_confirm decision=SKIP reason=NO_SESSION_KEY`);
    return { recorded: false };
  }
  // Exact trusted owner only.
  const flow = resolveFlow(store, sessionKey, senderId);
  if (!flow) {
    log.info(
      `mode=shadow event=entity_confirm decision=SKIP reason=NO_OWN_FLOW session=${maskId(sessionKey)} sender=${maskId(senderId)}`,
    );
    return { recorded: false };
  }
  const ok = error == null;
  const narrowId = ok ? extractSingleEntityId(result) : null;
  // HARDEN：请求实体 ID（after_tool_call 事件 params，源码实证 startArgs 必携带）与结果
  // ID 必须一致；别名冲突（entity_id 与 id 不同值）拒绝。params 缺失按 fail-closed 不记录。
  const requestedIds =
    params && typeof params === "object"
      ? ["entity_id", "entities_id", "id"].filter((k) => params[k] != null).map((k) => String(params[k]))
      : [];
  const requested =
    requestedIds.length > 0 && requestedIds.every((v) => v === requestedIds[0])
      ? requestedIds[0]
      : null;
  const complete = narrowId != null && requested === narrowId;
  // 观测日志：只记结果/状态/结构，不落 id 与名称等业务值
  log[ok ? "info" : "warn"](
    `mode=shadow event=entity_confirm narrow_ok=${complete} tool_ok=${ok}` +
      (ok ? ` ${describeResultShape(result)}` : ` source_kind=tool_error diagnostic_reason=TOOL_ERROR`),
  );
  if (!complete) {
    // fail-closed：截断/多条/无 id/工具错误/请求-结果不符一律清空窄证据（最新一次窄查询为准）
    flow.narrow_entity_id = null;
    flow.narrow_entity_at = null;
    return { recorded: false };
  }
  flow.narrow_entity_id = narrowId;
  flow.narrow_entity_at = store.now();
  log.info(
    `mode=shadow flow=${flow.flow_id} event=entity_confirm narrow_confirmed=true sender=${maskId(senderId)}`,
  );
  return { recorded: true, flows: [flow] };
}

// glpi_ticket_preflight 工具执行时记录证据（工厂 ctx 提供 sessionKey/requesterSenderId）
export function recordPreflightEvidence(deps, { sessionKey, senderId, result, expectedFlow, toolCallId }) {
  const { log, store } = deps;
  if (typeof sessionKey !== "string" || !sessionKey) {
    log.warn(
      `mode=shadow event=preflight_tool decision=SKIP reason=NO_IDENTITY session=${maskId(sessionKey)} sender=${maskId(senderId)}`,
    );
    return { recorded: false };
  }
  const flow = resolveFlow(store, sessionKey, senderId);
  if (!flow || (expectedFlow && flow !== expectedFlow)) {
    log.info(
      `mode=shadow event=preflight_tool decision=SKIP reason=NO_ACTIVE_FLOW session=${maskId(sessionKey)} sender=${maskId(senderId)}`,
    );
    return { recorded: false };
  }
  if (result.PREFLIGHT_STATUS === "PASS") {
    const runId = flow.preflight_calls.get(toolCallId);
    // Consume once, retaining the ID as a tombstone until Flow TTL.
    if (runId) flow.preflight_calls.set(toolCallId, null);
    setDraft(flow, result.data, runId);
    flow.preflight_ok = true;
    flow.preflight_data = Object.freeze({ ...result.data });
  } else {
    invalidateDraft(flow);
    flow.preflight_ok = false;
    flow.preflight_data = null;
  }
  log.info(
    `mode=shadow flow=${flow.flow_id} event=preflight_tool preflight_ok=${flow.preflight_ok} missing=${JSON.stringify(result.MISSING_FIELDS ?? [])}`,
  );
  return { recorded: true, flow };
}

// A create result establishes a ticket ID, not target-state completion.
export function handleCreateCheck(deps, input) {
  return handleWorkflowCheck(deps, { ...input, kind: "create" });
}
export function handleCreateResult(deps, input) {
  return handleWorkflowResult(deps, { ...input, kind: "create" });
}
