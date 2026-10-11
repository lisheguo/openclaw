# 父环境审阅后的完整 Skill 契约比对

继续 `CHG-GLPI-PHASE2-P0-001-CODEX`、分支 `codex/chg-glpi-phase2-p0-001` 和 [Draft PR #3](https://github.com/lisheguo/glpi-ticket-gate/pull/3)。本报告更新 [上一轮契约报告](contract-6060561318.md) 的“未取得完整 Skill 格式要求”结论；没有新任务、生产操作、合并或部署。

```text
BASE_COMMIT=0fb25894232309f8dd28192a6bb1acff26c39d05
FOLLOWUP_BASE_COMMIT=bd98386375877a5fa9fd517b662a857ce5ee1f3a
IMPLEMENTATION_STATUS=PARTIAL
DEV_01_STATUS=PASS_OFFLINE
DEV_02_STATUS=PARTIAL; sender-less Webchat BLOCKED
DEV_03_STATUS=PASS_OFFLINE
DEV_04_STATUS=BLOCKED; first-turn readiness unchanged
DEV_05_STATUS=PARTIAL; runtime outbound correlation and trusted boss exception BLOCKED
BASELINE_TESTS=425/425 PASS before any edit in this follow-up
FINAL_TESTS=438/438 PASS; fail=0; skip=0; cancel=0; todo=0
SECURITY_BOUNDARY=SHADOW_ONLY
DEPLOYMENT_STATUS=NOT_DEPLOYED
ENFORCE_STATUS=NOT_IMPLEMENTED; ENFORCE_READY=NO
```

## 材料如何取得

**本 Codex 环境没有下载成功 ZIP。** 既有准备步骤返回正常文件元数据和下载传输信息，`isError=false`、不可用项为 0；官方实体化辅助程序在下载步骤退出码为 1，唯一错误是 `library file transfer failed: download failed`。工具未提供 HTTP 状态码、底层异常或明确的路径/权限错误，不能据此认定访问拒绝、网络故障或文件路径为根因。本次没有重新下载、扩大重试、绕过 Library 流程或要求用户重新上传。

**完整契约通过父环境审阅后的文本取得。** 用户/父任务明确报告已经实际读取 REVIEWED ZIP 全部 Skill 和契约，并传递了不含内部身份/IP 示例的核实文本。本实现直接比对这份转述，不能写成“本 Codex 环境读取或验证了 ZIP”。此前因材料不可读而无法比对完整格式要求的阻塞已经解除；具体生产消息/GLPI 返回的格式仍需运行时验证。

父环境报告的取证结果：ZIP `16414` 字节，SHA256 `6a7ee10c4216a46188bfb70d29af512bf51ea74b89d426ddd0d8e32304d254cc`；五个平面安全成员，无路径穿越或符号链接，CRC 全通过，四份内容文件哈希与 MANIFEST 一致。脱敏 Skill SHA256 为 `86be0f344de5d159f4f20529b487e19f199bb718a0927db6b6df6f75e725ca33`，**不是原始 Skill 的历史哈希**。这些校验由父环境完成，本环境未独立重复；只记录必要来源信息，未发布归档、原始成员文件或全文 Skill。

| 证据级别 | 本轮解释 |
| --- | --- |
| SOURCE_CONFIRMED | 固定 MCP 上游源码仍由本环境只读核实；完整 Skill 业务契约由父环境实际审阅后转述取得，按此来源标注。MCP 六工具 schema 与此前评论一致，无正式 OUTPUT_SCHEMA |
| HISTORICAL_OBSERVED | 读到的 MANIFEST 报告约 2026-10-08 21:00 +08 的取证：CLI 9.9 bcfc888、Gateway 9.9、Skill/MCP 3.2.0、gen11 Shadow；历史调用统计也是取证报告事实，并非本环境生产实测 |
| UNKNOWN | 当前 GLPI 版本、初始状态、自动置 5、服务端实际允许的迁移、部署 npm 与上游 commit 一致性、真实 Hook/消息与返回体行为；缺失的 glpi_get_user 契约和唯一身份映射证据 |

`hook_count=0` 仅为声明自省结果，不能解释为运行时没有 Hook。工作流附件建议的广泛标点/HTML 归一化不是已证实的等价定义；没有采纳。附件中“创建总是初始 1”也没有当前生产证明，保持 UNKNOWN。示例 5→6 不是服务器绝对迁移约束的证明；继续采用原评论建议的先观察状态、再验证迁移策略，未声称服务器已接受。

## 比对结论与修正

| 完整 Skill 要求 | 原实现差异 | 当前处理 |
| --- | --- | --- |
| 七项业务输入；现象/方法/结果非空，目标 2 可填当前进展 | 已有预检覆盖 | 保留。没有新增第八项用户必填信息 |
| 问题导向标题，包含相关客户侧上下文 | 标题存在且与最终预览绑定；不判断自然语言质量 | 保留本人最终预览确认；未新增猜测式标题分类器 |
| 三段标题有序，时间及适用设备/地点入正文，无固定全文序列化要求 | 原三段确定性渲染可兼容；此前因无完整材料未能确认此点 | 不更换渲染方式、不强行模糊比对。仅既有行尾/空白/段标题标记等有限排版容忍，业务标点/文本仍精确保留；未宣称支持所有 HTML 变体 |
| 目标 5/6 的解决方案同时包含处理方法和修复结果 | **原方案只绑定 result，有确证缺口** | 新 `renderSolutionContent` 输出两段 method+result；预检文本及 `details.solution_content` 同时提供。对应内容存在于最终预览并由草稿 hash 绑定；缺方法/缺结果/改内容均 WOULD_BLOCK，成功回执也不能替代前置内容证据 |
| 优先级默认 3，明确高低/紧急指令才变化，业务范围 1–5 | 原预检接受任意正整数，仅显示/确认，缺少单独的明确指令证据 | 限 1–5，预览显示等级名称和数值。非默认需本人 host 入站消息 ID 绑定的明确优先级指令；工具参数、他人消息、引文或故障严重程度不能授权。默认 3 也不能覆盖已明确指定的其他值 |
| 类别 1–8，按内容规则推导 | 原 category_id 可缺省，且接受 0 或超范围 | 类别改为代理按已核实映射推导的必填技术参数，范围 1–8；显示名称/ID，进入 hash 并绑定 create.category_id。歧义须澄清，不默认 8，不要求用户额外提供分类作为第八项业务输入 |
| 发生时间不等于解决期限；编号/创建时间由 GLPI 生成 | 原代码未自动映射到 time_to_resolve | 保留并明确参数说明，测试断言没有自动复制。MCP 无独立 source-channel/occurred_at 输入，不发明参数 |
| 完成回复含工单编号、客户/实体 ID、时间、标题、分类、优先级、负责人、状态 | 状态完成守卫已有；没有独立的完成回复内容校验器 | 补充注入指引，只能报告已回读状态，不能猜“已有/新建”实体来源。完成守卫同时验证读回 priority/itilcategories_id 与草稿一致；**这不是对模型最终回复或送达的程序化保证**；未新增消息发送或外部工具 |
| 默认负责人需唯一映射、实时 get_user 且 is_active=1，确认前展示姓名/ID/在职及可覆盖 | 当前只绑定预检指定 ID；没有可靠默认选择/实时在职证据 | 默认路径 **BLOCKED**，工具说明和指引禁止冒充已核验默认。glpi_get_user schema 未提供，不猜造、不硬编码映射。不把普通用户确认某 ID 说成默认映射或在职核验已实现 |
| Entity range 0–200、双向关键词匹配、候选/新建后完整单体回读 | 当前实时列表 + 窄 ID 回读保留；非完整客户选择实现 | 不重构 Entity。不声称范围/名称匹配/创建来源已完整验证；原截断、零提取和延迟旧查询限制保留 |

类别映射：1 网络故障、2 服务器系统、3 安全设备、4 监控设备、5 打印外设、6 新安装部署、7 巡检维护、8 其他。该表来自父环境核实文本，不是对当前 GLPI 下拉数据的在线检查。代理按内容推导，技术员确认完整预览；插件约束取值及内容一致性，不宣称能独立判定任意自然语言的分类正确性。

优先级指令只支持保守的完整消息形式，例如 `优先级：高`、`优先级设置为4` 或 `新增工单，优先级：紧急`，并须有本人的可信 session/sender/message ID。1/极低、2/低、3/中、4/高、5/紧急可映射；问句、否定、引文、附带其他句子的复杂表达不授予覆盖权限。后者保持 BLOCKED 并由快照说明支持形式，不从故障描述推断。新实质输入保守撤销旧优先级指令及最终确认，需重新预检/预览/本人确认；确认本身不撤销或替代明确指令。这是本次授权条件收紧，不是扩大授权。

`category_id` 在插件预检 schema 中从可选变为必填，因此技术必填项由九个增为十个；七项用户业务信息不变，类别仍按规则推导。旧调用方遗漏类别会预检 FAIL，应在后续独立集成验证中适配。其余创建选项仍与草稿绑定。

REST 示例 type=2 与 MCP 默认 type=1 缺少统一业务策略：**没有切换所有工单的 type**，仍沿用已确认 MCP 默认 1；显式类型也必须进预览和 hash。来源规则“飞书指令录入”在本工具无独立参数，不能用未知字段或错误时间字段补位；其生产表达方式需独立确认。

旧 Skill 的“补齐即确认”、老板/公司技术员确认条款不恢复。普通技术员确认本人最终草稿，不引入领导审核。可信老板例外仍无完整可靠身份与指令验证器，独立 BLOCKED。

## 验证、文件与剩余边界

修改前 [425/425 基线](skill-contract-baseline-tests.txt) 通过；最终 [438/438 测试及覆盖率](skill-contract-final-tests.txt) 通过，新增十三项测试；原 240 次首轮调度与 24 次工作流调度继续运行。覆盖率：源码行 **95.15%**、分支 **89.61%**。命令为 `node --test --experimental-test-coverage test/*.test.js`；入口、全部 lib 和测试/support JS 的 `node --check` 通过，`git diff --check` 通过。全程没有实际 MCP/GLPI 请求。

新增/增强覆盖：方法+结果缺项、标点/结果漂移、目标 5/6 结果-only 提交、错参数 after 回调不登记 solution、真实注册 Hook 仍不阻断/不改参数、类别/优先级范围、发生时间不误映射、他人/缺消息 ID/引用优先级不授权、明确高优先级不能被默认 3 覆盖、指令改变后旧确认/续跑失效，以及两人 Flow 隔离。新增四项回读反例覆盖分类/优先级缺失与漂移；回读不匹配不能完成。

| 文件 | 本次差异 |
| --- | --- |
| `lib/contract.js`, `lib/workflow.js` | 共享有序段落解析、解决方案方法+结果校验、回读分类/优先级一致性、优先级指令证据检查及阶段提示 |
| `lib/preflight.js`, `lib/tool.js`, `lib/draft.js` | 类别/优先级取值、必填推导分类、标签展示、solution_content 输出和业务指引 |
| `lib/detect.js`, `lib/handlers.js`, `lib/state.js`, `lib/gate.js` | 保守解析并绑定本人明确优先级指令；草稿变更撤销；创建/续跑授权均核对；日志不输出指令全文或消息 ID |
| `test/phase2-contract-workflow.test.js`, `test/gate.test.js`, `test/phase2-preview.test.js`, `test/support/harness.js` | 修正虚构 fixtures 的 category/solution，保留旧安全断言并新增十三项业务契约回归 |
| README、主报告、前轮报告及本报告/测试记录 | 更新来源层级和真实阻塞，保留本环境下载失败的事实 |

本次逐行差异：`git diff bd98386375877a5fa9fd517b662a857ce5ee1f3a..HEAD`；主报告保留 OpenClaw 9.8→9.9 固定源码审计及全任务 diff。未修改注册 matcher、实体提取、配置、依赖、Core、外部 MCP/Skill。

首轮 Factory/Prompt 可用性、无 sender Webchat、缺可靠出站 run/message 的最终预览及可信老板例外仍 BLOCKED。服务器迁移、实际返回体与 solution 详情证明仍 UNKNOWN；get.status/counts 只与本次同 ID、正确 method+result 的相关 solution 回执联合使用，并要求 priority/itilcategories_id 与确认草稿一致；缺失或漂移不完成，不能替代其他所需证据或提供事务快照。默认负责人、完整实体选择与完成回复程序化校验的边界如上，不得宣称全业务验收通过。

部署前需独立授权的真实集成证据，并审核技术 schema 适配、默认负责人、实体及回复边界，保持 Shadow；本任务不进行生产试验。去重只限进程内有效 Flow，Shadow 不实际阻止写入，REST 绕过不变。

回滚本轮：在独立审查分支按逆序 revert `bd983863...` 之后本轮代码/文档提交，再运行测试；保留其他变更，不 reset main、不自动合并。回滚会恢复已知“解决方案仅结果”及取值/明确指令证据缺口，应继续禁止部署。没有生产变更，不涉及当前生产回滚。发布 SHA、远端一致性及 CI 状态由本次 PR 描述/交付记录；没有 CI 运行不得标为 PASS。
