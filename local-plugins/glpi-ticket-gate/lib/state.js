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
export function createFlowStore(
  ttlMs = FLOW_TTL_MS,
  now = () => Date.now(),
  idGen = () => `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  replayOptions = {},
) {
  const flows = new Map(); // JSON.stringify([sessionKey, senderId]) -> flow

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
    complete(flow) {
      const key = flowKey(flow.session_key, flow.initiator_sender_id);
      if (flows.get(key) === flow) flows.delete(key);
    },
  };
}
