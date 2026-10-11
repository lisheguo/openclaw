import { renderFinalPreview, renderTicketContent } from "../lib/draft.js";
import { buildCreateParams, renderSolutionContent } from "../lib/contract.js";
import { handleWorkflowCheck, handleWorkflowResult } from "../lib/workflow.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  isTicketIntent,
  isConfirmation,
  isPreviewText,
  isStructuredFillIn,
  parseAssigneeDefault,
  parseAssigneeNameRef,
} from "../lib/detect.js";
import { runPreflight, renderPreflightText } from "../lib/preflight.js";
import { evaluateCreate, extractEntityIds, analyzeEntityExtraction, extractSingleEntityId } from "../lib/gate.js";
import { createFlowStore, FLOW_TTL_MS } from "../lib/state.js";
import { resolveConfig } from "../lib/config.js";
import {
  handleInbound,
  handlePreflightCall,
  handlePromptBuild,
  handleSent,
  handleEntityLookup,
  handleEntityConfirm,
  recordPreflightEvidence,
  handleCreateCheck,
  handleCreateResult,
} from "../lib/handlers.js";
import {
  createFlowGatedToolFactory,
  PREFLIGHT_TOOL_NAME,
  createPreflightTool,
} from "../lib/tool.js";

const SESSION = "agent:main:feishu:group:oc_test_group";
const SENDER_A = "ou_technician_a";
const SENDER_B = "ou_technician_b";

const BASE_INPUT = {
  customer_name: "泰兰尼斯",
  entity_id: 102,
  occurred_at: "2026-09-30 14:03",
  symptom: "富阳仓库移动宽带中断，冷备线路切换",
  method: "切换到冷备线路",
  result: "约1分钟恢复，客户确认正常",
  assignee_user_id: 8,
  target_status: 5,
  category_id: 1,
  title: "泰兰尼斯-富阳仓库网络冷备切换",
};

const ENTITY_RESULT = [
  { id: 0, name: "Root entity" },
  { id: 102, name: "杭州泰潼商贸有限公司" },
  { id: 172, name: "浙江理工大学" },
];

function makeHarness({ ownerSenderIds = [] } = {}) {
  let clock = 1_000_000;
  const logs = [];
  let preflightCall = 0;
  let inboundMessage = 0; // Synthetic host transport IDs, distinct user messages.
  let createCall = 0;
  let lastAllowedCreate;
  const createInputs = new Map();
  const store = createFlowStore(
    30 * 60 * 1000,
    () => clock,
    (() => {
      let n = 0;
      return () => `flow-${++n}`;
    })(),
  );
  const cfg = resolveConfig({ ownerSenderIds });
  const log = {
    debug: (m) => logs.push(`debug :: ${m}`),
    info: (m) => logs.push(`info :: ${m}`),
    warn: (m) => logs.push(`warn :: ${m}`),
  };
  const readSkill = () => ({ ok: true, text: "# GLPI 工单录入流程规则（测试替身）", sha256: "a".repeat(64) });
  const deps = { cfg, log, store, readSkill };
  return {
    deps,
    store,
    logs,
    tick: (ms) => {
      clock += ms;
    },
    inbound: (text, sender = SENDER_A, session = SESSION) =>
      handleInbound(deps, {
        channelId: "feishu", // Synthetic SDK host context, not inferred from text.
        sessionKey: session,
        senderId: sender,
        messageId: `fixture-message-${++inboundMessage}`,
        replyToId: store.get(session, sender)?.preview_message_id,
        text,
      }),
    preflight: (input = BASE_INPUT, sender = SENDER_A, session = SESSION) => {
      const r = runPreflight(input);
      const toolCallId = `preflight-${++preflightCall}`;
      handlePreflightCall(deps, { sessionKey: session, senderId: sender, runId: `run-${sender}`, toolCallId });
      recordPreflightEvidence(deps, { sessionKey: session, senderId: sender, result: r, toolCallId });
      return r;
    },
    lookup: (result = ENTITY_RESULT, sender = SENDER_A, session = SESSION, error = null) =>
      handleEntityLookup(deps, { sessionKey: session, senderId: sender, result, error }),
    narrow: (
      record = { id: 102, name: "杭州泰潼商贸有限公司" },
      sender = SENDER_A,
      session = SESSION,
      params,
    ) =>
      handleEntityConfirm(deps, {
        sessionKey: session,
        senderId: sender,
        result: record,
        error: null,
        params:
          params ??
          (record && typeof record === "object" && record.id != null
            ? { id: record.id }
            : { id: 999 }),
      }),
    preview: (sender = SENDER_A, session = SESSION) =>
      handleSent(deps, {
        sessionKey: session,
        success: true,
        messageId: "om_preview_1",
        runId: `run-${sender}`,
        content: renderFinalPreview(store.get(session, sender)),
      }),
    create: (params = {}, sender = SENDER_A, session = SESSION) => {
      const input = { sessionKey: session, senderId: sender, runId: `run-${sender}`,
        params: { ...buildCreateParams(store.get(session, sender)?.preflight_data ?? runPreflight(BASE_INPUT).data), ...params },
        toolCallId: `create-${++createCall}` };
      createInputs.set(input.toolCallId, input);
      const result = handleCreateCheck(deps, input);
      if (result.decisions[0].would_allow) lastAllowedCreate = input.toolCallId;
      return result;
    },
    complete: (result = { success: true, id: 90 }, error = null, sender = SENDER_A,
      session = SESSION, toolCallId = lastAllowedCreate) => handleCreateResult(deps, {
        ...createInputs.get(toolCallId), sessionKey: session, senderId: sender,
        runId: `run-${sender}`, toolCallId, result, error,
      }),
    finishTarget: () => {
      const flow = store.get(SESSION, SENDER_A); const w = flow.workflow;
      assert.ok(w.ticket_id, 'create receipt must first establish the ticket ID');
      const operation = (kind, params, result) => {
        const call = { kind, params, sessionKey: SESSION, senderId: SENDER_A,
          runId: `run-${SENDER_A}`, toolCallId: `finish-${++createCall}` };
        assert.equal(handleWorkflowCheck(deps, call).decisions[0].would_allow, true);
        return handleWorkflowResult(deps, { ...call, result });
      };
      operation('solution', { ticket_id: Number(w.ticket_id), content: renderSolutionContent(w.data) }, { success: true, solution_id: 100 });
      const result = operation('read', { id: Number(w.ticket_id) }, { id: Number(w.ticket_id), status: 5,
        priority: w.data.priority, itilcategories_id: w.data.category_id,
        name: w.data.title, content: renderTicketContent(w.data), entities_id: w.data.entity_id, counts: { solutions: 1 } });
      assert.equal(result.completed, true);
    },
  };
}

// ---------- 意图与确认词 ----------

test("TEST-01 关键词「新增工单」建立 flow", () => {
  const h = makeHarness();
  const r = h.inbound("帮我把这个新增工单：泰兰尼斯富阳仓库断网");
  assert.equal(r.decision, "FLOW_STARTED");
  assert.equal(h.store.activeInSession(SESSION).length, 1);
  assert.equal(h.store.get(SESSION, SENDER_A).initiator_sender_id, SENDER_A);
});

test("TEST-02 普通讨论/查询消息不建立 flow", () => {
  const h = makeHarness();
  const cases = ["工单怎么录", "查询工单", "看一下工单", "怎么录入工单", "工单录入流程是什么", "今天天气不错", "收到"];
  for (const text of cases) {
    const r = h.inbound(text);
    assert.notEqual(r.decision, "FLOW_STARTED", `不应触发 flow: ${text}`);
  }
  assert.equal(h.store.activeInSession(SESSION).length, 0);
});

test("TEST-14c 确认词边界（保守）", () => {
  for (const t of ["确认", "确认录入", "可以录入", "可以", "录入", "我确认", "确认了"]) {
    assert.equal(isConfirmation(t), true, `应视为确认: ${t}`);
  }
  for (const t of ["好的", "收到", "知道了", "嗯", "OK", "ok", "确认吗？", "不确认", "别录入", "查一下工单"]) {
    assert.equal(isConfirmation(t), false, `不应视为确认: ${t}`);
  }
});

test("TEST-14d 预览文本识别", () => {
  assert.equal(isPreviewText("已匹配到客户「泰兰尼斯」（ID:102），确认录入工单？"), false);
  assert.equal(isPreviewText("待录入工单预览如下……"), false);
  assert.equal(isPreviewText("工单 #95 已创建"), false);
});

// ---------- preflight（第七节/第九节） ----------

test("TEST-03 缺发生时间 preflight FAIL（含占位“待补”/“未知”）", () => {
  for (const occurred_at of ["", "待补", "未知"]) {
    const r = runPreflight({ ...BASE_INPUT, occurred_at });
    assert.equal(r.PREFLIGHT_STATUS, "FAIL");
    assert.ok(r.MISSING_FIELDS.includes("occurred_at"), `occurred_at=${occurred_at}`);
  }
});

test("TEST-04 缺 symptom FAIL", () => {
  const r = runPreflight({ ...BASE_INPUT, symptom: "" });
  assert.equal(r.PREFLIGHT_STATUS, "FAIL");
  assert.ok(r.MISSING_FIELDS.includes("symptom"));
});

test("TEST-05 缺 method FAIL", () => {
  const r = runPreflight({ ...BASE_INPUT, method: "" });
  assert.equal(r.PREFLIGHT_STATUS, "FAIL");
  assert.ok(r.MISSING_FIELDS.includes("method"));
});

test("TEST-06 缺 result 或 result=待确认 FAIL", () => {
  const r1 = runPreflight({ ...BASE_INPUT, result: "" });
  assert.equal(r1.PREFLIGHT_STATUS, "FAIL");
  assert.ok(r1.MISSING_FIELDS.includes("result"));
  const r2 = runPreflight({ ...BASE_INPUT, result: "待确认" });
  assert.equal(r2.PREFLIGHT_STATUS, "FAIL");
  assert.ok(r2.MISSING_FIELDS.includes("result"));
});

test("TEST-07 状态=2 且当前最新进展非空 PASS", () => {
  const r = runPreflight({ ...BASE_INPUT, target_status: 2, result: "当前最新进展：已联系厂商等待备件" });
  assert.equal(r.PREFLIGHT_STATUS, "PASS");
  assert.equal(r.data.target_status, 2);
  assert.ok(renderPreflightText(r).includes("PREFLIGHT_STATUS=PASS"));
});

test("TEST-08 状态非法 FAIL（1/3/4/abc 均不允许）", () => {
  for (const target_status of [4, 1, 3, "abc"]) {
    const r = runPreflight({ ...BASE_INPUT, target_status });
    assert.equal(r.PREFLIGHT_STATUS, "FAIL", `status=${target_status}`);
    assert.ok(r.MISSING_FIELDS.includes("target_status"));
  }
});

// ---------- Shadow Gate（第十/十三节） ----------

test("TEST-09 无 glpi_list_entities 证据 → WOULD_BLOCK ENTITY_NOT_VERIFIED", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.preflight();
  const r = h.create({ entity_id: 102 });
  assert.equal(r.decisions[0].would_block, true);
  assert.equal(r.decisions[0].reason, "ENTITY_NOT_VERIFIED");
});

test("TEST-10 无窄确认证据 → ENTITY_NOT_CONFIRMED；窄确认后 id 不匹配 → ENTITY_MISMATCH（FIX-002）", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.preflight();
  h.lookup();
  // 大列表证据在，但未做单实体窄确认（旧判定会误用截断副本）
  const r0 = h.create({ entity_id: 102 });
  assert.equal(r0.decisions[0].would_block, true);
  assert.equal(r0.decisions[0].reason, "ENTITY_NOT_CONFIRMED");
  h.narrow();
  const r = h.create({ entity_id: 999 });
  assert.equal(r.decisions[0].would_block, true);
  assert.equal(r.decisions[0].reason, "ENTITY_MISMATCH");
});

test("TEST-11 没有预览 → WOULD_BLOCK PREVIEW_NOT_SENT", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.preflight();
  h.lookup();
  h.narrow();
  const r = h.create({ entity_id: 102 });
  assert.equal(r.decisions[0].reason, "PREVIEW_NOT_SENT");
});

test("TEST-12 预览已发但未确认 → WOULD_BLOCK CONFIRMATION_REQUIRED", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.preflight();
  h.lookup();
  h.narrow();
  const pv = h.preview();
  assert.equal(pv.previewRecorded, true);
  assert.equal(h.store.get(SESSION, SENDER_A).preview_sent, true);
  const r = h.create({ entity_id: 102 });
  assert.equal(r.decisions[0].reason, "CONFIRMATION_REQUIRED");
});

test("TEST-13 模型自声称已确认（无真实 message_received 确认）仍 CONFIRMATION_REQUIRED", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.preflight();
  h.lookup();
  h.narrow();
  h.preview();
  // 没有任何真实确认消息，直接 create
  const r = h.create({ entity_id: 102 });
  assert.equal(r.decisions[0].reason, "CONFIRMATION_REQUIRED");
  // confirmed 只能由真实入站确认词设置
  assert.equal(h.store.get(SESSION, SENDER_A).confirmed, false);
});

test("TEST-14 技术员本人确认 → WOULD_ALLOW；解决方案与目标状态回读才完成清 flow", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.preflight();
  h.lookup();
  h.narrow();
  h.preview();
  const c = h.inbound("确认");
  assert.equal(c.decision, "CONFIRMED");
  const flow = h.store.get(SESSION, SENDER_A);
  assert.equal(flow.confirmed, true);
  assert.equal(flow.confirmed_by, SENDER_A);
  assert.ok(flow.confirmation_message_id);
  const r = h.create({ entity_id: 102 });
  assert.equal(r.decisions[0].would_allow, true);
  assert.equal(r.decisions[0].would_block, false);
  assert.equal(r.decisions[0].reason, null);
  // 合同修正：创建回执仅登记 ID，后续解决方案与状态回读完成 flow
  assert.equal(h.complete({ success: true, id: 93 }).completed, false);
  h.finishTarget();
  assert.equal(h.store.get(SESSION, SENDER_A), undefined);
});

test("TEST-14b 非发起人且未配置 ownerSenderIds 的确认被忽略", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网", SENDER_A);
  h.preflight(BASE_INPUT, SENDER_A);
  h.lookup(ENTITY_RESULT, SENDER_A);
  h.narrow({ id: 102, name: "杭州泰潼商贸有限公司" }, SENDER_A);
  h.preview();
  const c = h.inbound("确认", SENDER_B);
  assert.equal(c.decision, "CONFIRM_IGNORED_NOT_AUTHORIZED");
  const r = h.create({ entity_id: 102 }, SENDER_A);
  assert.equal(r.decisions[0].reason, "CONFIRMATION_REQUIRED");
});

test("TEST-20 ownerSenderIds 不可确认他人 Flow（DEV-05 本人确认替代旧规则）", () => {
  const h = makeHarness({ ownerSenderIds: ["ou_boss"] });
  h.inbound("新增工单：泰兰尼斯富阳仓库断网", SENDER_A);
  h.preflight(BASE_INPUT, SENDER_A);
  h.lookup(ENTITY_RESULT, SENDER_A);
  h.narrow({ id: 102, name: "杭州泰潼商贸有限公司" }, SENDER_A);
  h.preview();
  const c = h.inbound("确认录入", "ou_boss");
  assert.equal(c.decision, "CONFIRM_IGNORED_NOT_AUTHORIZED");
  const r = h.create({ entity_id: 102 }, SENDER_A);
  assert.equal(r.decisions[0].would_allow, false);
});

test("TEST-15 上一 flow 的 lookup/窄确认证据不能带入新 flow", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.preflight();
  h.lookup();
  h.narrow();
  h.preview();
  h.inbound("确认");
  const done = h.create({ entity_id: 102 });
  assert.equal(done.decisions[0].would_allow, true);
  assert.equal(h.complete({ success: true, id: 93 }).completed, false);
  h.finishTarget();
  // 新 flow（同 sender）
  h.inbound("再新增工单：理工大学网络故障");
  const flow = h.store.get(SESSION, SENDER_A);
  assert.equal(flow.entity_lookup_ok, false);
  assert.equal(flow.matched_entity_ids.length, 0);
  assert.equal(flow.narrow_entity_id, null);
  assert.equal(flow.confirmed, false);
  h.preflight();
  const r = h.create({ entity_id: 102 });
  assert.equal(r.decisions[0].reason, "ENTITY_NOT_VERIFIED");
});

test("TEST-16 TTL 30 分钟过期清除（fail-closed）", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  assert.equal(h.store.activeInSession(SESSION).length, 1);
  h.tick(30 * 60 * 1000 + 1);
  assert.equal(h.store.get(SESSION, SENDER_A), undefined);
  assert.equal(h.store.activeInSession(SESSION).length, 0);
  const r = h.create({ entity_id: 102 });
  assert.equal(r.decisions[0].reason, "NO_ACTIVE_TICKET_FLOW");
});

test("TEST-17 同群不同 sender 各自持有 1 个 pending flow", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网", SENDER_A);
  h.inbound("新增工单：理工大学网络故障", SENDER_B);
  const flows = h.store.activeInSession(SESSION);
  assert.equal(flows.length, 2);
  assert.equal(h.store.get(SESSION, SENDER_A).initiator_sender_id, SENDER_A);
  assert.equal(h.store.get(SESSION, SENDER_B).initiator_sender_id, SENDER_B);
});

test("TEST-18 同 sender 前一张仍 pending 时拒绝第二个 flow（不无声覆盖）", () => {
  const h = makeHarness();
  const first = h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const firstId = first.flow.flow_id;
  const second = h.inbound("再创建工单：理工大学网络故障");
  assert.equal(second.decision, "PENDING_FLOW_ALREADY_EXISTS");
  const flow = h.store.get(SESSION, SENDER_A);
  assert.equal(flow.flow_id, firstId);
  assert.equal(h.store.activeInSession(SESSION).length, 1);
});

test("TEST-19 Shadow 判定 WOULD_BLOCK 时实际仍放行（shadowAllow=true）", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.preflight();
  h.lookup();
  h.narrow();
  h.preview();
  // 未确认 → WOULD_BLOCK
  const r = h.create({ entity_id: 102 });
  assert.equal(r.decisions[0].would_block, true);
  assert.equal(r.shadowAllow, true, "SHADOW 模式必须放行真实工具调用");
  // flow 未被误清除
  assert.equal(h.store.get(SESSION, SENDER_A) != null, true);
});

// ---------- 补充：工具与注入细节 ----------

test("SUP-01 extractEntityIds 兼容多种返回形态", () => {
  assert.deepEqual(extractEntityIds(ENTITY_RESULT), ["0", "102", "172"]);
  assert.deepEqual(extractEntityIds({ entities: ENTITY_RESULT }), ["0", "102", "172"]);
  assert.deepEqual(extractEntityIds(JSON.stringify(ENTITY_RESULT)), ["0", "102", "172"]);
  assert.deepEqual(
    extractEntityIds({ content: [{ type: "text", text: JSON.stringify(ENTITY_RESULT) }] }),
    ["0", "102", "172"],
  );
  assert.deepEqual(extractEntityIds(null), []);
  assert.deepEqual(extractEntityIds("not json"), []);
  assert.deepEqual(extractEntityIds([{ no_id: true }]), []);
});

test("SUP-02 message_sent success=false 不记录预览", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.preflight();
  h.lookup();
  const r = handleSent(h.deps, {
    sessionKey: SESSION,
    success: false,
    messageId: "om_x",
    content: "已匹配到客户「泰兰尼斯」（ID:102），确认录入工单？",
  });
  assert.equal(r.previewRecorded, false);
  assert.equal(h.store.get(SESSION, SENDER_A).preview_sent, false);
});

test("SUP-03 before_prompt_build 注入 Skill 正文与 sha256 记录", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const r = handlePromptBuild(h.deps, { sessionKey: SESSION, senderId: SENDER_A });
  assert.equal(r.injected, true);
  assert.ok(r.prependContext.includes("GLPI 工单录入流程规则"));
  assert.ok(r.prependContext.includes("flow-1"));
  assert.ok(h.logs.some((line) => line.includes("skill_injected=true")));
  // 无 flow 的 session 不注入
  const r2 = handlePromptBuild(h.deps, { sessionKey: "agent:main:feishu:group:oc_other" });
  assert.equal(r2.injected, false);
});

test("SUP-04 Shadow Gate 判定顺序与 evaluateCreate 短路一致", () => {
  const flow = createFlowStore(60000, () => 1, () => "f").start("s", "u").flow;
  assert.equal(evaluateCreate(flow, {}).reason, "PREFLIGHT_REQUIRED");
  flow.preflight_ok = true;
  assert.equal(evaluateCreate(flow, {}).reason, "ENTITY_NOT_VERIFIED");
  flow.entity_lookup_ok = true;
  assert.equal(evaluateCreate(flow, {}).reason, "ENTITY_NOT_CONFIRMED");
  flow.narrow_entity_id = "102";
  assert.equal(evaluateCreate(flow, {}).reason, "ENTITY_MISMATCH");
  assert.equal(evaluateCreate(flow, { entity_id: "102" }).reason, "PREVIEW_NOT_SENT");
  flow.preview_sent = true;
  assert.equal(evaluateCreate(flow, { entity_id: "102" }).reason, "CONFIRMATION_REQUIRED");
  flow.confirmed = true;
  assert.equal(evaluateCreate(flow, { entity_id: "102" }).reason, "DRAFT_BINDING_REQUIRED");
  assert.equal(evaluateCreate(null, {}).reason, "NO_ACTIVE_TICKET_FLOW");
});

// ---------- Phase1A Flow 门控 factory（CHG-GLPI-TEMPLATE-GATE-001-PHASE1A） ----------

const TOOL_CTX_A = { sessionKey: SESSION, requesterSenderId: SENDER_A };
const TOOL_CTX_B = { sessionKey: SESSION, requesterSenderId: SENDER_B };

test("TEST-F01 工厂 ctx 缺失（undefined/null）→ fail-closed 返回 null", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const factory = createFlowGatedToolFactory(h.deps);
  assert.equal(factory(undefined), null);
  assert.equal(factory(null), null);
});

test("TEST-F02 ctx 缺 sessionKey → null（有 flow 也不暴露）", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const factory = createFlowGatedToolFactory(h.deps);
  assert.equal(factory({ requesterSenderId: SENDER_A }), null);
});

test("TEST-F03 ctx 缺 requesterSenderId → null（cron/心跳等无身份场景 fail-closed）", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const factory = createFlowGatedToolFactory(h.deps);
  assert.equal(factory({ sessionKey: SESSION }), null);
});

test("TEST-F04 身份齐全但无 flow（普通聊天 CASE-A）→ null", () => {
  const h = makeHarness();
  const factory = createFlowGatedToolFactory(h.deps);
  assert.equal(factory({ ...TOOL_CTX_A }), null);
});

test("TEST-F05 有 flow（CASE-B）→ 暴露工具；七项业务输入不变，增加规则推导的必填分类", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const tool = createFlowGatedToolFactory(h.deps)({ ...TOOL_CTX_A });
  assert.ok(tool);
  assert.equal(tool.name, "glpi_ticket_preflight");
  assert.equal(tool.name, PREFLIGHT_TOOL_NAME);
  assert.ok(tool.description.includes("PREFLIGHT_STATUS"));
  assert.equal(Object.keys(tool.parameters.properties).length, 18);
  assert.deepEqual(tool.parameters.required, [
    "customer_name",
    "entity_id",
    "occurred_at",
    "symptom",
    "method",
    "result",
    "assignee_user_id",
    "target_status",
    "title",
    "category_id",
  ]);
  assert.equal(typeof tool.execute, "function");
});

test("TEST-F06 flow 确认闭环（CASE-C）→ 完成清 flow 后不再暴露", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const factory = createFlowGatedToolFactory(h.deps);
  assert.ok(factory({ ...TOOL_CTX_A }));
  h.preflight();
  h.lookup();
  h.narrow();
  h.preview();
  h.inbound("确认");
  const r = h.create({ entity_id: 102 });
  assert.equal(r.decisions[0].would_allow, true);
  assert.equal(h.complete({ success: true, id: 93 }).completed, false);
  h.finishTarget();
  assert.equal(factory({ ...TOOL_CTX_A }), null);
});

test("TEST-F07 TTL 过期 → 不暴露（fail-closed）", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const factory = createFlowGatedToolFactory(h.deps);
  h.tick(30 * 60 * 1000 + 1);
  assert.equal(factory({ ...TOOL_CTX_A }), null);
});

test("TEST-F08 sender/session 隔离：flow 属 A，B 或他 session 的 ctx → null", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网", SENDER_A);
  const factory = createFlowGatedToolFactory(h.deps);
  assert.equal(factory({ ...TOOL_CTX_B }), null);
  assert.equal(factory({ sessionKey: "agent:other:session", requesterSenderId: SENDER_A }), null);
});

test("TEST-F09 身份类型不合规（数字/对象/字符串）→ null 且不抛错", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const factory = createFlowGatedToolFactory(h.deps);
  assert.equal(factory({ sessionKey: 12345, requesterSenderId: SENDER_A }), null);
  assert.equal(factory({ sessionKey: SESSION, requesterSenderId: { id: SENDER_A } }), null);
  assert.equal(factory("not-an-object"), null);
});

test("TEST-F10 flow 处于待确认阶段（已预览未确认）→ 仍暴露", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.preflight();
  h.lookup();
  h.preview();
  const tool = createFlowGatedToolFactory(h.deps)({ ...TOOL_CTX_A });
  assert.ok(tool);
  assert.equal(h.store.get(SESSION, SENDER_A).preview_sent, true);
});

test("TEST-F11 门控查询使用 (sessionKey, requesterSenderId) 精确入参", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const calls = [];
  const realStore = h.deps.store;
  const wrappedStore = {
    ...realStore,
    get: (s, r) => {
      calls.push([s, r]);
      return realStore.get(s, r);
    },
  };
  const factory = createFlowGatedToolFactory({ ...h.deps, store: wrappedStore });
  const tool = factory({ ...TOOL_CTX_A });
  assert.ok(tool);
  assert.deepEqual(calls, [[SESSION, SENDER_A]]);
});

test("TEST-F12 暴露的工具 execute：7 项预检 PASS 且证据回写当前 flow", async () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const tool = createFlowGatedToolFactory(h.deps)({ ...TOOL_CTX_A });
  const result = await tool.execute("call_1", BASE_INPUT);
  assert.equal(result.details.PREFLIGHT_STATUS, "PASS");
  assert.ok(result.content[0].text.startsWith("PREFLIGHT_STATUS=PASS"));
  const flow = h.store.get(SESSION, SENDER_A);
  assert.equal(flow.preflight_ok, true);
  assert.deepEqual(flow.preflight_data, result.details.data);
  assert.equal(createFlowGatedToolFactory(h.deps)({ ...TOOL_CTX_B }), null);
});

test("TEST-F13 进程重启语义：全新 store（Map 清空 CASE-D）→ 不暴露", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const freshStore = createFlowStore();
  const factory = createFlowGatedToolFactory({ ...h.deps, store: freshStore });
  assert.equal(factory({ ...TOOL_CTX_A }), null);
});

// ---------- FIX-GLPI-GATE-ENTITY-EXTRACT-001：entity 提取形态兼容（缺口1，2026-10-01） ----------

const PROD_ENTITY_LIKE = [
  { id: 0, name: "Root entity", entities_id: null, completename: "Root entity", level: 1 },
  {
    id: 2,
    name: "客户A",
    entities_id: "Root entity",
    completename: "Root entity > 客户A",
    level: 2,
    links: [{ rel: "Entity", href: "http://x/Entity/0" }],
  },
  { id: 11, name: "客户B", entities_id: "Root entity", comment: "来源：ERPNext", level: 2 },
];

test("TEST-E01 生产形态：实体数组（含 entities_id/links 字段）正确提取，不误收非 id 字段", () => {
  assert.deepEqual(extractEntityIds(PROD_ENTITY_LIKE), ["0", "2", "11"]);
});

test("TEST-E02 截断 JSON 抢救：无效 JSON 字符串仍提取前部 id（生产 18:37:33 场景）", () => {
  const full = JSON.stringify(PROD_ENTITY_LIKE);
  const cutAt = full.indexOf('{"id":11');
  assert.ok(cutAt > 0);
  const truncated = full.slice(0, cutAt);
  assert.throws(() => JSON.parse(truncated)); // 确认截断后确实不可解析
  assert.deepEqual(extractEntityIds(truncated), ["0", "2"]);
});

test("TEST-E03 数字键对象形态（GLPI range 风格，含 meta 混排）正确提取", () => {
  const map = { "0": { id: 0, name: "Root" }, "2": { id: 2, name: "A" } };
  assert.deepEqual(extractEntityIds(map), ["0", "2"]);
  const withMeta = { totalcount: 2, ...map };
  assert.deepEqual(extractEntityIds(withMeta), ["0", "2"]);
});

test("TEST-E04 {data: 数字键对象} 包裹形态正确提取", () => {
  assert.deepEqual(
    extractEntityIds({ data: { "0": { id: 0, name: "Root" }, "11": { id: 11, name: "B" } } }),
    ["0", "11"],
  );
});

test("TEST-E05 fail-closed 不变：空值/数字/无实体对象 → []", () => {
  assert.deepEqual(extractEntityIds(undefined), []);
  assert.deepEqual(extractEntityIds(42), []);
  assert.deepEqual(extractEntityIds(""), []);
  assert.deepEqual(extractEntityIds({ totalcount: 0 }), []);
});

test("TEST-E06 0 提取时输出形态诊断日志（只记结构不记值）且 fail-closed", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.lookup({ totalcount: 0 });
  assert.ok(
    h.logs.some((l) => l.includes("extract_zero=true") && l.includes("result_type=object")),
  );
  assert.equal(h.store.get(SESSION, SENDER_A).entity_lookup_ok, false);
});

test("TEST-E07 handler 收到 JSON 字符串结果时正确记录 entity 证据（集成）", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.lookup(JSON.stringify(ENTITY_RESULT));
  const flow = h.store.get(SESSION, SENDER_A);
  assert.equal(flow.entity_lookup_ok, true);
  assert.deepEqual(flow.matched_entity_ids, ["0", "102", "172"]);
});

// ---------- CHG-GLPI-GATE-P0-VF-001：可验证反馈（证据链快照，2026-10-01） ----------

test("TEST-V01 preflight 返回 flow_evidence 快照：PASS 后 preflight=OK，next_step 指向 entity", async () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const tool = createFlowGatedToolFactory(h.deps)({ ...TOOL_CTX_A });
  const r = await tool.execute("c1", BASE_INPUT);
  assert.equal(r.details.PREFLIGHT_STATUS, "PASS");
  const ev = r.details.flow_evidence;
  assert.equal(ev.preflight_ok, true);
  assert.equal(ev.entity_lookup_ok, false);
  assert.equal(ev.narrow_confirmed, false);
  assert.equal(ev.preview_sent, false);
  assert.equal(ev.confirmed, false);
  assert.equal(ev.missing_until_allow.length, 4);
  assert.ok(ev.next_step.startsWith("entity"));
});

test("TEST-V02 证据推进后快照收敛：五项全 OK → missing=[]，next_step=EVIDENCE_COMPLETE", async () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.preflight();
  h.lookup();
  h.narrow();
  h.preview();
  h.inbound("确认");
  const tool = createFlowGatedToolFactory(h.deps)({ ...TOOL_CTX_A });
  const r = await tool.execute("c2", BASE_INPUT);
  const ev = r.details.flow_evidence;
  assert.equal(ev.preflight_ok, true);
  assert.equal(ev.entity_lookup_ok, true);
  assert.equal(ev.narrow_confirmed, true);
  assert.equal(ev.preview_sent, true);
  assert.equal(ev.confirmed, true);
  assert.deepEqual(ev.missing_until_allow, []);
  assert.ok(ev.next_step.startsWith("EVIDENCE_COMPLETE"));
});

test("TEST-V03 文本通道可见：返回文本含「证据链快照」与「下一步」行，且向后兼容", async () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const tool = createFlowGatedToolFactory(h.deps)({ ...TOOL_CTX_A });
  const r = await tool.execute("c3", BASE_INPUT);
  assert.ok(r.content[0].text.startsWith("PREFLIGHT_STATUS=PASS"));
  assert.ok(r.content[0].text.includes("证据链快照"));
  assert.ok(r.content[0].text.includes("下一步"));
});

test("TEST-V04 无 flow（TTL 过期/不存在）→ fail-closed 快照，文本仍向后兼容", async () => {
  const h = makeHarness();
  const tool = createPreflightTool(h.deps, { ...TOOL_CTX_A }); // 未 inbound，store 无 flow
  const r = await tool.execute("c4", BASE_INPUT);
  const ev = r.details.flow_evidence;
  assert.equal(ev.flow_id, null);
  assert.deepEqual(ev.missing_until_allow, ["NO_ACTIVE_FLOW"]);
  assert.ok(ev.next_step.startsWith("NO_ACTIVE_FLOW"));
  assert.ok(r.content[0].text.startsWith("PREFLIGHT_STATUS=PASS"));
});

test("TEST-V05 预检 FAIL 后快照 preflight=MISSING，next_step 指回预检", async () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const tool = createFlowGatedToolFactory(h.deps)({ ...TOOL_CTX_A });
  const r = await tool.execute("c5", { ...BASE_INPUT, occurred_at: "" });
  assert.equal(r.details.PREFLIGHT_STATUS, "FAIL");
  const ev = r.details.flow_evidence;
  assert.equal(ev.preflight_ok, false);
  assert.ok(ev.next_step.startsWith("preflight"));
});

// ---------- FIX-GLPI-ENTITY-EVIDENCE-001A：提取诊断观测（缺口3，2026-10-01） ----------

test("DIAG-01 完整 JSON 字符串：parse 成功，status=COMPLETE，无 partial 误报", () => {
  const d = analyzeEntityExtraction(JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]));
  assert.deepEqual(d.ids, ["1", "2", "3"]);
  assert.equal(d.parse_attempted, true);
  assert.equal(d.parse_success, true);
  assert.equal(d.fallback_scan_used, false);
  assert.equal(d.extraction_status, "COMPLETE");
  assert.equal(d.suspected_truncated, false);
});

test("DIAG-02 截断 JSON 字符串：parse 失败正则抢救 2 个 id → PARTIAL_SUSPECTED（SIGNAL-A）", () => {
  const full = JSON.stringify([{ id: 11 }, { id: 12 }, { id: 13 }, { id: 14 }]);
  const truncated = full.slice(0, full.indexOf('"id":13'));
  const d = analyzeEntityExtraction(truncated);
  assert.deepEqual(d.ids, ["11", "12"]);
  assert.equal(d.parse_attempted, true);
  assert.equal(d.parse_success, false);
  assert.equal(d.fallback_scan_used, true);
  assert.equal(d.extraction_status, "PARTIAL_SUSPECTED");
  assert.equal(d.suspected_truncated, true);
  assert.equal(d.diagnostic_reason, "JSON_PARSE_FAILED_WITH_ID_RECOVERY");
});

test("DIAG-03 完全无法解析且无 id → ZERO（extract_zero 行为不变）", () => {
  const d = analyzeEntityExtraction("not json at all");
  assert.equal(d.ids.length, 0);
  assert.equal(d.parse_attempted, true);
  assert.equal(d.parse_success, false);
  assert.equal(d.fallback_scan_used, true);
  assert.equal(d.extraction_status, "ZERO");
  assert.equal(d.diagnostic_reason, "JSON_PARSE_FAILED_NO_ID_RECOVERED");
});

test("DIAG-04 结构化数组仅 2 条：不得仅凭数量判截断 → UNKNOWN + LOW_ITEM_COUNT，禁止 PARTIAL", () => {
  const d = analyzeEntityExtraction([{ id: 11 }, { id: 12 }]);
  assert.deepEqual(d.ids, ["11", "12"]);
  assert.equal(d.extraction_status, "UNKNOWN");
  assert.equal(d.suspected_truncated, false);
  assert.equal(d.item_count_if_known, 2);
  assert.equal(d.note, "LOW_ITEM_COUNT");
});

test("DIAG-05 MCP envelope 内完整 JSON 文本：正确提取且不误报 partial → COMPLETE", () => {
  const env = { content: [{ type: "text", text: JSON.stringify([{ id: 5 }, { id: 6 }]) }] };
  const d = analyzeEntityExtraction(env);
  assert.deepEqual(d.ids, ["5", "6"]);
  assert.equal(d.extraction_status, "COMPLETE");
  assert.equal(d.suspected_truncated, false);
  assert.ok(d.result_shape.includes("content_blocks=1"));
});

test("DIAG-07 fallback 正则重复 id 去重与现状一致", () => {
  const d = analyzeEntityExtraction('[{"id":7},{"id":7},{"id":8},{"id":9},{"id":7');
  assert.deepEqual(d.ids, ["7", "8", "9"]);
  assert.equal(d.extraction_status, "PARTIAL_SUSPECTED");
});

test("DIAG-08 旧接口返回值与修改前一致（全形态硬编码锁定）", () => {
  assert.deepEqual(extractEntityIds(ENTITY_RESULT), ["0", "102", "172"]);
  assert.deepEqual(extractEntityIds({ entities: ENTITY_RESULT }), ["0", "102", "172"]);
  assert.deepEqual(extractEntityIds(JSON.stringify(ENTITY_RESULT)), ["0", "102", "172"]);
  assert.deepEqual(
    extractEntityIds({ content: [{ type: "text", text: JSON.stringify(ENTITY_RESULT) }] }),
    ["0", "102", "172"],
  );
  assert.deepEqual(extractEntityIds(null), []);
  assert.deepEqual(extractEntityIds(""), []);
  assert.deepEqual(extractEntityIds("not json"), []);
  assert.deepEqual(extractEntityIds([{ no_id: true }]), []);
  assert.deepEqual(
    extractEntityIds('[{"id":7},{"id":7},{"id":8},{"id":9},{"id":7'),
    ["7", "8", "9"],
  );
  assert.deepEqual(extractEntityIds({ "0": { id: 0 }, "102": { id: 102 } }), ["0", "102"]);
  assert.deepEqual(
    extractEntityIds({ data: { "0": { id: 0 }, "102": { id: 102 } } }),
    ["0", "102"],
  );
});

test("DIAG-09 窄证据判定（FIX-002 方案B）：截断副本不再参与判定", () => {
  const flow = createFlowStore(60000, () => 1, () => "f").start("s", "u").flow;
  flow.preflight_ok = true;
  flow.entity_lookup_ok = true;
  flow.matched_entity_ids = ["0", "2"]; // 截断副本恢复的部分 id（不含 11）
  flow.preview_sent = true;
  flow.confirmed = true;
  // 无窄证据：不再误判 MISMATCH，也不被部分 id 放行
  assert.equal(evaluateCreate(flow, { entity_id: 11 }).reason, "ENTITY_NOT_CONFIRMED");
  assert.equal(evaluateCreate(flow, { entity_id: "0" }).reason, "ENTITY_NOT_CONFIRMED");
  flow.narrow_entity_id = "11";
  // 窄证据在：11 放行；0/999 仍 MISMATCH
  assert.equal(evaluateCreate(flow, { entity_id: 11 }).reason, "DRAFT_BINDING_REQUIRED");
  assert.equal(evaluateCreate(flow, { entity_id: "0" }).reason, "ENTITY_MISMATCH");
  assert.equal(evaluateCreate(flow, { entity_id: 999 }).reason, "ENTITY_MISMATCH");
});

test("DIAG-10 Shadow WOULD_BLOCK/WOULD_ALLOW 行为不变（含全证据链放行）", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.preflight();
  h.lookup();
  h.narrow();
  h.preview();
  h.inbound("确认");
  const r = h.create({ entity_id: 102 });
  assert.equal(r.decisions[0].would_block, false);
  assert.equal(r.shadowAllow, true);
  const h2 = makeHarness();
  h2.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h2.preflight();
  h2.lookup();
  h2.narrow();
  const r2 = h2.create({ entity_id: 999 });
  assert.equal(r2.decisions[0].reason, "ENTITY_MISMATCH");
  assert.equal(r2.shadowAllow, true);
});

test("DIAG-11 Dynamic Tool Factory 门控不受诊断增强影响", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const tool = createFlowGatedToolFactory(h.deps)({ ...TOOL_CTX_A });
  assert.ok(tool, "有 flow 时必须暴露工具");
  assert.equal(tool.name, PREFLIGHT_TOOL_NAME);
});

test("DIAG-PRIVACY 统一诊断日志不落业务值：无客户名/凭据/id 列表", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.lookup(
    JSON.stringify([{ id: 11, name: "ZZSENTINEL客户名", comment: "Authorization: Bearer zz" }]),
  );
  const diagLines = h.logs.filter((l) => l.includes("event=entity_lookup"));
  assert.ok(diagLines.length >= 1, "必须输出统一诊断日志");
  const joined = diagLines.join("\n");
  assert.ok(!joined.includes("ZZSENTINEL客户名"), "不得含实体/客户名");
  assert.ok(!joined.includes("Authorization"), "不得含凭据");
  assert.ok(!joined.includes("Bearer"), "不得含凭据");
  assert.ok(!joined.includes("ids=["), "不得输出 id 列表");
  assert.ok(diagLines.some((l) => l.includes("extraction_status=")));
  assert.ok(diagLines.some((l) => l.includes("ids_count=1")));
});

// ---------- FIX-GLPI-ENTITY-EVIDENCE-002：方案B 窄证据 + 预览/补齐证据链（2026-10-01） ----------

test("N-01 extractSingleEntityId：单记录形态全兼容，截断/多条 fail-closed", () => {
  assert.equal(extractSingleEntityId({ id: 102, name: "X" }), "102");
  assert.equal(extractSingleEntityId({ id: "11" }), "11");
  assert.equal(extractSingleEntityId(JSON.stringify({ id: 11, name: "X" })), "11");
  assert.equal(
    extractSingleEntityId({ content: [{ type: "text", text: JSON.stringify({ id: 11 }) }] }),
    "11",
  );
  assert.equal(extractSingleEntityId([{ id: 11 }]), "11");
  assert.equal(extractSingleEntityId([{ id: 11 }, { id: 12 }]), null);
  assert.equal(extractSingleEntityId({ totalcount: 0 }), null);
  assert.equal(extractSingleEntityId('{"id":11,"name":"x"'), null);
  assert.equal(extractSingleEntityId("not json"), null);
  assert.equal(extractSingleEntityId(null), null);
});

test("N-02 handleEntityConfirm 集成：窄证据落 flow，日志只记结构不落业务值", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const r = h.narrow({ id: 102, name: "ZZNSENTINEL客户名" });
  assert.equal(r.recorded, true);
  const flow = h.store.get(SESSION, SENDER_A);
  assert.equal(flow.narrow_entity_id, "102");
  assert.ok(flow.narrow_entity_at > 0);
  const lines = h.logs.filter((l) => l.includes("entity_confirm"));
  assert.ok(lines.some((l) => l.includes("narrow_ok=true")), "必须有窄确认日志");
  const joined = lines.join("\n");
  assert.ok(!joined.includes("ZZNSENTINEL客户名"), "不得落实体名");
  assert.ok(!joined.includes("=102"), "不得落窄证据 id 值");
});

test("N-03 窄确认工具错误 → fail-closed 不设证据", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const r = handleEntityConfirm(h.deps, {
    sessionKey: SESSION,
    senderId: SENDER_A,
    result: null,
    error: new Error("x"),
  });
  assert.equal(r.recorded, false);
  assert.equal(h.store.get(SESSION, SENDER_A).narrow_entity_id, null);
});

test("N-04 窄确认截断结果 → fail-closed 清空已设证据（最新一次为准）", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.narrow({ id: 102 });
  const r = h.narrow('{"id":999,"name":"x');
  assert.equal(r.recorded, false);
  assert.equal(h.store.get(SESSION, SENDER_A).narrow_entity_id, null);
});

test("N-05 无活跃 flow 时窄确认不记录", () => {
  const h = makeHarness();
  const r = h.narrow({ id: 102 });
  assert.equal(r.recorded, false);
});

test("N-06 preflight FAIL 阶段缺项提示不是最终预览（DEV-05）", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  // 未 preflight、未 lookup——真实流程预览在缺项索要阶段发出
  const pv = h.preview();
  assert.equal(pv.previewRecorded, false);
  assert.equal(h.store.get(SESSION, SENDER_A).preview_sent, false);
});

test("N-07 结构化补齐、否定、单段回复均不能替代最终本人确认（DEV-05）", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.lookup();
  h.preview();
  const c = h.inbound("1，202610012300，2、远程登录点击测试重启。3、恢复。4、已解决。");
  assert.equal(c.decision, "NONE");
  const flow = h.store.get(SESSION, SENDER_A);
  assert.equal(flow.confirmed, false);
  assert.equal(flow.confirmed_by, null);
  // 否定/疑问/单段：不视为确认
  const h2 = makeHarness();
  h2.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h2.lookup();
  h2.preview();
  assert.notEqual(h2.inbound("1，待确认").decision, "CONFIRMED");
  assert.notEqual(h2.inbound("1，好的，就这样").decision, "CONFIRMED");
  assert.equal(h2.store.get(SESSION, SENDER_A).confirmed, false);
});

test("N-08 补齐回放：FAIL提示→补齐→PASS→窄确认→最终预览→本人确认→WOULD_ALLOW", () => {
  const h = makeHarness();
  h.inbound("录入it工单，客户-个人，内容-测试，进行工单录入测试，技术负责人-李其俊。");
  const full = JSON.stringify(PROD_ENTITY_LIKE);
  h.lookup(full.slice(0, full.indexOf('{"id":11'))); // 截断列表（真实 PARTIAL_SUSPECTED）
  h.preflight({ ...BASE_INPUT, occurred_at: "", method: "", result: "", target_status: 0 }); // 首次预检 FAIL
  h.preview(); // 预览在 FAIL 阶段发出（放宽后登记）
  h.inbound("1，2026-10-01 23:00，2、远程登录点击测试重启。3、恢复。4、已解决。"); // 补齐=确认
  h.preflight(); // 补齐后预检 PASS
  h.narrow({ id: 102, name: "匹配实体" });
  h.preview();
  h.inbound("确认录入");
  const r = h.create({ entity_id: 102 });
  assert.equal(r.decisions[0].would_allow, true);
  assert.equal(r.decisions[0].reason, null);
  assert.equal(h.complete({ success: true, id: 93 }).completed, false);
  h.finishTarget();
  assert.equal(h.store.get(SESSION, SENDER_A), undefined); // 完成清 flow
});

test("N-09 preflight 证据快照含窄确认项：narrow=MISSING→OK 推进可见", async () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const tool = createFlowGatedToolFactory(h.deps)({ ...TOOL_CTX_A });
  const r1 = await tool.execute("n1", BASE_INPUT);
  assert.equal(r1.details.flow_evidence.narrow_confirmed, false);
  assert.ok(
    r1.details.flow_evidence.missing_until_allow.some((m) => m.startsWith("entity_confirm")),
  );
  assert.ok(r1.content[0].text.includes("narrow=MISSING"));
  h.narrow();
  const r2 = await tool.execute("n2", BASE_INPUT);
  assert.equal(r2.details.flow_evidence.narrow_confirmed, true);
  assert.ok(r2.content[0].text.includes("narrow=OK"));
});

// ---------- HARDEN-GLPI-GATE-20261003：gen10 加固回归（老板批准） ----------

test("H-01 单实体包络完整性：isError/多文本块/多记录拒绝", () => {
  assert.equal(
    extractSingleEntityId({ isError: true, content: [{ type: "text", text: '{"id":102}' }] }),
    null,
  );
  assert.equal(
    extractSingleEntityId({
      content: [
        { type: "text", text: '{"id":102}' },
        { type: "text", text: '{"id":999}' },
      ],
    }),
    null,
  );
  assert.equal(extractSingleEntityId([{ id: 102 }, { id: 999 }]), null);
  assert.equal(extractSingleEntityId({ id: "abc" }), null);
  assert.equal(extractSingleEntityId({ content: [{ type: "image", text: "x" }] }), null);
  assert.equal(extractSingleEntityId({ content: [] }), null);
});

test("H-02 窄确认请求-结果 ID 必须一致；别名冲突拒绝；params 缺失 fail-closed", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  const r1 = handleEntityConfirm(h.deps, {
    sessionKey: SESSION,
    senderId: SENDER_A,
    result: { id: 102 },
    params: { id: 999 },
  });
  assert.equal(r1.recorded, false);
  assert.equal(h.store.get(SESSION, SENDER_A).narrow_entity_id, null);
  const r2 = handleEntityConfirm(h.deps, {
    sessionKey: SESSION,
    senderId: SENDER_A,
    result: { id: 102 },
    params: { entity_id: 102, id: 999 },
  });
  assert.equal(r2.recorded, false);
  const r3 = handleEntityConfirm(h.deps, {
    sessionKey: SESSION,
    senderId: SENDER_A,
    result: { id: 102 },
    params: { id: 102 },
  });
  assert.equal(r3.recorded, true);
  assert.equal(h.store.get(SESSION, SENDER_A).narrow_entity_id, "102");
  const r4 = handleEntityConfirm(h.deps, {
    sessionKey: SESSION,
    senderId: SENDER_A,
    result: { id: 102 },
  });
  assert.equal(r4.recorded, false);
  assert.equal(h.store.get(SESSION, SENDER_A).narrow_entity_id, null);
});

test("H-03 严格归属：B 的查库/窄确认改不了 A 的证据；B 建单 NO_ACTIVE_TICKET_FLOW", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网", SENDER_A);
  h.preflight(BASE_INPUT, SENDER_A);
  h.narrow({ id: 102, name: "杭州泰潼商贸有限公司" }, SENDER_A);
  const bLookup = h.lookup(ENTITY_RESULT, SENDER_B);
  assert.equal(bLookup.recorded, false);
  const bNarrow = handleEntityConfirm(h.deps, {
    sessionKey: SESSION,
    senderId: SENDER_B,
    result: { id: 999 },
    params: { id: 999 },
  });
  assert.equal(bNarrow.recorded, false);
  const aFlow = h.store.get(SESSION, SENDER_A);
  assert.equal(aFlow.narrow_entity_id, "102");
  const bCreate = h.create({ entity_id: 999 }, SENDER_B);
  assert.equal(bCreate.decisions[0].reason, "NO_ACTIVE_TICKET_FLOW");
  assert.ok(h.store.get(SESSION, SENDER_A), "A 的 flow 不得被 B 消耗");
});

test("H-04 建单超时：结果未知保留 flow，禁止自动重建", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.preflight();
  h.lookup();
  h.narrow();
  h.preview();
  h.inbound("确认");
  const r = h.create({ entity_id: 102 });
  assert.equal(r.decisions[0].would_allow, true);
  assert.ok(h.store.get(SESSION, SENDER_A), "WOULD_ALLOW 后 flow 保留");
  const failed = h.complete(null, new Error("network"));
  assert.equal(failed.completed, false);
  assert.ok(h.store.get(SESSION, SENDER_A), "失败保留证据");
  const retry = h.create({ entity_id: 102 });
  assert.equal(retry.decisions[0].reason, "CREATE_OUTCOME_UNKNOWN");
  assert.equal(h.store.get(SESSION, SENDER_A).workflow.phase, "CREATE_OUTCOME_UNKNOWN");
});

test("H-05 异常/截断/未关联/零 ID 的建单结果不清 flow", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.preflight();
  h.lookup();
  h.narrow();
  h.preview();
  h.inbound("确认");
  h.create({ entity_id: 102 });
  assert.equal(h.complete({ id: 90 }, null, SENDER_A, SESSION, "other-call").completed, false);
  assert.equal(h.complete('{"id":90').completed, false);
  assert.equal(
    h.complete({ isError: true, content: [{ type: "text", text: '{"id":90}' }] }).completed,
    false,
  );
  assert.ok(h.store.get(SESSION, SENDER_A));
  h.create({ entity_id: 102 });
  assert.equal(h.complete({ id: 0 }).completed, false);
  assert.ok(h.store.get(SESSION, SENDER_A));
});

test("H-06 建单在途去重：CREATE_IN_PROGRESS（影子照旧放行）", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.preflight();
  h.lookup();
  h.narrow();
  h.preview();
  h.inbound("确认");
  const r1 = h.create({ entity_id: 102 });
  assert.equal(r1.decisions[0].would_allow, true);
  const r2 = h.create({ entity_id: 102 });
  assert.equal(r2.decisions[0].reason, "CREATE_IN_PROGRESS");
  assert.equal(r2.shadowAllow, true);
  assert.equal(h.complete({ success: true, id: 90 }).completed, false);
  assert.equal(h.store.get(SESSION, SENDER_A).workflow.ticket_id, "90");
  assert.equal(h.create().decisions[0].reason, "TICKET_ALREADY_CREATED");
});

test("H-07 最小内容绑定：三方不一致 → CONTENT_MISMATCH", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.preflight(BASE_INPUT);
  h.lookup();
  h.narrow({ id: 999 });
  h.preview();
  h.inbound("确认");
  const r = h.create({ entity_id: 999 });
  assert.equal(r.decisions[0].reason, "CONTENT_MISMATCH");
  const h2 = makeHarness();
  h2.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h2.preflight();
  h2.lookup();
  h2.narrow();
  h2.preview();
  h2.inbound("确认");
  const r2 = h2.create({ entity_id: 102, name: "被改过的标题" });
  assert.equal(r2.decisions[0].reason, "CONTENT_MISMATCH");
  const r3 = h2.create({ entity_id: 102, status: 6 });
  assert.equal(r3.decisions[0].reason, "CREATE_STATUS_UNSUPPORTED");
  const r4 = h2.create({ entity_id: 102 });
  assert.equal(r4.decisions[0].would_allow, true);
  h2.complete({ success: true, id: 91 });
});

test("H-08 flow key 防碰撞：'a|b'+'c' 与 'a'+'b|c' 是不同 flow", () => {
  const store = createFlowStore(60000, () => 1, () => "f");
  store.start("a|b", "c");
  store.start("a", "b|c");
  assert.equal(store.flows.size, 2);
});

test("H-09 TTL 边界：到期即过期（>=）", () => {
  let now = 1;
  const store = createFlowStore(10, () => now, () => "f");
  store.start("s", "u");
  now = 11;
  assert.equal(store.get("s", "u"), undefined);
});

test("H-10 占位词扩充与非字符串字段一律 FAIL", () => {
  for (const v of ["待补充", "待填写", "未提供", "尚未提供", "unknown", "UNKNOWN"]) {
    const r = runPreflight({ ...BASE_INPUT, symptom: v });
    assert.equal(r.PREFLIGHT_STATUS, "FAIL", `symptom=${v}`);
  }
  assert.equal(runPreflight({ ...BASE_INPUT, symptom: 42 }).PREFLIGHT_STATUS, "FAIL");
  assert.equal(
    runPreflight({ ...BASE_INPUT, entity_id: Number.MAX_SAFE_INTEGER + 1 }).PREFLIGHT_STATUS,
    "FAIL",
  );
});

test("H-11 意图归一：空格/大小写不影响命中，讨论仍不误触", () => {
  assert.equal(isTicketIntent("录入 IT 工单，客户-个人"), true);
  assert.equal(isTicketIntent("录入it工单"), true);
  assert.equal(isTicketIntent("创建 IT 工单"), true);
  assert.equal(isTicketIntent("怎么 录入工单？"), false);
  assert.equal(isTicketIntent("工单 录入流程是什么"), false);
});

test("H-12 补齐 marker 小数修复：'1、耗时1.5小时' 不再误判两段；补齐仍不等于最终确认（DEV-05）", () => {
  const h = makeHarness();
  h.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h.lookup();
  h.preview();
  assert.equal(isStructuredFillIn("1、耗时1.5小时"), false);
  assert.equal(isStructuredFillIn("1、耗时1.5小时，2、修改处理方法"), true);
  const c = h.inbound("1、耗时1.5小时");
  assert.notEqual(c.decision, "CONFIRMED");
  assert.equal(h.store.get(SESSION, SENDER_A).confirmed, false);
  const h2 = makeHarness();
  h2.inbound("新增工单：泰兰尼斯富阳仓库断网");
  h2.lookup();
  h2.preview();
  const c2 = h2.inbound("1、耗时1.5小时，2、负责人改为李其俊。");
  assert.equal(c2.decision, "NONE");
});

// ---------- GEN11（2026-10-03 老板批准：负责人默认方案A + TTL 2h + 单活跃流归因） ----------

test("G11-01 parseAssigneeDefault 模板解析（含 ID / 无 ID / 不匹配）", () => {
  const d1 = parseAssigneeDefault(
    "负责人（默认=发起人 李其俊，GLPI:7，已核验在职）——回复确认即按此录入",
  );
  assert.equal(d1.name, "李其俊");
  assert.equal(d1.id, "7");
  const d2 = parseAssigneeDefault("负责人（默认=发起人 王帅博）——回复确认即按此录入");
  assert.equal(d2.name, "王帅博");
  assert.equal(d2.id, null);
  assert.equal(parseAssigneeDefault("负责人：李其俊"), null);
  assert.equal(parseAssigneeDefault(null), null);
});

test("G11-02 parseAssigneeNameRef 显式指定与覆盖变体", () => {
  assert.equal(parseAssigneeNameRef("技术负责人-李其俊"), "李其俊");
  assert.equal(parseAssigneeNameRef("负责人-王帅博"), "王帅博");
  assert.equal(parseAssigneeNameRef("负责人：王慧轩，谢谢"), "王慧轩");
  assert.equal(parseAssigneeNameRef("没有指定"), null);
  assert.equal(parseAssigneeNameRef(null), null);
});

test("G11-03 缺项、已拟定、默认负责人话术不能成为最终预览（DEV-05）", () => {
  assert.equal(isPreviewText("还缺 3 项，请补齐（⭐两项不得为空）"), false);
  assert.equal(isPreviewText("已拟定（可直接修改）"), false);
  assert.equal(isPreviewText("负责人（默认=发起人 李其俊，GLPI:7）——回复确认即按此录入"), false);
  assert.equal(isPreviewText("今天天气不错"), false);
});

test("G11-04 sender 缺失 + 会话内单活跃 flow → 不得归属（DEV-03 替代旧回退）", () => {
  const h = makeHarness();
  h.inbound("录入工单，客户-泰兰尼斯，内容-x");
  const r = h.lookup(ENTITY_RESULT, null);
  assert.equal(r.recorded, false);
  assert.equal(h.store.get(SESSION, SENDER_A).entity_lookup_ok, false);
});

test("G11-05 sender 缺失 + 两个活跃 flow → 不归属（同群多发起人隔离保持）", () => {
  const h = makeHarness();
  h.inbound("录入工单，客户-A");
  h.inbound("录入工单，客户-B", SENDER_B);
  const r = h.lookup(ENTITY_RESULT, null);
  assert.equal(r.recorded, false);
  assert.equal(h.store.get(SESSION, SENDER_A).entity_lookup_ok, false);
  assert.equal(h.store.get(SESSION, SENDER_B).entity_lookup_ok, false);
});

test("G11-06 sender 在场但非发起人 → 仍不归属（H-03 边界不变）", () => {
  const h = makeHarness();
  h.inbound("录入工单，客户-A");
  const r = h.lookup(ENTITY_RESULT, SENDER_B);
  assert.equal(r.recorded, false);
});

test("G11-07 默认标注不构成完整预览或负责人授权（DEV-05）", () => {
  const h = makeHarness(); h.inbound("新增工单"); h.preflight();
  const r = handleSent(h.deps, { sessionKey: SESSION, runId: `run-${SENDER_A}`, success: true,
    messageId: "om_p1", content: "负责人（默认=发起人 测试技术员，GLPI:7）——回复确认即按此录入" });
  assert.equal(r.previewRecorded, false);
  assert.equal(h.store.get(SESSION, SENDER_A).assignee_default, null);
});

test("G11-08 修改负责人并称确认仍须重新预检和本人确认（DEV-05）", () => {
  const h = makeHarness(); h.inbound("新增工单"); h.preflight(); h.preview();
  assert.equal(h.inbound("确认").decision, "CONFIRMED");
  assert.equal(h.inbound("负责人-另一技术员，其他确认").decision, "NONE");
  assert.equal(h.store.get(SESSION, SENDER_A).confirmed, false);
  assert.equal(h.store.get(SESSION, SENDER_A).preflight_ok, false);
});

test("G11-09 已确认负责人：提交不一致 ASSIGNEE_MISMATCH；一致放行", () => {
  const h = makeHarness(); h.inbound("新增工单");
  h.preflight({ ...BASE_INPUT, assignee_user_id: 7 }); h.lookup(); h.narrow(); h.preview(); h.inbound("确认");
  assert.equal(h.create({ user_id_assign: 8 }).decisions[0].reason, "ASSIGNEE_MISMATCH");
  assert.equal(h.create({ user_id_assign: 7 }).decisions[0].would_allow, true);
});

test("G11-10 更换负责人后的合法路径需新预检/预览/本人确认（DEV-05）", () => {
  const h = makeHarness(); h.inbound("新增工单"); h.preflight(); h.preview(); h.inbound("确认");
  h.inbound("负责人-另一技术员");
  h.preflight({ ...BASE_INPUT, assignee_user_id: 9 }); h.lookup(); h.narrow();
  assert.equal(h.create().decisions[0].reason, "PREVIEW_NOT_SENT");
  h.preview(); h.inbound("确认");
  assert.equal(h.create().decisions[0].would_allow, true);
});

test("G11-11 指令显式负责人记录（assignee_explicit_name，仅遥测）", () => {
  const h = makeHarness();
  const r = h.inbound("录入工单，客户-个人，内容-x，技术负责人-李其俊");
  assert.equal(r.decision, "FLOW_STARTED");
  assert.equal(r.flow.assignee_explicit_name, "李其俊");
});

test("G11-12 TTL 默认 2h：37.5 分钟仍活跃；过 2h 过期；config/state 同步", () => {
  assert.equal(resolveConfig({}).ttlMs, 2 * 60 * 60 * 1000);
  assert.equal(FLOW_TTL_MS, 2 * 60 * 60 * 1000);
  let clock = 1_000_000;
  const store = createFlowStore(FLOW_TTL_MS, () => clock);
  assert.equal(store.start("s1", "u1").ok, true);
  clock += 37 * 60 * 1000 + 30 * 1000;
  assert.notEqual(store.get("s1", "u1"), undefined);
  clock += 2 * 60 * 60 * 1000;
  assert.equal(store.get("s1", "u1"), undefined);
});
