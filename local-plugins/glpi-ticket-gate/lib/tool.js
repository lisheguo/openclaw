import { workflowEvidence } from "./workflow.js";
import { CATEGORY_LABELS, CREATE_OPTION_KEYS, buildCreateParams, priorityInstructionMatches, renderSolutionContent } from "./contract.js";
import { renderFinalPreview, renderTicketContent } from "./draft.js";
import { runPreflight, renderPreflightText } from "./preflight.js";
import { recordPreflightEvidence } from "./handlers.js";
import { maskId } from "./log.js";

export const PREFLIGHT_TOOL_NAME = "glpi_ticket_preflight";

/**
 * P0 可验证反馈（CHG-GLPI-GATE-P0-VF-001，2026-10-01 老板批准）：
 * 论文「runtime state 可程序化验证」落地——每次预检返回当前 flow 的证据链快照
 * （preflight/entity/preview/confirmed 四项 + 距 WOULD_ALLOW 还缺什么 + 下一步），
 * 模型不靠猜、直接看到「下一步必须走最终预览+真实确认」，对症补齐后直建单类跳步。
 * 只读快照，不改变 gate 判定语义；schema/描述不变，向后兼容。
 */
export function composeFlowEvidence(flow) {
  if (flow == null) {
    return {
      flow_id: null,
      preflight_ok: false,
      entity_lookup_ok: false,
      narrow_confirmed: false,
      preview_sent: false,
      confirmed: false,
      missing_until_allow: ["NO_ACTIVE_FLOW"],
      next_step: "NO_ACTIVE_FLOW——flow 已过期或不存在，请让指令人重新发起工单流程",
    };
  }
  const missing = [];
  if (flow.preflight_ok !== true) missing.push("preflight：7 项预检需 PASS");
  if (flow.entity_lookup_ok !== true)
    missing.push("entity：需本次 glpi_list_entities 实时查库命中客户实体");
  if (flow.narrow_entity_id == null)
    missing.push(
      "entity_confirm：需 glpi_get_entity 窄确认（建单实体 ID 必须来自本流程单实体实时查询）",
    );
  if (flow.preview_sent !== true) missing.push("preview：需在会话中发出待录入预览并送达");
  if (flow.confirmed !== true)
    missing.push("confirm：需指令人回复真实确认词（勿代替用户确认）");
  if (flow.preflight_ok && !priorityInstructionMatches(flow))
    missing.push("priority：需发起人的明确优先级指令与预检一致（支持如“优先级：高”），随后重新预检和本人确认");
  return {
    workflow: workflowEvidence(flow),
    flow_id: flow.flow_id,
    preflight_ok: flow.preflight_ok === true,
    entity_lookup_ok: flow.entity_lookup_ok === true,
    narrow_confirmed: flow.narrow_entity_id != null,
    preview_sent: flow.preview_sent === true,
    confirmed: flow.confirmed === true,
    missing_until_allow: missing,
    next_step:
      flow.workflow?.phase !== "DRAFT"
        ? workflowEvidence(flow).next_step
        : missing.length === 0
        ? "EVIDENCE_COMPLETE——创建前证据齐备；创建不等于完成，须绑定工单ID并回读验证目标状态"
        : missing[0],
  };
}

/**
 * glpi_ticket_preflight 工具定义（7 项结构化预检；不调 GLPI、不写库、不建单）。
 * 保留七项用户业务输入；类别为规则推导后必填的创建参数，其余选项绑定；execute 记录 preflight 证据到
 * 当前 flow（身份取 runtime 注入的工厂 ctx：sessionKey/requesterSenderId，非模型参数）。
 */
export function createPreflightTool(deps, toolContext, boundFlow = deps.store.get(toolContext?.sessionKey, toolContext?.requesterSenderId)) {
  return {
    name: PREFLIGHT_TOOL_NAME,
    description:
      "GLPI 工单模板 7 项预检：客户/发生时间/故障现象/处理方法/修复结果(或最新进展)/负责人/状态(2=处理中,5=已解决,6=已关闭)。返回 PREFLIGHT_STATUS=PASS 或 FAIL+MISSING_FIELDS。仅结构化校验，不调用 GLPI、不写库、不创建工单。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        customer_name: { type: "string", description: "客户名（用于本次实时查库匹配）" },
        entity_id: { type: "number", description: "客户实体 ID（来自本次 glpi_list_entities 实时查询匹配结果）" },
        occurred_at: { type: "string", description: "故障/需求发生时间" },
        symptom: { type: "string", description: "故障现象：什么坏了/什么异常、何时何地" },
        method: { type: "string", description: "故障处理方法：做了什么处理" },
        result: { type: "string", description: "修复结果（状态=2 时填当前最新进展），不得为空" },
        assignee_user_id: { type: "number", description: "明确指定的工单负责人 user ID；默认发起人映射/实时在职验证缺少契约时 BLOCKED，不得猜测" },
        target_status: { type: "number", description: "目标状态：2=处理中 / 5=已解决 / 6=已关闭" },
        title: { type: "string", description: "工单标题（一句话问题导向概括）" },
        ...Object.fromEntries(CREATE_OPTION_KEYS.map(key => [key, {
          type: key === "time_to_resolve" ? "string" : "number",
          description: "可选创建参数；须来自业务规则并与预览绑定，不得猜测。priority默认3、urgency默认3、type默认1。",
        }])),
        category_id: { type: "number", enum: [1, 2, 3, 4, 5, 6, 7, 8],
          description: `按内容推导的必填分类并展示确认：${JSON.stringify(CATEGORY_LABELS)}；歧义先澄清，不默认其他；不是第八项用户信息` },
        priority: { type: "number", enum: [1, 2, 3, 4, 5],
          description: "默认3中；1极低/2低/4高/5紧急。非默认值须本人的明确优先级指令证据，不能由工具参数或故障描述推断授权" },
        time_to_resolve: { type: "string", description: "可选解决期限，不是发生时间；发生时间仅写入正文" },
      },
      required: [
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
      ],
    },
    async execute(_id, params) {
      const preflightResult = runPreflight(params);
      let flow = null;
      try {
        toolContext?.assertInvocationCurrent?.();
        const recorded = recordPreflightEvidence(deps, {
          sessionKey: toolContext?.sessionKey,
          senderId: toolContext?.requesterSenderId,
          result: preflightResult,
          toolCallId: _id,
          expectedFlow: boundFlow ?? {},
        });
        const sk = typeof toolContext?.sessionKey === "string" ? toolContext.sessionKey : "";
        const sid =
          typeof toolContext?.requesterSenderId === "string" ? toolContext.requesterSenderId : "";
        if (recorded.recorded && sk && sid) flow = deps.store.get(sk, sid) ?? null;
      } catch (error) {
        deps.log.warn("event=preflight_tool handler_error=HANDLER_FAILED");
      }
      const flowEvidence = composeFlowEvidence(flow);
      const evidenceLine =
        `证据链快照：preflight=${flowEvidence.preflight_ok ? "OK" : "MISSING"}` +
        ` entity=${flowEvidence.entity_lookup_ok ? "OK" : "MISSING"}` +
        ` narrow=${flowEvidence.narrow_confirmed ? "OK" : "MISSING"}` +
        ` preview=${flowEvidence.preview_sent ? "OK" : "MISSING"}` +
        ` confirm=${flowEvidence.confirmed ? "OK" : "MISSING"}\n下一步：${flowEvidence.next_step}`;
      const remaining =
        flowEvidence.missing_until_allow.length > 1
          ? `\n剩余缺项：${flowEvidence.missing_until_allow.slice(1).join("；")}`
          : "";
      const workflow = flowEvidence.workflow;
      const workflowLine = workflow && workflow.phase !== "DRAFT"
        ? `\n流程阶段=${workflow.phase}；工单ID=${workflow.ticket_id ?? "未知，请先核对创建结果，勿重建"}；` +
          `目标状态=${workflow.target_status}；回读状态=${workflow.observed_status ?? "尚未取得"}；` +
          `解决方案回执=${workflow.solution_recorded ? "已取得" : "未取得"}；服务器迁移规则=UNKNOWN（须另行验证）`
        : "";
      const solutionContent = flow?.preflight_ok && [5, 6].includes(flow.preflight_data.target_status)
        ? renderSolutionContent(flow.preflight_data) : null;
      return {
        content: [
          {
            type: "text",
            text: `${renderPreflightText(preflightResult)}\n${evidenceLine}${remaining}${workflowLine}` +
              (solutionContent ? `\n后续解决方案内容（solution_content，须绑定同一工单）：\n${solutionContent}` : "") +
              (flow?.draft ? `\n最终预览请原样发送；字段变更须重新预检和本人确认：\n${renderFinalPreview(flow)}` : ""),
          },
        ],
        details: {
          ...preflightResult, flow_evidence: flowEvidence,
          final_preview: renderFinalPreview(flow),
          create_content: flow?.preflight_ok ? renderTicketContent(flow.preflight_data) : null,
          create_params: flow?.preflight_ok && flow.workflow?.phase === "DRAFT" ? buildCreateParams(flow.preflight_data) : null,
          solution_content: solutionContent,
        },
      };
    },
  };
}

/**
 * Phase1A Flow 门控 factory（CHG-GLPI-TEMPLATE-GATE-001-PHASE1A；依据 GATE-GLPI-TOOL-FACTORY-004）：
 * - 工具面组装时逐轮求值：无 active flow → 返回 null → schema 不进入本轮工具面（普通聊天零 schema token）
 * - 身份只认 runtime 注入的 trusted ctx（sessionKey/requesterSenderId）；缺失/类型不符 → fail-closed 返回 null
 * - flow 完成/TTL 过期/进程重启清空 → 自然不暴露（CASE-C/D）
 * - 无 flow 时静默返回（host 侧已有 debug 日志）；有 flow 时记 EXPOSE_TOOL 证据，便于 shadow 观察
 * - 不改 Core；MODE=SHADOW 判定与 hook 证据链不受影响
 */
export function createFlowGatedToolFactory(deps) {
  const { store, log } = deps;
  return function flowGatedToolFactory(toolContext) {
    const sessionKey =
      toolContext != null && typeof toolContext.sessionKey === "string" ? toolContext.sessionKey : "";
    const requesterSenderId =
      toolContext != null && typeof toolContext.requesterSenderId === "string"
        ? toolContext.requesterSenderId
        : "";
    if (!sessionKey || !requesterSenderId) return null;
    const flow = store.get(sessionKey, requesterSenderId);
    if (!flow) return null;
    log.info(
      `mode=shadow flow=${flow.flow_id} event=tool_factory decision=EXPOSE_TOOL session=${maskId(sessionKey)} sender=${maskId(requesterSenderId)}`,
    );
    return createPreflightTool(deps, toolContext, flow);
  };
}
