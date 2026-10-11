# CHG-GLPI-PHASE2-INBOUND-REPLAY-001

后续 [CHG-GLPI-REPLAY-RETENTION-002](../replay-retention-002/REPORT.md) 仅增加容量观测并完成治理设计，未改变本报告的 receipt 身份、留存和 fail-closed 规则。以下测试数字为本轮历史基线；最新数字见后续报告。

**ACCEPT-11=PASS；FIRST_TURN_STATUS=BLOCKED；ENFORCE_READY=NO。** 本轮只修复同一原生入站消息重复到达后错误撤销已有 Flow 证据的问题。原 `message_received` 仍是唯一入站业务状态修改 Hook；没有正式接入 before_dispatch，也没有修复首轮 Factory/Skill 时序。

## 基准和范围

- 需求：[评论 #6063937429](https://github.com/lisheguo/glpi-ticket-gate/pull/3#issuecomment-6063937429)，全文更新时间 `2026-10-08T16:02:46Z`。
- `BASE_COMMIT=bb087241a11fcc56dc684b2b5343a117887a2265`；原分支 `codex/chg-glpi-phase2-p0-001`、原 Draft PR #3。开工工作树干净、本地/远端一致；发布前再次核对远端，未覆盖并行提交。
- 固定官方参考：OpenClaw v2026.9.9 / `bcfc88812a35243893585dbeca87ca41b48272ca`。未发现适用 AGENTS.md/checkout skill。未安装/启动生产或完整 OpenClaw 环境。
- **修改前**已执行原 [472/472 单元](baseline-unit.txt) 与 [40/40 官方组件](baseline-component.txt)，失败 0，均 exit 0。
- 仅改本仓库插件、测试和开发文档。未改变 manifest/依赖、Core/dist/node_modules、MCP/Skill、生产配置或 Gateway；无生产 GLPI 操作、合并、部署、reload 或 Enforce。

## 宿主契约与入口

固定 [hook-message.types.ts:60](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/plugins/hook-message.types.ts#L60) 的 MessageContext 提供 channelId，及可选 accountId/conversationId/sessionKey/senderId/messageId/reply fields。event 提供结构化 messageId/senderId/sessionKey、正文及 reply/thread fields；channel/account/conversation 的本次权威来源是 **context**，不从 metadata/from/昵称/正文读取身份。

固定 [mapper:88](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/hooks/message-hook-mappers.ts#L88) 从原生 MessageSidFull/MessageSid/MessageSidFirst/MessageSidLast 投影 messageId，从 SenderId 投影 sender。[toPluginMessageContext](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/hooks/message-hook-mappers.ts#L328) 与 [toPluginMessageReceivedEvent](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/hooks/message-hook-mappers.ts#L493) 将这些值交给 [fire-and-forget emitter](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/auto-reply/reply/message-received-hooks.ts)。本修复不将 messageId 与 runId 等同。

`projectInboundMessage` 验证 event/context 的同名身份、reply 字段；任何不同的非空副本返回 `IDENTITY_OR_LINK_CONFLICT`，在调用业务 handler 前退出。正式 scope 字段取 ctx；不允许 event 的额外同名/channel 字段覆盖或与之冲突。必需 channelId/sessionKey/senderId 为非空字符串，messageId 必须是非空原生字符串；长度上限 4096。可选 account/conversation 如存在也须有效；未提供按 null 纳入作用域，不猜默认账户。

此契约的字段映射为 SOURCE_CONFIRMED，新增测试中真实 builder/finalizer/mapper/emitter/registrar/Hook Runner 的执行为 COMPONENT_VERIFIED。所有测试 ID/账户/送达事实均明确是 synthetic；真实飞书 transport 认证、完整 loader 和运行时字段可用性仍未做生产验收。

## 同步 replay guard

[lib/inbound-replay.js](../../lib/inbound-replay.js) 为每个 FlowStore 实例创建独立 ledger，放在 Flow Map 之外。`handleInbound` 先经过 guard，再调用原同步业务逻辑。没有第二个状态修改 Hook，没有异步 I/O/await/sleep，没有独立数据库。

1. key 是 SHA-256(JSON `[channelId, accountId|null, conversationId|null, sessionKey, senderId, nativeMessageId]`)。正文、显示名、群 session、唯一 Flow、runId、时间窗口都不能提供或替代消息身份。
2. digest 是 SHA-256(JSON `[text, replyToId|null, replyToIdFull|null, replyToBody|null, replyToSender|null, replyToIsQuote|null, threadId|null]`)。这些值先形成不可变快照。未用于入站业务的 runId/时间戳、媒体/显示信息不授予身份；以后若业务消费新的入站字段，必须同时审查 digest 契约。
3. 首次有效、可处理的消息，在**任何 Flow 读取之前**登记冻结 receipt，再同步执行 handler。JS 同一调用栈内没有 await；在途重入已能看到 receipt。正文/摘要不进入日志，ledger 仅持有 key/digest；业务快照只在本次同步处理期间存在。
4. 同 key 同 digest 返回 `DUPLICATE_IGNORED`；同 key 异 digest 返回 `MESSAGE_ID_CONFLICT`，不替换原摘要或业务证据。两者都不触发 store.get、TTL purge、invalidateDraft、预检、预览、确认、优先级或 workflow 修改。
5. 新原生 ID 仍是新输入，哪怕正文相同。原有“实质输入撤销草稿/预检/预览/确认”的规则继续执行；新的本人确认仍须完整预览、本人 sender、正确回复目标或 token、当前 draft hash，未放宽校验。
6. 缺身份返回 NO_IDENTITY，缺原生消息 ID 返回 MISSING_MESSAGE_ID；非法 scope/link 也拒绝。普通空白正文是 NONE，不消费 receipt、不读写 Flow。可处理的普通聊天也消费 receipt，避免旧聊天将来撤销新的业务证据。

### Scope 碰撞与容量策略

现有 Flow 的键仍为 `(session,sender)`。不同 channel/account/conversation 如果落在相同 pair，不能仅因为 replay key 不同就修改同一个 Flow。因此 ledger 同时固定该 pair 第一次接受的 scope；之后 scope 改变（包括可选字段从缺失变为出现）返回 **FLOW_SCOPE_CONFLICT**，不读取/修改 Flow。不同宿主路由 session 的账户/渠道、同群不同 sender 正常分离。

这是一项保守拒绝策略，不是把 Flow/Factory 的全系统键重构成跨账户键，也不声称同一 pair 下不同账户可同时使用工单流程。scope pin 与 receipt 一起活到本实例结束；共享 session/切换账户配置需要另行审查，不能通过删除 pin 恢复授权。

默认上限 **4096 条 receipt / FlowStore 实例**，包括普通聊天、失败的确认、已处理或执行异常的消息；scope pin 数量不超过 receipt 数量。无 TTL、无 LRU、无自动淘汰和 reset。Flow 完成、替换、2h TTL 到期不会移除 receipt；容量满返回 **CAPACITY_BLOCKED**，新建/编辑/确认都不再修改状态，已知 duplicate/conflict 仍按原记录判定。容量是安全与可用性的取舍，不能通过删除旧记录悄悄重新允许重放。当前没有用户配置入口，测试通过构造参数使用小容量。

### 异常、顺序和 generation 限制

- handler 抛错时 receipt 已登记并保留；错误 Hook 仍由既有注册包装捕获，不泄漏异常内容。此机制提供 at-most-once 尝试，不提供事务回滚：异常可能留下原 handler 的部分状态，重放不会自动补做。需重新检查并使用新的明确用户消息，而不是清 receipt。
- 已知 ID 迟到重放不影响后来 Flow；**不同 ID** 只按实际到达顺序处理。首次见到的旧消息仍可能撤销新确认，不能证明它在用户发送顺序中更旧。没有 timestamp 排序或固定等待。
- 显式关闭 guard 后拒绝旧调用；测试验证该局部行为。并未新增实际 PluginInstance reload Hook，也未证明宿主会在 reload 时调用 close；旧实例回调撤销仍依赖宿主生命周期，UNKNOWN。
- 新进程/新注册实例 ledger 为空，旧消息可能再次被当作首次消息处理。新实例不会恢复旧确认，但**不保证跨重启、跨实例、多 Gateway 去重**，也不提供永久 tombstone。没有为了可用性自动重建实例。
- 同一个原生 ID 上的合法平台编辑，因为正文或关联变化，也会被拒绝；需要新的原生消息 ID。没有基于 edit timestamp 放宽校验。
- fire-and-forget 的首轮时序、空正文 mapper fallback 和消息→admitted Run 关联均未改变。

## 结果与覆盖矩阵

| 套件 | Pass / Fail / Total | 退出码 | 证据 |
| --- | --- | --- | --- |
| 修改前单元 | 472 / 0 / 472 | 0 | [baseline-unit.txt](baseline-unit.txt) |
| 修改前官方组件 | 40 / 0 / 40 | 0 | [baseline-component.txt](baseline-component.txt) |
| 最终单元 | **515 / 0 / 515** | **0** | [unit-tests.txt](unit-tests.txt)；新增 43 项 |
| 最终官方组件 | **44 / 0 / 44** | **0** | [component-tests.txt](component-tests.txt)；原 40 保留，新增 4 项 |
| 单独直接运行 ACCEPT-11 | **1 / 0 / 1** | **0** | [accept-11.txt](accept-11.txt) |
| 完整正向验收 01/05/11 | **1 / 2 / 3** | **1** | [positive-acceptance.txt](positive-acceptance.txt)；01/05 仍失败 |
| 完整真实 Runner | 0 / 0 / 0，NOT_EXECUTED | 不适用 | 本轮不扩展完整 Runner 安装/时序工作 |

单元 `lib` 行/分支/函数覆盖率 **95.12% / 90.01% / 98.57%**；新 replay 模块 **100% / 94.59% / 100%**。官方组件运行的 `lib` 覆盖率 64.29% / 52.59% / 68.50%；不表示 VM 上游源码或真实 Gateway 全覆盖。

| 验收边界 | 直接证据 |
| --- | --- |
| ACCEPT-11 确认后初始消息重放 | 正向确认 true + 整个 Flow/workflow 深比较不变；receipt 单元把 store.get 改为抛错仍通过，证明先退出再读 Flow。 |
| 相同正文/不同 reply 或 thread | 各字段冲突测试，证据不变，原 receipt 仍能识别原消息。 |
| 新 ID 的相同/不同正文、优先级、聊天 | 必须撤销原确认/预检/预览；新的明确 priority 仍绑定本条原生消息。 |
| 重复确认/先于预览的确认 | 不刷新时间，不重授权；提前被拒绝的确认不能通过重放变为授权，新 ID 的合法确认仍可通过。 |
| Flow 完成/替换/TTL 后重放 | 不建立第二个 Flow，不影响新 Flow；真正新 ID 仍可开始。TTL 不清 receipt。 |
| scope/身份隔离 | 同群 A/B、不同 session/宿主账户路由/channel 分离；同 pair 跨 scope 明确拒绝；缺 sender/message/channel 或 event/context 冲突不写入。 |
| 容量/异常/重入 | 满容量拒绝新 mutation；同步重入仅一次；部分执行抛错后 receipt 保留，重试不重新执行。 |
| out-of-order/generation/多实例 | 验证明确限制，未把不同 ID 严格顺序、跨重启去重、真实 reload 宣称 PASS。 |
| 官方登记链 | REPLAY-C01…04 使用当前 registerGate、真实 registrar/Hook Runner、真实 builder/finalizer/mapper/fire-and-forget emitter/Factory resolver，重复/冲突/新 ID/缺身份/scope 路径通过。 |

原 240 + 240 + 240 构造调度全部保留，首 Factory/Prompt 的旧缺失统计仍在，**不是生产故障率**。旧官方 CASE-11 保留原编辑失效断言，并把缺陷复现断言改为真正的重放保留确认断言。ACCEPT-01/05 测试代码与期望逐字保持，未删除、skip、todo 或用第二轮成功替代。

既有 fixture 必须明确提供 synthetic channel/native messageId 才代表可处理宿主事件：gate helper 原来用日志条数生成 ID，现在用显式递增的 synthetic transport ID；多次用户确认使用不同 synthetic ID。没有在通用 harness 中自动补缺字段，也没有拿正文/模型提供的 ID 冒充宿主 ID。缺失/冲突负例仍保留。

## 分文件差异与复现

| 文件 | 目的 |
| --- | --- |
| `lib/inbound-replay.js` | 新增同步 scope/摘要 receipt guard 和宿主字段投影；有限容量、无淘汰。 |
| `lib/state.js` | 让 ledger 随 store 实例生存，独立于 Flow Map/TTL/complete。 |
| `lib/handlers.js` | 唯一入站业务入口先过 guard，原业务逻辑作为同步内部函数保留。 |
| `lib/register.js` | 严格 event/context 投影与冲突拒绝；仍一个 message_received Hook。 |
| `test/inbound-replay.test.js` | 43 个业务证据、身份、tombstone、容量、异常和代际边界测试。 |
| `test/integration/inbound-replay-upstream.test.js` | 4 个真实官方登记/投影/发射路径组件测试。 |
| `test/integration/dispatch-readiness.acceptance.js` | ACCEPT-11 补 synthetic channel 并加强全证据不变断言；01/05 不变。 |
| `test/integration/first-turn-upstream.test.js` | 保留原场景，CASE-11 修复后的正向断言；host fixture 明确 channel。 |
| `test/gate.test.js`、`test/phase2-*.test.js` | 补齐 synthetic 宿主 ID/scope、真正新确认 ID，安全期望和调度次数不降低。 |
| `docs/inbound-replay-001/*`、README、前轮报告链接 | 基线/最终输出、矩阵、风险与机器结果；历史失败记录不改写。 |

```sh
node --test --experimental-test-coverage test/*.test.js
python3 test/integration/fetch-source.py /tmp/glpi-before-dispatch-locked-source
OPENCLAW_SOURCE=/tmp/glpi-before-dispatch-locked-source node --experimental-vm-modules --test --experimental-test-coverage test/integration/first-turn-upstream.test.js test/integration/before-dispatch-upstream.test.js test/integration/inbound-replay-upstream.test.js
OPENCLAW_SOURCE=/tmp/glpi-before-dispatch-locked-source node --experimental-vm-modules --test --test-name-pattern=ACCEPT-11 test/integration/dispatch-readiness.acceptance.js
# Still exits 1: ACCEPT-01/05 remain unresolved, with unchanged expectations.
OPENCLAW_SOURCE=/tmp/glpi-before-dispatch-locked-source node --experimental-vm-modules --test test/integration/dispatch-readiness.acceptance.js
git diff --check
git diff bb087241a11fcc56dc684b2b5343a117887a2265..HEAD -- lib test README.md docs
```

Node v24.19.0。输出保存只规范化行尾空白。完整分文件 diff 在原 PR 和上述命令中可审查；本轮不覆盖此前 P0/契约/首轮审计。

## 回滚、部署前提和停止

回滚只在审查分支 revert 本轮提交，保留其他并行变更，不 reset/force-push main。回滚会重新引入 ACCEPT-11 缺陷，不能作为上线方案。生产未变，因此本任务没有生产回滚、Gateway restart/reload 动作。

本轮修复的通过范围是单插件 store 实例、可信原生 ID、同步 handler 内的重放抑制。部署仍需独立授权与宿主字段、容量/生命周期、真实 loader/Runner 验证；receipt 容量和拒绝策略必须可接受。FIRST_TURN_STATUS 仍 BLOCKED，老板完整可信指令免确认、senderless Webchat、出站预览/run/message 关联、默认负责人证据、GLPI 5/6 迁移仍独立阻塞。七项必填、实时客户/单实体确认、三段正文、本人最终确认、工单生命周期、Shadow 与脱敏保持，不加领导审批。

实体查询重构不在本轮；直接 REST/exec 可绕过 MCP matcher 的边界不变。本次离线通过不代表生产验收、完整 Runner 或 Enforce Ready。代码、测试、报告、原 PR 更新及远端/CI 核对完成后停止。

```text
TASK_ID=CHG-GLPI-PHASE2-INBOUND-REPLAY-001
BASE_COMMIT=bb087241a11fcc56dc684b2b5343a117887a2265
NEW_COMMIT=see published PR head and final delivery
ACCEPT_11=PASS
ACCEPT_01=FAIL_EXPECTED_UNRESOLVED
ACCEPT_05=FAIL_EXPECTED_UNRESOLVED
REPLAY_KEY_SCOPE=channel/account/conversation/session/sender/nativeMessageId; optional scope pinned per session/sender
REPLAY_TOMBSTONE_POLICY=4096_per_store_lifetime; no_TTL_eviction; capacity_denies_new_mutation
MISSING_MESSAGE_ID_POLICY=FAIL_CLOSED_NO_FLOW_READ_OR_MUTATION
UNIT_PASS/TOTAL=515/515
COMPONENT_PASS/TOTAL=44/44
POSITIVE_ACCEPTANCE_PASS/FAIL/TOTAL=1/2/3
ACCEPT_11_ONLY_EXIT_CODE=0
ALL_POSITIVE_ACCEPTANCE_EXIT_CODE=1
FIRST_TURN_STATUS=BLOCKED
FULL_RUNNER_STATUS=NOT_EXECUTED
PRODUCTION_CHANGED=NO
CORE_CHANGED=NO
SHADOW_MODE=ACTIVE_IN_REPOSITORY
ENFORCE_READY=NO
LIMITATIONS=per_instance_only; no_transport_order; no_cross_restart_or_multi_gateway_dedup; capacity_fail_closed; scope_collision_denied; actual_reload_unknown
DIFF=bb087241a11fcc56dc684b2b5343a117887a2265..published_HEAD
ROLLBACK=reviewed_revert_of_this_task_commit; would_reintroduce_ACCEPT_11_defect
NEXT_STEP=review_independent_replay_fix; retain_first_turn_blockers; no_deployment
```
