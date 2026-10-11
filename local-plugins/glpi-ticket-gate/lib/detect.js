const TICKET_TRIGGER_KEYWORDS = [
  "新增工单",
  "新建工单",
  "新增加工单",
  "录入工单",
  "创建工单",
  "新增IT工单",
  "录入IT工单",
  "创建IT工单",
  "新建IT工单",
];

const TICKET_ACTION = new RegExp(TICKET_TRIGGER_KEYWORDS.join("|"), "g");
// Classify the action's own clause. A later request to follow ticket rules is
// not evidence that the earlier, explicit creation command was a discussion.
const DISCUSSION_PREFIX = /怎么|如何|怎样|为什么|为何|为啥|是否|能否|查询|查找|搜索|解释|介绍|讨论|咨询|教程|示例|举例|演示|测试|(?:说|写)(?:了|着|过)?(?:要)?$/;
const DENIED_PREFIX = /不要|请勿|无需|不用|取消|禁止|停止|不再|暂不|不想|不允许|没有要求|并非要求|(?:^|请)别|别(?:帮我|给我|为我|替我)?$|不$/;
const DISCUSSION_SUFFIX = /^(?:的)?(?:规则|流程|步骤|模板|格式|插件|功能|命令|按钮|关键词|示例|语句|意图|说明|教程|机制|怎么|如何|是否|是什么|是啥)/;

function isCreationClause(clause, previousClause = "", nextClause = "") {
  for (const match of clause.matchAll(TICKET_ACTION)) {
    const prefix = clause.slice(0, match.index);
    const suffix = clause.slice(match.index + match[0].length);
    if (DISCUSSION_PREFIX.test(prefix) || DENIED_PREFIX.test(prefix)) continue;
    // Punctuation alone must not turn "如何，创建工单" or "不要，新建工单"
    // into a command. An explicit new request can start a separate action.
    if ((DISCUSSION_PREFIX.test(previousClause) || DENIED_PREFIX.test(previousClause)) &&
        !/^(?:请|帮我|请帮我|替我|给我)/.test(prefix)) continue;
    if (DISCUSSION_SUFFIX.test(suffix) || /[?？]|(?:吗|么|呢)[。！!]*$/.test(suffix)) continue;
    // A bare command name followed immediately by a question about it is a
    // discussion ("新建工单，流程是什么"), not the action+customer example.
    if (!prefix && !suffix && /^(?:工单)?(?:规则|流程|步骤|模板|格式|插件|功能)?(?:是什么|是啥|什么意思|怎么|如何|是否)/.test(nextClause)) continue;
    // A quoted command name is not itself an instruction to execute it.
    if (/["“「『']$/.test(prefix) && /^["”」』']/.test(suffix)) continue;
    return true;
  }
  return false;
}

export function isTicketIntent(text) {
  // HARDEN-GLPI-GATE-20261003：IT 大小写归一 + 去空白——"录入 IT 工单"/"录入it工单"统一命中。
  const t = text == null ? "" : String(text).trim().replace(/IT/gi, "IT");
  if (!t) return false;
  const clauses = t.split(/[，,。；;\r\n]+/).map(clause => clause.replace(/\s+/g, "")).filter(Boolean);
  if (clauses.some(clause => /^(?:算了|取消|不用了|不要录了|暂不录入|不要录入)[！!]*$/.test(clause))) return false;
  return clauses.some((clause, index) => isCreationClause(clause, clauses[index - 1], clauses[index + 1]));
}

const CONFIRM_EXACT = new Set([
  "确认",
  "确认录入",
  "可以录入",
  "可以",
  "录入",
  "我确认",
  "确认了",
  "确认吧",
  "可以的",
  "可以录",
  "确认无误",
  "同意",
  "同意录入",
]);

// 保守确认词：模糊/疑问/否定不视为确认（好的/收到/知道了/嗯/OK 天然不含确认词）
const CONFIRM_DENY_HINTS = /吗|呢|么|不|别|取消|再等|再说|如果|暂|查|怎么|什么|哪个|是否|待/;

export function isConfirmation(text) {
  const t = (text == null ? "" : String(text)).replace(/[\s,，。.！!？?、~～"“”']/g, "");
  if (!t) return false;
  if (CONFIRM_DENY_HINTS.test(t)) return false;
  if (CONFIRM_EXACT.has(t)) return true;
  return false;
}

export function isPreviewText(text) {
  const t = text == null ? "" : String(text);
  // Recognition is only a shape check. handleSent additionally requires exact
  // equality to the current complete canonical draft and host run correlation.
  return t.startsWith("待录入工单最终预览\n") &&
    ["标题：", "客户实体ID：", "客户：", "发生时间：", "一、故障现象", "二、故障处理方法", "三、故障修复结果", "负责人ID：", "目标状态："].every(label => t.includes(`\n${label}`)) &&
    /请本人回复“确认录入 [a-f0-9]{16}”/.test(t);
}

// Deliberately narrow, whole-message directive. Questions, quotations, negative
// instructions and priority inferred from fault descriptions grant no override.
// The caller must bind this value to an actual host sender/session/message ID.
export function parsePriorityDirective(text) {
  if (typeof text !== 'string') return null;
  const m = /^(?:新增工单\s*[，,:：]\s*)?优先级\s*(?:[:：=]|设为|设置为)\s*([1-5]|极低|低|中|高|紧急)\s*[。.!！]?$/u.exec(text.trim());
  if (!m) return null;
  return { 极低: 1, 低: 2, 中: 3, 高: 4, 紧急: 5 }[m[1]] ?? Number(m[1]);
}

// GEN11（2026-10-03 老板批准，方案A）：负责人默认机制话术识别。
// 预览固定模板：负责人（默认=发起人 李其俊，GLPI:7，已核验在职）——回复确认即按此录入
export function parseAssigneeDefault(text) {
  if (typeof text !== "string") return null;
  const m =
    /负责人\s*[（(]\s*默认=发起人\s*([^，,）)]+)\s*(?:[，,]\s*GLPI\s*[:：]?\s*(\d+))?/.exec(text);
  const name = m ? (m[1] ?? "").trim() : "";
  if (!name) return null;
  return { name, id: m[2] != null ? m[2] : null };
}

// 显式指定/覆盖：「技术负责人-李其俊」「负责人-王帅博」「负责人：王慧轩」
export function parseAssigneeNameRef(text) {
  if (typeof text !== "string") return null;
  const m = /(?:技术)?负责人\s*[-—:：]\s*([^\s，,。.；;、！!？?]+)/.exec(text);
  const name = m ? (m[1] ?? "").trim() : "";
  return name || null;
}

// Legacy shape utility retained for compatibility only. Structured fill-in is
// input that may edit a draft; it never grants confirmation in handleInbound.
const FILLIN_MARKER_CJK_RE = /\d+\s*[，、,]/g;
const FILLIN_MARKER_DOT_RE = /\d+\s*[．.](?!\d)/g;

export function isStructuredFillIn(text) {
  const t = text == null ? "" : String(text).trim();
  if (!t) return false;
  if (!/^[1-9][0-9]*\s*[，、,．.]/.test(t)) return false;
  if (CONFIRM_DENY_HINTS.test(t)) return false;
  const cjk = t.match(FILLIN_MARKER_CJK_RE);
  const dots = t.match(FILLIN_MARKER_DOT_RE);
  return (cjk?.length ?? 0) + (dots?.length ?? 0) >= 2;
}
