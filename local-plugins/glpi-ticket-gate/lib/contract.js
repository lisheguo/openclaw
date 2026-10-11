// MCP v3.2.0, pinned upstream aebd3db81830c034f3785a327f66567c141584c5.
// Server transition behavior is NOT established by these argument definitions.
export const WORKFLOW_TOOLS = Object.freeze({
  solution: 'glpi__glpi_add_solution', update: 'glpi__glpi_update_ticket', read: 'glpi__glpi_get_ticket',
});
export const CREATE_OPTION_DEFAULTS = Object.freeze({ priority: 3, urgency: 3, type: 1 });
// Business rules relayed after the parent environment reviewed the complete
// sanitized Skill. These labels do not prove runtime dropdown configuration.
export const PRIORITY_LABELS = Object.freeze({ 1: '极低', 2: '低', 3: '中', 4: '高', 5: '紧急' });
export const CATEGORY_LABELS = Object.freeze({ 1: '网络故障', 2: '服务器系统', 3: '安全设备',
  4: '监控设备', 5: '打印外设', 6: '新安装部署', 7: '巡检维护', 8: '其他' });
export const CREATE_OPTION_KEYS = Object.freeze([
  'priority', 'urgency', 'type', 'impact', 'category_id', 'group_id_assign',
  'requester_user_id', 'requester_group_id', 'time_to_resolve',
]);
export function normalizeLines(text) {
  return typeof text === 'string'
    ? text.replace(/\r\n?/g, '\n').split('\n').map(s => s.trim()).filter(Boolean).join('\n') : null;
}
const HEADINGS = ['一、故障现象', '二、故障处理方法', '三、故障修复结果'];
export function renderSolutionContent(data) {
  return `${HEADINGS[1]}\n${data.method}\n\n${HEADINGS[2]}\n${data.result}`;
}
export function renderTicketContent(data) {
  return `${HEADINGS[0]}\n发生时间：${data.occurred_at}\n${data.symptom}\n\n${renderSolutionContent(data)}`;
}
// Only presentation changes are ignored: line endings, blank lines, outer line
// whitespace and optional Markdown heading markers/colon. Business text is exact.
function parseSections(content, headings) {
  if (typeof content !== 'string') return null;
  const lines = normalizeLines(content).split('\n');
  const sections = []; let section = null;
  for (const line of lines) {
    const heading = line.replace(/^#{1,6}\s+/, '').replace(/[:：]$/, '').trim();
    const index = headings.indexOf(heading);
    if (index !== -1) {
      if (index !== sections.length) return null;
      section = []; sections.push(section);
    } else if (section) section.push(line);
    else return null;
  }
  return sections.length === headings.length ? sections : null;
}
export function solutionContentMatches(content, data) {
  const sections = parseSections(content, HEADINGS.slice(1));
  return !!data && sections != null && sections[0].join('\n') === normalizeLines(data.method) &&
    sections[1].join('\n') === normalizeLines(data.result);
}
export function ticketContentMatches(content, data) {
  const sections = parseSections(content, HEADINGS);
  if (!data || !sections) return false;
  // Customer is already bound in preview/entity evidence. When separately
  // included in the first body section, its value must still match exactly.
  if (sections[0][0] === `客户：${data.customer_name}`) sections[0].shift();
  return sections[0].join('\n') === normalizeLines(`发生时间：${data.occurred_at}\n${data.symptom}`) &&
    sections[1].join('\n') === normalizeLines(data.method) &&
    sections[2].join('\n') === normalizeLines(data.result);
}
export function priorityInstructionMatches(flow) {
  const value = flow.preflight_data?.priority;
  if (flow.priority_instruction == null) return value === 3;
  return flow.priority_instruction.value === value &&
    typeof flow.priority_instruction.message_id === 'string' && flow.priority_instruction.message_id.trim().length > 0;
}
export function buildCreateParams(data) {
  const params = { name: data.title, content: renderTicketContent(data),
    entity_id: data.entity_id, user_id_assign: data.assignee_user_id,
    ...CREATE_OPTION_DEFAULTS };
  for (const key of CREATE_OPTION_KEYS) if (data[key] != null) params[key] = data[key];
  return params; // target_status belongs to workflow, never create args.
}
export function createParamsMatch(params, data) {
  const expected = buildCreateParams(data);
  if (!params || Object.keys(params).some(k => !Object.hasOwn(expected, k))) return false;
  if (!ticketContentMatches(params.content, data)) return false;
  return Object.keys(expected).filter(k => k !== 'content').every(k => {
    // Only defaults actually implemented by MCP may be omitted; priority=3 must
    // be explicit per the business contract, as MCP has no default for it.
    const actual = params[k] ?? (k === 'urgency' ? 3 : k === 'type' ? 1 : undefined);
    return actual === expected[k];
  });
}
export function positiveId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (!/^\d+$/.test(String(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
}
// Narrow MCP JSON envelope only. No truncated scanning, first-block guessing,
// multi-record selection or truthy success/status coercion for workflow evidence.
export function unwrapResult(value, depth = 0) {
  if (depth > 6) return null;
  if (typeof value === 'string') {
    try { return unwrapResult(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.isError === true) return null;
  if (Object.hasOwn(value, 'content') && Array.isArray(value.content)) {
    if (value.content.length !== 1 || value.content[0]?.type !== 'text') return null;
    return unwrapResult(value.content[0].text, depth + 1);
  }
  return value;
}
export function stableKey(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(v => JSON.parse(stableKey(v))));
  if (value && typeof value === 'object') {
    return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(stableKey(value[k]))])));
  }
  return JSON.stringify(value ?? null);
}
