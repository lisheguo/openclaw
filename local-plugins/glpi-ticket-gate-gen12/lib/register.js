import { WORKFLOW_TOOLS } from "./contract.js";
import { resolveConfig } from "./config.js";
import { createLog, maskId } from "./log.js";
import { createFlowStore } from "./state.js";
import { projectInboundMessage } from "./inbound-replay.js";
import { createSkillReader } from "./skill.js";
import {
  handleInbound,
  handlePreflightCall,
  handlePromptBuild,
  handleSent,
  handleEntityLookup,
  handleEntityConfirm,
  handleCreateCheck,
  handleCreateResult,
  handleWorkflowCheck,
  handleWorkflowResult,
} from "./handlers.js";
import { createFlowGatedToolFactory } from "./tool.js";

// The two optional copies are host projections. Conflicts deny correlation.
export function matchingField(eventValue, contextValue) {
  if (eventValue != null && contextValue != null && eventValue !== contextValue) return undefined;
  const value = eventValue ?? contextValue;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function registerGate(api) {
  const cfg = resolveConfig(api.pluginConfig);
  const log = createLog(api.logger);

  if (cfg.modeConfigured !== "shadow") {
    log.warn(
      "unsupported_mode=true forcing_mode=shadow",
    );
  }
  // GEN12 / R7-1（2026-10-11 老板批准）：显式声明豁免语义，替代此前含糊的 OWNER_BYPASS_BLOCKED 告警。
  // 语义：**无话术豁免**——任何指令文本（含“直接建单/跳过预检”等）都不能跳过证据链；
  // ownerSenderIds 仅用于身份识别与告警消除，**不改变任何判定结果**。只记数量，不记 open_id。
  if (cfg.ownerSenderIds.length > 0) {
    log.info(
      `mode=shadow event=owner_bypass decision=CONFIGURED owners=${cfg.ownerSenderIds.length} semantics=NO_TEXT_EXEMPTION judgment_unchanged=true`,
    );
  } else {
    log.info(
      "mode=shadow event=owner_bypass decision=NOT_CONFIGURED semantics=NO_TEXT_EXEMPTION judgment_unchanged=true",
    );
  }

  const store = createFlowStore(cfg.ttlMs, undefined, undefined, {}, { ttlMs: cfg.identityTtlMs });
  const readSkill = createSkillReader(cfg.skillPath);
  const deps = { cfg, log, store, readSkill };

  // GEN12（R3-B）：身份解析。优先 runtime 注入的 requester；缺失时按会话兜底
  // （identityFallback=off 可即时回退到修复前行为）。兜底命中记一条 info，便于统计残留失败率。
  const resolveIdentity = (ctx) => {
    const id =
      cfg.identityFallback === "off"
        ? { senderId: ctx?.requester?.senderId, source: "requester" }
        : store.resolveTrustedSender(ctx?.sessionKey, ctx?.requester?.senderId);
    if (id.source === "session") {
      log.info(
        `mode=shadow event=identity_fallback source=session session=${maskId(ctx?.sessionKey)} sender=${maskId(id.senderId)}`,
      );
    }
    return id;
  };

  // HOOK-01 message_received：工单意图识别 + flow 建立 + 真实确认识别
  api.on("message_received", (event, ctx) => {
    try {
      const projected = projectInboundMessage(event, ctx);
      if (!projected.input) {
        store.inboundReplay.recordProjectionConflict();
        log.warn(`mode=shadow event=message_received decision=${projected.decision}`);
        return;
      }
      handleInbound(deps, projected.input);
    } catch {
      log.warn(`event=message_received handler_error=HANDLER_FAILED`);
    }
  });

  // HOOK-02 before_prompt_build：有效 flow 时注入 Skill 正文（每次真实读文件）
  api.on("before_prompt_build", (event, ctx) => {
    try {
      const outcome = handlePromptBuild(deps, {
        sessionKey: ctx?.sessionKey,
        senderId: ctx?.senderId,
        runId: ctx?.runId,
        trigger: ctx?.trigger,
      });
      if (outcome.injected) {
        return { prependContext: outcome.prependContext };
      }
      return;
    } catch {
      log.warn(`event=before_prompt_build handler_error=HANDLER_FAILED`);
      return;
    }
  });

  // HOOK-03 message_sent：待录入预览发送成功证据（仅 success===true）
  api.on("message_sent", (event, ctx) => {
    try {
      handleSent(deps, {
        sessionKey: matchingField(event?.sessionKey, ctx?.sessionKey),
        content: typeof event?.content === "string" ? event.content : "",
        messageId: matchingField(event?.messageId, ctx?.messageId),
        runId: matchingField(event?.runId, ctx?.runId),
        success: event?.success === true,
      });
    } catch {
      log.warn(`event=message_sent handler_error=HANDLER_FAILED`);
    }
  });

  // glpi_ticket_preflight 工具：7 项结构化预检（不调 GLPI、不写库、不建单）
  // Phase1A（CHG-GLPI-TEMPLATE-GATE-001-PHASE1A，依据 GATE-GLPI-TOOL-FACTORY-004）：Flow 门控动态暴露
  // ——无 active flow 时 factory 返回 null，schema 不进入本轮工具面（普通聊天零 schema token）；
  // 身份只认 runtime 注入 trusted ctx（sessionKey/requesterSenderId），缺失即 fail-closed 隐藏。
  api.registerTool(createFlowGatedToolFactory(deps), { name: "glpi_ticket_preflight" });

  api.on("before_tool_call", (event, ctx) => {
    try {
      handlePreflightCall(deps, {
        sessionKey: ctx?.sessionKey,
        senderId: ctx?.requester?.senderId,
        runId: matchingField(event?.runId, ctx?.runId),
        toolCallId: matchingField(event?.toolCallId, ctx?.toolCallId),
      });
    } catch {
      log.warn("event=preflight_call handler_error=HANDLER_FAILED");
    }
    // SHADOW_ONLY: no blocking or parameter mutation.
  }, { matcher: ["glpi_ticket_preflight"] });

  // HOOK-04 after_tool_call(matcher=glpi__glpi_list_entities)：本次实时查库证据
  api.on(
    "after_tool_call",
    (event, ctx) => {
      try {
        handleEntityLookup(deps, {
          sessionKey: ctx?.sessionKey,
          senderId: resolveIdentity(ctx).senderId,
          result: event?.result,
          error: event?.error,
        });
      } catch {
        log.warn(`event=after_tool_call handler_error=HANDLER_FAILED`);
      }
    },
    { matcher: [cfg.entityListToolId] },
  );

  // HOOK-04b after_tool_call(matcher=glpi__glpi_get_entity)：单实体窄确认证据（FIX-002 方案B）
  api.on(
    "after_tool_call",
    (event, ctx) => {
      try {
        handleEntityConfirm(deps, {
          sessionKey: ctx?.sessionKey,
          senderId: resolveIdentity(ctx).senderId,
          result: event?.result,
          error: event?.error,
          params: event?.params,
        });
      } catch {
        log.warn(`event=after_tool_call handler_error=HANDLER_FAILED`);
      }
    },
    { matcher: [cfg.entityGetToolId] },
  );

  // HOOK-05 before_tool_call(matcher=glpi__glpi_create_ticket)：Shadow Gate（只记录，永放行）
  api.on(
    "before_tool_call",
    (event, ctx) => {
      try {
        handleCreateCheck(deps, {
          sessionKey: ctx?.sessionKey,
          senderId: ctx?.requester?.senderId,
          params: event?.params,
          toolName: event?.toolName,
          toolCallId: matchingField(event?.toolCallId, ctx?.toolCallId),
          runId: matchingField(event?.runId, ctx?.runId),
        });
        // MODE=SHADOW：无论如何都放行，不 block、不改参数
        return;
      } catch {
        log.warn(`event=before_tool_call handler_error=HANDLER_FAILED`);
        return;
      }
    },
    { matcher: [cfg.createTicketToolId] },
  );

  // HOOK-05b after_tool_call(matcher=glpi__glpi_create_ticket)：建单结果关联（HARDEN-20261003）
  // 关联成功只登记工单 ID；目标状态必须经后续独立回读验证才 complete flow；
  // 未知创建结果保留 Flow 且不建议重建；MODE=SHADOW 不改任何放行行为。
  api.on(
    "after_tool_call",
    (event, ctx) => {
      try {
        handleCreateResult(deps, {
          sessionKey: ctx?.sessionKey,
          senderId: ctx?.requester?.senderId,
          toolCallId: matchingField(event?.toolCallId, ctx?.toolCallId),
          runId: matchingField(event?.runId, ctx?.runId),
          params: event?.params,
          result: event?.result,
          error: event?.error,
        });
      } catch {
        log.warn(`event=after_tool_call handler_error=HANDLER_FAILED`);
      }
    },
    { matcher: [cfg.createTicketToolId] },
  );
  for (const [kind, toolName] of Object.entries(WORKFLOW_TOOLS)) {
    for (const hook of ["before_tool_call", "after_tool_call"]) {
      api.on(hook, (event, ctx) => {
        try {
          const input = {
            kind, sessionKey: ctx?.sessionKey, senderId: resolveIdentity(ctx).senderId,
            runId: matchingField(event?.runId, ctx?.runId),
            toolCallId: matchingField(event?.toolCallId, ctx?.toolCallId),
            params: event?.params, result: event?.result, error: event?.error,
          };
          if (hook === "before_tool_call") handleWorkflowCheck(deps, input);
          else handleWorkflowResult(deps, input);
        } catch {
          log.warn("event=workflow_hook handler_error=HANDLER_FAILED");
        }
        // SHADOW_ONLY: never block, mutate params or execute any GLPI request.
      }, { matcher: [toolName] });
    }
  }

}
