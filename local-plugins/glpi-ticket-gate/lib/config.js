export const DEFAULT_SKILL_PATH = "/data/openclaw/workspace/skills/glpi-ticket/SKILL.md";
// GEN11（2026-10-03 老板批准）：30min→2h——2026-10-03 工单#94 真实流量显示
// 老板从发起到补齐确认间隔 37.5min，30min TTL 在确认前即过期（证据链断）。
export const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_ENTITY_LIST_TOOL_ID = "glpi__glpi_list_entities";
export const DEFAULT_ENTITY_GET_TOOL_ID = "glpi__glpi_get_entity";
export const DEFAULT_CREATE_TICKET_TOOL_ID = "glpi__glpi_create_ticket";

export function resolveConfig(pluginConfig) {
  const cfg = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
  const ownerSenderIds = Array.isArray(cfg.ownerSenderIds)
    ? cfg.ownerSenderIds.filter((id) => typeof id === "string" && id.trim().length > 0)
    : [];
  const skillPath =
    typeof cfg.skillPath === "string" && cfg.skillPath.trim() ? cfg.skillPath.trim() : DEFAULT_SKILL_PATH;
  const ttlMs =
    typeof cfg.ttlMs === "number" && Number.isFinite(cfg.ttlMs) && cfg.ttlMs > 0 ? cfg.ttlMs : DEFAULT_TTL_MS;
  const entityListToolId =
    typeof cfg.entityListToolId === "string" && cfg.entityListToolId.trim()
      ? cfg.entityListToolId.trim()
      : DEFAULT_ENTITY_LIST_TOOL_ID;
  const createTicketToolId =
    typeof cfg.createTicketToolId === "string" && cfg.createTicketToolId.trim()
      ? cfg.createTicketToolId.trim()
      : DEFAULT_CREATE_TICKET_TOOL_ID;
  const entityGetToolId =
    typeof cfg.entityGetToolId === "string" && cfg.entityGetToolId.trim()
      ? cfg.entityGetToolId.trim()
      : DEFAULT_ENTITY_GET_TOOL_ID;
  const modeConfigured = typeof cfg.mode === "string" && cfg.mode.trim() ? cfg.mode.trim() : "shadow";
  return {
    // Phase1 只有 shadow；ENFORCE 必须另立任务批准
    mode: "shadow",
    modeConfigured,
    ownerSenderIds,
    skillPath,
    ttlMs,
    entityListToolId,
    entityGetToolId,
    createTicketToolId,
  };
}