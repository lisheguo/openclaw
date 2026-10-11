import { createInboundReplayGuard } from "./inbound-replay.js";

// GEN11（2026-10-03 老板批准）：默认 TTL 与 config.js 同步提升为 2h。
export const FLOW_TTL_MS = 2 * 60 * 60 * 1000;

export function flowKey(sessionKey, senderId) {
  // HARDEN-GLPI-GATE-20261003：JSON 数组键防分隔符碰撞（"a|b"+"c" 与 "a"+"b|c" 不再同键）。
  return JSON.stringify([sessionKey, senderId]);
}

/**
 * 插件进程内 FlowState（CHG-GLPI-TEMPLATE-GATE-001-PHASE1 第八节）：
 * - KEY = JSON.stringify([sessionKey, initiator_sender_id])
 * - 同一 sender 同一 session 同时最多 1 个 pending flow
 * - TTL 默认 2 小时；到期/完成即清除；Gateway 重启即清空（预期，fail-closed）
 * - 不使用外部数据库/Redis/SQLite/Hindsight/MEMORY
 * - 入站 receipts 不随 Flow TTL/完成清理；新实例会丢失它们，不保证跨重启去重。
 */
// GEN12（2026-10-11 老板批准 R3-B：改插件、不改 core）：
// 宿主派发 after_tool_call 的 ctx 不含 requester（身份缺失），而 glpi_ticket_preflight
// 的工具工厂可拿到 runtime 注入的 requesterSenderId。兜底：工厂处登记
// sessionKey -> senderId，钩子侧按会话取回。
// 安全约束（不放松为"唯一 flow 即授权"）：仅当该 sender 在本会话恰有 1 个活跃 flow、
// 且本会话不存在其他 sender 的活跃 flow 时才采用；否则 fail-closed（宁可少挂证据）。
export const IDENTITY_TTL_MS = 30 * 60 * 1000;
const IDENTITY_MAX_ENTRIES = 512;

export function createFlowStore(
  ttlMs = FLOW_TTL_MS,
  now = () => Date.now(),
  idGen = () => `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  replayOptions = {},
  identityOptions = {},
) {
  const identityTtlMs =
    typeof identityOptions.ttlMs === "number" && Number.isFinite(identityOptions.ttlMs) && identityOptions.ttlMs > 0
      ? identityOptions.ttlMs
      : IDENTITY_TTL_MS;
  const flows = new Map(); // JSON.stringify([sessionKey, senderId]) -> flow
  const identities = new Map(); // sessionKey -> { senderId, source, at }

  // HARDEN-GLPI-GATE-20261003：边界即过期（now >= expires_at）。
  const isExpired = (flow) => flow != null && now() >= flow.expires_at;

  const purge = (key) => {
    const flow = flows.get(key);
    if (flow && isExpired(flow)) flows.delete(key);
  };

  return {
    flows,
    now,
    inboundReplay: createInboundReplayGuard(replayOptions),
    get(sessionKey, senderId) {
      const key = flowKey(sessionKey, senderId);
      purge(key);
      return flows.get(key);
    },
    start(sessionKey, senderId) {
      const key = flowKey(sessionKey, senderId);
      // HARDEN-GLPI-GATE-20261003：顺手清理全部过期 flow，避免长期驻留。
      for (const [oldKey, oldFlow] of flows) {
        if (isExpired(oldFlow)) flows.delete(oldKey);
      }
      purge(key);
      if (flows.has(key)) {
        return { ok: false, reason: "PENDING_FLOW_ALREADY_EXISTS", flow: flows.get(key) };
      }
      const flow = {
        flow_id: idGen(),
        session_key: sessionKey,
        initiator_sender_id: senderId,
        started_at: now(),
        expires_at: now() + ttlMs,
        preflight_ok: false,
        preflight_data: null,
        entity_lookup_ok: false,
        matched_entity_ids: [],
        entity_lookup_at: null,
        // FIX-GLPI-ENTITY-EVIDENCE-002：单实体窄确认证据（方案B，只存 id 不存名称）
        narrow_entity_id: null,
        narrow_entity_at: null,
        preview_sent: false,
        preview_message_id: null,
        preview_sent_at: null,
        confirmed: false,
        confirmed_by: null,
        confirmation_message_id: null,
        confirmed_at: null,
        // Trusted agent hook run IDs only; never populated from text or tool arguments.
        run_ids: new Set(),
        preflight_calls: new Map(),
        draft: null,
        preview_hash: null,
        confirmed_hash: null,
        priority_instruction: null, // explicit host inbound directive, never tool/model assertions
        // GEN11（2026-10-03 老板批准）：负责人默认机制证据字段（shadow 遥测用）
        assignee_explicit_name: null,
        assignee_default: null, // { name, id, marked_at }
        assignee_default_confirmed: false,
        assignee_default_confirmed_at: null,
        assignee_override: null, // { name, at }
        // HARDEN-GLPI-GATE-20261003：建单在途登记 toolCallId -> {allowed}；
        // 创建关联只登记 ID；目标状态回读完成才清 flow，未知创建结果不可自动重建。
        submissions: new Map(),
        workflow: {
          phase: "DRAFT", ticket_id: null, data: null, draft_hash: null,
          solution_id: null, solution_unknown: false, last_status: null,
          solution_count: null, observed_resolved: false, last_requested_status: null,
          operations: new Map(),
        },
      };
      flows.set(key, flow);
      return { ok: true, flow };
    },
    activeInSession(sessionKey) {
      const list = [];
      for (const [key, flow] of flows) {
        if (flow.session_key !== sessionKey) continue;
        if (isExpired(flow)) {
          flows.delete(key);
          continue;
        }
        list.push(flow);
      }
      return list;
    },
    bindRun(flow, runId) {
      if (typeof runId !== "string" || !runId.trim()) return false;
      const active = this.activeInSession(flow.session_key);
      if (!active.includes(flow)) return false;
      if (active.some((other) => other !== flow && other.run_ids.has(runId))) return false;
      // Bound memory; exhaustion denies a new binding instead of evicting a live one.
      if (!flow.run_ids.has(runId) && flow.run_ids.size >= 256) return false;
      flow.run_ids.add(runId);
      return true;
    },
    getByRun(sessionKey, runId) {
      if (typeof runId !== "string" || !runId.trim()) return null;
      const matches = this.activeInSession(sessionKey).filter((flow) => flow.run_ids.has(runId));
      return matches.length === 1 ? matches[0] : null;
    },
    // ---- GEN12 R3-B：会话级身份兜底（登记/取回/无歧义解析） ----
    identities,
    rememberIdentity(sessionKey, senderId, source = "unknown") {
      if (typeof sessionKey !== "string" || !sessionKey ||
          typeof senderId !== "string" || !senderId.trim()) return false;
      if (identities.size >= IDENTITY_MAX_ENTRIES && !identities.has(sessionKey)) {
        let oldestKey = null, oldestAt = Infinity;
        for (const [k, v] of identities) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
        if (oldestKey != null) identities.delete(oldestKey);
      }
      identities.set(sessionKey, { senderId, source, at: now() });
      return true;
    },
    recallIdentity(sessionKey) {
      if (typeof sessionKey !== "string" || !sessionKey) return null;
      const rec = identities.get(sessionKey);
      if (!rec) return null;
      if (now() - rec.at >= identityTtlMs) { identities.delete(sessionKey); return null; }
      return rec;
    },
    /**
     * 解析本轮可信 senderId：
     * - runtime 显式身份存在 → 直接采用（source=requester）
     * - 否则取会话兜底，但必须"该 sender 恰有 1 个活跃 flow 且会话内无其他活跃 flow"
     * - 否则 senderId=null（fail-closed，行为与修复前一致）
     */
    resolveTrustedSender(sessionKey, explicitSenderId) {
      if (typeof explicitSenderId === "string" && explicitSenderId.trim()) {
        return { senderId: explicitSenderId, source: "requester" };
      }
      const rec = this.recallIdentity(sessionKey);
      if (!rec) return { senderId: null, source: "none" };
      const active = this.activeInSession(sessionKey);
      if (active.length === 0) return { senderId: null, source: "none_no_flow" };
      const own = active.filter((f) => f.initiator_sender_id === rec.senderId);
      if (own.length !== 1) return { senderId: null, source: "none_no_own_flow" };
      if (active.length !== 1) return { senderId: null, source: "none_session_ambiguous" };
      return { senderId: rec.senderId, source: "session" };
    },
    complete(flow) {
      const key = flowKey(flow.session_key, flow.initiator_sender_id);
      if (flows.get(key) === flow) flows.delete(key);
    },
  };
}
