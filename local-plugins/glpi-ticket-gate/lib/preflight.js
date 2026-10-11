import { CATEGORY_LABELS, PRIORITY_LABELS, CREATE_OPTION_DEFAULTS, CREATE_OPTION_KEYS } from "./contract.js";
const PLACEHOLDER_VALUES = new Set([
  "待补",
  // HARDEN-GLPI-GATE-20261003：占位词扩充（PR#1 吸收）。
  "待补充",
  "待填写",
  "未提供",
  "尚未提供",
  "unknown",
  "未知",
  "待确认",
  "待定",
  "稍后补充",
  "tbd",
  "n/a",
  "none",
  "null",
  "-",
  "—",
  "无",
]);

const ALLOWED_STATUSES = new Set([2, 5, 6]);

function isBlankOrPlaceholder(value) {
  // HARDEN-GLPI-GATE-20261003：非字符串（数字/对象等）一律按缺项处理，不 String() 强转放行。
  if (typeof value !== "string") return true;
  const s = String(value).trim();
  if (!s) return true;
  return PLACEHOLDER_VALUES.has(s.toLowerCase());
}

function parseInteger(value, { min = 0 } = {}) {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  // HARDEN-GLPI-GATE-20261003：isSafeInteger——超出安全整数范围拒绝（防大数精度漂移）。
  if (!Number.isSafeInteger(n) || n < min) return null;
  return n;
}

/**
 * glpi_ticket_preflight 的核心校验（第九节）：
 * 不调用 GLPI、不写库、不建单，仅做 7 项模板字段结构化校验。
 * 状态=2（处理中）时 result 填当前最新进展，同样不得为空。
 */
export function runPreflight(input) {
  const data = input && typeof input === "object" ? input : {};
  const missing = [];
  const add = (field) => {
    if (!missing.includes(field)) missing.push(field);
  };

  if (isBlankOrPlaceholder(data.title)) add("title");
  if (isBlankOrPlaceholder(data.customer_name)) add("customer_name");
  if (parseInteger(data.entity_id, { min: 0 }) == null) add("entity_id");
  if (isBlankOrPlaceholder(data.occurred_at)) add("occurred_at");
  if (isBlankOrPlaceholder(data.symptom)) add("symptom");
  if (isBlankOrPlaceholder(data.method)) add("method");
  if (isBlankOrPlaceholder(data.result)) add("result");
  if (parseInteger(data.assignee_user_id, { min: 1 }) == null) add("assignee_user_id");
  // Derived from the Skill rules, then shown for confirmation; do not silently
  // omit the category or guess "other". This is not an eighth user input item.
  if (!Object.hasOwn(CATEGORY_LABELS, parseInteger(data.category_id, { min: 1 }))) add("category_id");

  const status =
    typeof data.target_status === "number" || typeof data.target_status === "string"
      ? Number(data.target_status)
      : NaN;
  if (!ALLOWED_STATUSES.has(status)) add("target_status");

  const options = { ...CREATE_OPTION_DEFAULTS };
  for (const key of CREATE_OPTION_KEYS) {
    if (data[key] == null) continue;
    if (key === "time_to_resolve") {
      if (isBlankOrPlaceholder(data[key])) add(key);
      else options[key] = data[key].trim();
    } else {
      const value = parseInteger(data[key], { min: 1 });
      if (value == null || (key === "type" && ![1, 2].includes(value)) ||
          (key === "priority" && !Object.hasOwn(PRIORITY_LABELS, value)) ||
          (key === "category_id" && !Object.hasOwn(CATEGORY_LABELS, value))) add(key);
      else options[key] = value;
    }
  }

  if (missing.length > 0) {
    return { PREFLIGHT_STATUS: "FAIL", MISSING_FIELDS: missing, data: null };
  }

  return {
    PREFLIGHT_STATUS: "PASS",
    MISSING_FIELDS: [],
    data: {
      ...options,
      title: String(data.title).trim(),
      customer_name: String(data.customer_name).trim(),
      entity_id: parseInteger(data.entity_id, { min: 0 }),
      occurred_at: String(data.occurred_at).trim(),
      symptom: String(data.symptom).trim(),
      method: String(data.method).trim(),
      result: String(data.result).trim(),
      assignee_user_id: parseInteger(data.assignee_user_id, { min: 1 }),
      target_status: status,
    },
  };
}

export function renderPreflightText(result) {
  const lines = [];
  lines.push(`PREFLIGHT_STATUS=${result.PREFLIGHT_STATUS}`);
  if (result.PREFLIGHT_STATUS === "PASS") {
    const d = result.data;
    lines.push(
      `模板 7 项齐备：客户=${d.customer_name} | entity_id=${d.entity_id} | 发生时间=${d.occurred_at} | 负责人ID=${d.assignee_user_id} | 目标状态=${d.target_status} | 标题=${d.title}`,
    );
    lines.push("三段正文（故障现象/处理方法/修复结果）已齐备，可按 glpi-ticket Skill 生成待录入预览并等待确认。");
  } else {
    lines.push(`MISSING_FIELDS=${JSON.stringify(result.MISSING_FIELDS)}`);
    lines.push("请向指令人补齐以上缺项后再录入（占位文本如“待补/未知/待确认”视为缺项）。");
  }
  return lines.join("\n");
}
