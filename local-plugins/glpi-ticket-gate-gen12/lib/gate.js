import { draftHash } from "./draft.js";
import { createParamsMatch, priorityInstructionMatches } from "./contract.js";

/**
 * Shadow Gate 判定（第十三节 CHECK-01…CHECK-06，按序短路）。
 * Phase1 仅输出 WOULD_ALLOW / WOULD_BLOCK 证据，绝不 block。
 */
export function evaluateCreate(flow, params) {
  if (flow == null) {
    return { would_allow: false, would_block: true, reason: "NO_ACTIVE_TICKET_FLOW" };
  }
  if (flow.workflow?.ticket_id) return { would_allow: false, would_block: true, reason: "TICKET_ALREADY_CREATED" };
  if (flow.workflow?.phase === "CREATE_OUTCOME_UNKNOWN") return { would_allow: false, would_block: true, reason: "CREATE_OUTCOME_UNKNOWN" };
  if (flow.preflight_ok !== true) {
    return { would_allow: false, would_block: true, reason: "PREFLIGHT_REQUIRED" };
  }
  // HARDEN-GLPI-GATE-20261003（gen10 加固，老板批准）：建单在途去重——
  // WOULD_ALLOW 只登记提交中，等 after_tool_call 关联结果成功后才清 flow；
  // 在途期间重复建单记 CREATE_IN_PROGRESS（影子模式照旧放行）。
  if (flow.submissions && [...flow.submissions.values()].some((s) => s.allowed === true)) {
    return { would_allow: false, would_block: true, reason: "CREATE_IN_PROGRESS" };
  }
  if (flow.entity_lookup_ok !== true) {
    return { would_allow: false, would_block: true, reason: "ENTITY_NOT_VERIFIED" };
  }
  // FIX-GLPI-ENTITY-EVIDENCE-002（2026-10-01，老板批准方案B）：实体校验以窄证据为权威。
  // 大列表 hook 副本会截断（PARTIAL_SUSPECTED 只能恢复部分 id），matched_entity_ids
  // 不再参与判定；建单 entity_id 必须等于本流程 glpi_get_entity 单实体窄确认证据。
  if (flow.narrow_entity_id == null) {
    return { would_allow: false, would_block: true, reason: "ENTITY_NOT_CONFIRMED" };
  }
  const p = params && typeof params === "object" ? params : {};
  const entityId =
    p.entity_id != null ? String(p.entity_id) : p.entities_id != null ? String(p.entities_id) : "";
  if (!entityId || entityId !== String(flow.narrow_entity_id)) {
    return { would_allow: false, would_block: true, reason: "ENTITY_MISMATCH" };
  }
  // HARDEN-GLPI-GATE-20261003：最小内容绑定——预检数据、窄证据、提交参数三方核对。
  // 窄证据实体≠预检实体，或参数中出现的标题/状态与预检登记不一致 → CONTENT_MISMATCH
  //（字段缺省不硬拒：真实 MCP 建单必带 name，字段在才核对——老板评审复现的
  //「预检1/证据2/提交2+改标题」场景在此被拦下）。
  const data = flow.preflight_data;
  if (data && typeof data === "object") {
    if (String(flow.narrow_entity_id) !== String(data.entity_id)) {
      return { would_allow: false, would_block: true, reason: "CONTENT_MISMATCH" };
    }
    const titleParam =
      p.name != null ? String(p.name) : p.title != null ? String(p.title) : null;
    if (titleParam != null && titleParam !== String(data.title)) {
      return { would_allow: false, would_block: true, reason: "CONTENT_MISMATCH" };
    }

  }
  // GEN11（2026-10-03 老板批准）：负责人绑定——默认已标注+确认且未被覆盖时，
  // 建单负责人参数必须与默认登记一致；预检登记与提交参数亦核对（字段在才比对）。
  if (
    flow.assignee_default != null &&
    flow.assignee_default.id != null &&
    flow.assignee_default_confirmed === true &&
    flow.assignee_override == null
  ) {
    const a =
      p.user_id_assign != null
        ? String(p.user_id_assign)
        : p.users_id_assign != null
          ? String(p.users_id_assign)
          : null;
    if (a != null && a !== String(flow.assignee_default.id)) {
      return { would_allow: false, would_block: true, reason: "ASSIGNEE_MISMATCH" };
    }
  }
  if (
    data &&
    typeof data === "object" &&
    p.user_id_assign != null &&
    data.assignee_user_id != null &&
    String(p.user_id_assign) !== String(data.assignee_user_id)
  ) {
    return { would_allow: false, would_block: true, reason: "ASSIGNEE_MISMATCH" };
  }
  if (flow.preview_sent !== true) {
    return { would_allow: false, would_block: true, reason: "PREVIEW_NOT_SENT" };
  }
  if (flow.confirmed !== true) {
    return { would_allow: false, would_block: true, reason: "CONFIRMATION_REQUIRED" };
  }
  if (!data || !flow.draft || flow.draft.hash !== draftHash(data) ||
      flow.preview_hash !== flow.draft.hash || flow.confirmed_hash !== flow.draft.hash ||
      flow.confirmed_by !== flow.initiator_sender_id) {
    return { would_allow: false, would_block: true, reason: "DRAFT_BINDING_REQUIRED" };
  }
  if (Object.hasOwn(p, "status")) {
    return { would_allow: false, would_block: true, reason: "CREATE_STATUS_UNSUPPORTED" };
  }
  if (!createParamsMatch(p, data)) {
    return { would_allow: false, would_block: true, reason: "CONTENT_MISMATCH" };
  }
  if (!priorityInstructionMatches(flow)) {
    return { would_allow: false, would_block: true, reason: "PRIORITY_OVERRIDE_EVIDENCE_REQUIRED" };
  }
  return { would_allow: true, would_block: false, reason: null };
}

/**
 * 从 glpi_list_entities 调用结果中提取实体 ID。
 * 防御式解析：数组 / {entities|data|items} / 数字键对象（GLPI range 形态）/
 * JSON 字符串 / MCP content 包络 / 截断 JSON 抢救。
 * 只收数字型 id；提取失败返回空数组（fail-closed → entity_lookup_ok=false）。
 *
 * FIX-GLPI-GATE-ENTITY-EXTRACT-001（2026-10-01）：hook 收到的是 sanitized result——
 * 超大返回（range 0-500 ≈ 1.9MB）会被截断为约 19 万字符的无效 JSON 字符串，
 * 原实现 JSON.parse 失败即返回 []，把「查到了」记成「没查到」（2026-09-30 18:37:33
 * 生产事件，审计 AUDIT-GLPI-SHADOW-REAL-001）。现对截断字符串按 "id":N 正则抢救，
 * 并在 0 提取时由 handler 输出 describeResultShape 形态诊断。
 */
const ENTITY_ID_SCAN_RE = /"id"\s*:\s*"?(\d+)"?/g;

function idsFromEntityItems(arr) {
  const ids = [];
  for (const item of arr.slice(0, 500)) {
    if (item && typeof item === "object" && item.id != null) {
      const id = String(item.id);
      if (/^\d+$/.test(id) && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

function entityMapValues(payload) {
  const values = Object.values(payload);
  if (values.length === 0) return null;
  const entityLike = values.filter(
    (v) => v != null && typeof v === "object" && !Array.isArray(v) && v.id != null,
  );
  if (entityLike.length > 0 && entityLike.length * 2 >= values.length) return entityLike;
  return null;
}

/**
 * FIX-GLPI-ENTITY-EVIDENCE-001A（2026-10-01，老板批准）：提取过程观测诊断。
 * 只回答「hook 拿到的实体查询结果是什么形态、是否存在明确或疑似截断」，
 * 不改变提取行为（ids 与原实现逐分支一致）、不参与 evaluateCreate 判定。
 * extraction_status 四态：
 * - COMPLETE          有较强证据证明结果完整（字符串 JSON.parse 成功=完整 JSON 文档）；
 * - ZERO              工具调用成功但 0 提取（现有 extract_zero 行为不变）；
 * - PARTIAL_SUSPECTED 有 id 但存在明确/强烈疑似不完整证据：SIGNAL-A
 *                     （JSON.parse 失败后正则抢救，即 Core 截断字符串）或
 *                     数组超过扫描上限（自身 slice 上限，可证明）；
 *                     仅观测结论，不影响 allow/block；
 * - UNKNOWN           无法证明完整也无法证明部分截断（如直传结构化数组）。
 *                     仅凭条数少不判截断（SIGNAL-D），只附 note=LOW_ITEM_COUNT。
 */
const ENTITY_SCAN_ITEM_CAP = 500; // idsFromEntityItems 既有 slice(0,500) 上限，行为不变

function newExtractionDiag() {
  return {
    ids: [],
    extraction_status: "ZERO",
    source_kind: "unparsed_shape",
    parse_attempted: false,
    parse_success: false,
    fallback_scan_used: false,
    suspected_truncated: false,
    result_shape: "result_shape=null",
    result_size: null,
    item_count_if_known: null,
    diagnostic_reason: null,
    note: null,
    _from_complete_json: false,
    _scan_capped: false,
    _depth_limited: false,
  };
}

function extractEntityIdsDetailed(result, depth = 0, diag = newExtractionDiag()) {
  if (depth > 3) {
    diag._depth_limited = true;
    return diag;
  }
  let payload = result;
  if (typeof payload === "string") {
    const text = payload.trim();
    if (!text) {
      diag.source_kind = "empty_string";
      return diag;
    }
    diag.parse_attempted = true;
    try {
      diag.parse_success = true;
      diag._from_complete_json = true;
      return extractEntityIdsDetailed(JSON.parse(text), depth + 1, diag);
    } catch {
      // 截断 JSON 抢救：只收 "id":数字；entities_id 等含 _id 字段名不匹配该模式
      diag.parse_success = false;
      diag.fallback_scan_used = true;
      diag.source_kind = "string_fallback_scan";
      const ids = [];
      let m;
      ENTITY_ID_SCAN_RE.lastIndex = 0;
      while ((m = ENTITY_ID_SCAN_RE.exec(text)) !== null) {
        const id = m[1];
        if (!ids.includes(id)) ids.push(id);
      }
      diag.ids = ids;
      return diag;
    }
  }
  if (payload == null || typeof payload !== "object") {
    diag.source_kind = payload == null ? "null_result" : "scalar_value";
    return diag;
  }
  if (Array.isArray(payload.content)) {
    const textPart = payload.content.find((part) => part && typeof part.text === "string");
    if (textPart) {
      return extractEntityIdsDetailed(textPart.text, depth + 1, diag);
    }
    // content 无 text 块：按原实现继续尝试其余形态
  }
  if (Array.isArray(payload)) {
    diag.source_kind = "array";
    diag.item_count_if_known = payload.length;
    if (payload.length > ENTITY_SCAN_ITEM_CAP) diag._scan_capped = true;
    diag.ids = idsFromEntityItems(payload);
    return diag;
  }
  if (Array.isArray(payload.entities)) {
    diag.source_kind = "entities_array";
    diag.item_count_if_known = payload.entities.length;
    if (payload.entities.length > ENTITY_SCAN_ITEM_CAP) diag._scan_capped = true;
    diag.ids = idsFromEntityItems(payload.entities);
    return diag;
  }
  if (Array.isArray(payload.data)) {
    diag.source_kind = "data_array";
    diag.item_count_if_known = payload.data.length;
    if (payload.data.length > ENTITY_SCAN_ITEM_CAP) diag._scan_capped = true;
    diag.ids = idsFromEntityItems(payload.data);
    return diag;
  }
  if (Array.isArray(payload.items)) {
    diag.source_kind = "items_array";
    diag.item_count_if_known = payload.items.length;
    if (payload.items.length > ENTITY_SCAN_ITEM_CAP) diag._scan_capped = true;
    diag.ids = idsFromEntityItems(payload.items);
    return diag;
  }
  for (const key of ["entities", "data", "items"]) {
    const sub = payload[key];
    if (sub != null && typeof sub === "object" && !Array.isArray(sub)) {
      const map = entityMapValues(sub);
      if (map) {
        diag.source_kind = `${key}_map`;
        diag.item_count_if_known = map.length;
        diag.ids = idsFromEntityItems(map);
        return diag;
      }
    }
  }
  const map = entityMapValues(payload);
  if (map) {
    diag.source_kind = "numeric_key_map";
    diag.item_count_if_known = map.length;
    diag.ids = idsFromEntityItems(map);
    return diag;
  }
  return diag;
}

function safeResultSize(result) {
  try {
    if (typeof result === "string") return result.length;
    if (result == null) return 0;
    const serialized = JSON.stringify(result);
    return typeof serialized === "string" ? serialized.length : null;
  } catch {
    return null;
  }
}

/**
 * 提取诊断入口（FIX-GLPI-ENTITY-EVIDENCE-001A）：返回 ids/extraction_status/
 * source_kind/parse_attempted/parse_success/fallback_scan_used/suspected_truncated/
 * result_shape/result_size/item_count_if_known/diagnostic_reason/note。
 * result_shape/size 只记结构与尺寸，绝不落实体名等业务值。
 */
export function analyzeEntityExtraction(result) {
  const diag = newExtractionDiag();
  try {
    diag.result_shape = describeResultShape(result);
    diag.result_size = safeResultSize(result);
    extractEntityIdsDetailed(result, 0, diag);
  } catch {
    diag.diagnostic_reason = "DIAGNOSTIC_INTERNAL_ERROR";
  }
  if (diag.ids.length === 0) {
    diag.extraction_status = "ZERO";
    if (diag._depth_limited) {
      if (!diag.diagnostic_reason) diag.diagnostic_reason = "DEPTH_LIMIT_REACHED";
    } else if (diag.parse_attempted && !diag.parse_success) {
      if (!diag.diagnostic_reason) diag.diagnostic_reason = "JSON_PARSE_FAILED_NO_ID_RECOVERED";
    } else if (result == null) {
      if (!diag.diagnostic_reason) diag.diagnostic_reason = "NULL_RESULT";
    } else if (typeof result === "string" && !result.trim()) {
      if (!diag.diagnostic_reason) diag.diagnostic_reason = "EMPTY_STRING";
    } else if (!diag.diagnostic_reason) {
      diag.diagnostic_reason = "NO_ENTITY_IDS_FOUND";
    }
  } else if (diag.fallback_scan_used) {
    diag.extraction_status = "PARTIAL_SUSPECTED";
    diag.suspected_truncated = true;
    diag.diagnostic_reason = "JSON_PARSE_FAILED_WITH_ID_RECOVERY";
  } else if (diag._scan_capped) {
    diag.extraction_status = "PARTIAL_SUSPECTED";
    diag.suspected_truncated = true;
    diag.diagnostic_reason = "ITEM_SCAN_CAP_EXCEEDED";
  } else if (diag._from_complete_json) {
    diag.extraction_status = "COMPLETE";
  } else {
    diag.extraction_status = "UNKNOWN";
    if (
      diag.item_count_if_known != null &&
      diag.item_count_if_known > 0 &&
      diag.item_count_if_known < 10
    ) {
      diag.note = "LOW_ITEM_COUNT";
    }
  }
  delete diag._from_complete_json;
  delete diag._scan_capped;
  delete diag._depth_limited;
  return diag;
}

// 旧接口（FIX-001 前后行为一致；SUP-01/E01..E07/DIAG-08 锁定）
export function extractEntityIds(result, depth = 0) {
  return extractEntityIdsDetailed(result, depth).ids;
}

/**
 * 0 提取时的形态诊断：只输出结构与尺寸，不输出任何值（客户名等业务数据不落日志）。
 */
export function describeResultShape(result) {
  try {
    if (result == null) return "result_shape=null";
    if (typeof result === "string") return `result_type=string len=${result.length}`;
    if (Array.isArray(result)) return `result_type=array len=${result.length}`;
    if (typeof result === "object") {
      const keys = Object.keys(result);
      let envelope = "";
      if (Array.isArray(result.content)) {
        const textLens = result.content.map((p) =>
          p && typeof p.text === "string" ? p.text.length : -1,
        );
        envelope = ` content_blocks=${result.content.length} text_block_lengths=[${textLens.join(",")}]`;
      }
      return `result_type=object keys=${keys.length} head=[${keys.slice(0, 5).join(",")}]${envelope}`;
    }
    return `result_type=${typeof result}`;
  } catch {
    return "result_shape=error";
  }
}

/**
 * FIX-GLPI-ENTITY-EVIDENCE-002（2026-10-01，老板批准方案B）：单实体窄确认提取。
 * 供 glpi_get_entity 结果观察用——只接受「单条完整记录」：
 * - 字符串：必须 JSON.parse 成功（完整 JSON 文档；截断文本 fail-closed 拒绝）；
 * - MCP envelope {content:[{text}]}：恰 1 个 text 块才递归，多块/冲突拒绝；
 *   isError:true 一律拒绝（HARDEN-GLPI-GATE-20261003）；
 * - 直传对象：必须含数字型 id；
 * - 数组：长度必须为 1 且元素含 id。
 * 提取不到/多条/截断 → null（fail-closed，不设窄证据）。
 * 只返回 id；实体名等业务值由 handler 只存 flow 状态、不落日志。
 */
export function extractSingleEntityId(result, depth = 0) {
  // HARDEN-GLPI-GATE-20261003：MCP 包络完整性——isError:true 拒绝、
  // content 多文本块拒绝（多实体取首个不可靠）、数组必须恰 1 条。
  if (depth > 8 || result == null) return null;
  if (typeof result === "string") {
    try {
      return extractSingleEntityId(JSON.parse(result), depth + 1);
    } catch {
      return null; // 截断/非完整 JSON：fail-closed
    }
  }
  if (typeof result !== "object" || result.isError === true) return null;
  if (Array.isArray(result)) {
    return result.length === 1 ? extractSingleEntityId(result[0], depth + 1) : null;
  }
  if (Array.isArray(result.content)) {
    const parts = result.content;
    if (parts.length !== 1 || parts[0]?.type !== "text" || typeof parts[0]?.text !== "string") {
      return null;
    }
    return extractSingleEntityId(parts[0].text, depth + 1);
  }
  if (result.id == null || !/^\d+$/.test(String(result.id))) return null;
  return String(result.id);
}
