# AUDIT-GLPI-BEFORE-DISPATCH-0099

后续 [CHG-GLPI-PHASE2-INBOUND-REPLAY-001](../inbound-replay-001/REPORT.md) 独立修复了 ACCEPT-11；本文的 3 项失败及日志保留为历史基准。ACCEPT-01/05、before_dispatch 准入及正文来源阻塞仍未解除。

**DEV-04 / FIRST_TURN_READY = BLOCKED; PLUGIN_ONLY_SOLUTION = NOT_PROVEN.** 固定 v2026.9.9 的 `before_dispatch` 可以独立注册、会被 await，且在正常 Embedded Runner 初始工具准备之前。非空飞书 command/raw 正文能与渲染引用、昵称、历史分开。但它发生在最终 dispatch admission 之前，公开事件没有消息到已准入 Run 的关联；空 command/raw 时 mapper 又会回退到渲染 Body。两项均阻止安全激活首轮 Flow。

本轮只交付测试目录内的候选登记原型、真实官方组件测试、正向失败验收和报告。没有接入运行插件，也没有将运行时 `message_received` 改成只读。现有重复事件撤销确认的缺陷仍在，不能称为幂等修复。

## 范围、基线与工作树

- 用户授权任务来源：[PR #3 评论 6063169130](https://github.com/lisheguo/glpi-ticket-gate/pull/3#issuecomment-6063169130)，完整正文复核更新时间 `2026-10-08T15:22:44Z`。这是上一轮 `CHG-GLPI-PHASE2-FIRST-TURN-001` 的后续候选审计。
- `BASE_COMMIT=889e088990e3827a281fca547e62b16937d4f15d`。原分支 `codex/chg-glpi-phase2-p0-001`、原 Draft PR #3；开工及发布前远端一致，无其他提交被覆盖。未创建新 PR。
- 未发现适用的仓库/祖先 `AGENTS.md` 或 checkout `.agents/skills`。未访问生产配置或凭据。
- **修改前基线：448/448 单元、16/16 官方组件，失败 0**，含原 240 + 240 调度。[单元基线](baseline-unit.txt)、[组件基线](baseline-component.txt)。基线通过后才开始修改。
- 运行插件仍注册 14 个 Hook、一个同步 Dynamic Tool Factory。Flow 仍由 `handleInbound` 的 `message_received` 创建；Factory 只暴露本人已有 Flow；Prompt 只注入本人已有 Flow 的 Skill。业务证据/生命周期逻辑不变。
- `index.ts`、`lib/*`、manifest、依赖和全部原测试文件保持基准字节；共享测试加载器和源码锁仅作增量扩展。没有 Core、dist、node_modules、生产 Skill/MCP/openclaw.json 修改，没有 Gateway、GLPI、飞书或模型连接。

## 证据等级与关键结论

上游固定 commit：**`bcfc88812a35243893585dbeca87ca41b48272ca` / v2026.9.9**。所有源码链接均固定该 commit。源码下载到 `/tmp`，未修改其内容；测试在内存中转换 TS 语法。最终 [source-lock.json](../../test/integration/source-lock.json) 锁定 **138** 个文件的 SHA-256；新的组件链执行其中 **94** 个真实官方文件。干净目录重新下载并验证 138 个文件后完成最终测试。

| Gate | 结果/等级 | 实际证明与限制 |
| --- | --- | --- |
| 独立注册 before_dispatch | COMPONENT_VERIFIED | 真 `createToolHookRegistrars` + `createHookRunner` 接受注册；该 Hook 不在 conversation hook 策略集合。完整 PluginInstance/loader 未执行。Prompt Hook 仍有 conversation access 前提。 |
| Hook 被 await 且位于最终 admission 前 | COMPONENT_VERIFIED | 真 `chooseDispatchRoute` 的 release barrier 测试：未 release 时不调用 admission；完成后轨迹为 prepared → admission。宿主 admission 服务返回值为明确替身。 |
| 早于正常初始工具组装 | SOURCE_CONFIRMED | choose-route 先完成，正常后续进入 embedded Runner；已有固定源码审计追踪到 attempt/tool-prepare。未执行完整链，不能升级为 FULL_RUNNER_VERIFIED。 |
| 非空飞书 current command 投影 | COMPONENT_VERIFIED，条件成立 | 真 Feishu body builder → inbound builder/finalizer → mapper → dispatch，普通文本、quote、昵称、mention rendering、转写字符串、群/私聊/线程 session 通过。飞书网络 ingress/认证、ASR、真实 mention 解析未执行。 |
| 全部飞书回合的正文边界 | **NOT_PROVEN** | 空 command/raw 的可运行反例回退到含历史/引用的 Body；公共 event 不携带所选投影来源或 SourceModality，无法可靠筛选该分支。 |
| 可信身份字段可取得 | SOURCE_CONFIRMED + COMPONENT_VERIFIED 投影 | host sender/account/channel/session/message 各字段传入 Hook；缺失/冲突被原型拒绝。fixture 输入是合成宿主事实，不代表验证了真实飞书身份认证。 |
| message_received 与 before_dispatch 消息 ID | COMPONENT_VERIFIED，局限同一 context | 两个真实投影的 messageId/sender/session/account/channel 一致，均无 runId。其他接入/聚合/重放路径未推广。 |
| 消息 → 已准入 Run → 首 Factory 的可靠关联 | **UNKNOWN / BLOCKED** | before_dispatch 无 runId；Factory 无 native messageId；后续 Agent Hook 也没有足够的原始消息桥。唯一 pending、群 session、正文或时间窗口均未用作推断。 |
| prepared ledger 幂等与隔离 | COMPONENT_VERIFIED + 单元 | 测试候选记录不会授予 Flow/工具/确认权限。不是有效业务 Flow 的幂等证明。 |
| 首轮 Flow/Factory/Skill 一起就绪 | **FAIL 正向验收** | ACCEPT-01/05 明确要求三者 true，实际全 false，进程 exit 1；没有拿第二次 Factory 结果替代。 |
| 运行时重复消息保留确认 | **FAIL 正向验收** | ACCEPT-11 明确要求重放保留确认，实际 false；原官方组件 CASE-11 的缺陷复现也保留。 |
| 完整 Runner/loader/tool catalog/prompt | **NOT_EXECUTED** | 无 FULL_RUNNER_VERIFIED 项。完整入口加载尝试和依赖检查见下文，不能把组件通过当成整合通过。 |

## 固定源码审计

### 时序、身份和准入

[dispatch-from-config.choose-route.ts:563](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/auto-reply/reply/dispatch-from-config.choose-route.ts#L563) 在 `allowInboundHandlers`、无 restricted admitted settings 且存在 Hook 时，经 `runWithDispatchLifecycleAdmission` 和真实 abort wrapper **await** `runBeforeDispatch`。event 与 context 的结构字段来自同一 hookContext，session 取宿主 routed outer lookup key。`handled:false` 不接管回复，继续正常 dispatch。

关键差别在于：[663 行](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/auto-reply/reply/dispatch-from-config.choose-route.ts#L663) 才检查 reply takeover，668–679 行才调用 `ensureDispatchReplyOperation` 并处理 aborted/busy。Hook 内 private claiming-admission symbol 绑定的是 `assertCurrentBindingRoute`，它不是“该消息已被某个 Agent Run 接收”的公开回执。执行测试证明 busy/aborted 可以在候选登记之后返回，后来的 claiming handler 或 substituted takeover 也能终止模型路径。

[hook-types.ts:468](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/plugins/hook-types.ts#L468) 定义 messageId、senderId、sessionKey、channel、reply fields，context 另含 accountId/conversationId；没有 runId、trigger、当前正文来源、原生 modality 或请求准入回执。[tool-types.ts:21](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/plugins/tool-types.ts#L21) 的 Factory 有 requesterSenderId、agentAccountId、sessionKey、nativeChannelId 与 invocation guard，却没有 native messageId。`toolBindings` 是调用方附加的 plugin-owned bindings，并非此 Hook 自动传递的消息凭据。未伪造二者相等或读取私有符号充当公共契约。

[hooks.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/plugins/hooks.ts#L1014) 将其作为 claiming Hook。真实组件证明异常/显式超时可 fail-open；超时只结束等待，不取消任意插件副作用。原型 handler 同步、无外部 I/O、无 await、无业务授权。真实 [abort wrapper](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/auto-reply/reply/dispatch-from-config.abort.ts#L18) 在开始前已 abort 时拒绝，执行中 abort 也可以让调用退出而已经发生的副作用不回滚；候选记录因此始终不能成为有效 Flow。

### 飞书正文与空正文反例

[bot.ts:1030](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/extensions/feishu/src/bot.ts#L1030) 的 producer 选择 `audioTranscript ?? ctx.content`，在 [1330 行附近](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/extensions/feishu/src/bot.ts#L1330) 分别提交 rawBody/commandBody 与渲染后的 body/bodyForAgent。正常非空文本不会把 quote/name/history 当作 commandBody。

真实 [inbound builder](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/channels/inbound-event/context.ts#L492) 保留 RawBody/BodyForCommands 等投影；真实 [finalizer](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/auto-reply/reply/inbound-context.ts#L43) 保留空字符串。随后 [mapper:88](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/hooks/message-hook-mappers.ts#L88) 却按 **nonblank** BodyForCommands → RawBody → Body 选择 content。

DISPATCH-04b 输入空当前正文、带“新增工单”的历史/引用，经上述全部真实组件后：`BodyForCommands=''`、`RawBody=''`，但 `event.content=Body`，候选 lexical intent=true。这是组件反例，**不是生产发生率，也没有证明飞书每种空内容都能走到此处**。但它足以否定“公共 content 无条件代表当前用户原文”的契约；Hook 没有字段能认证究竟走了哪一个投影。不得用解析渲染标记/简单去引号强行解除阻塞。附件、空转写、literal input、媒体富化均继续 UNKNOWN。

公网 builder 的 `InboundAccessAuthorized:true` 是后 ingress 投影，不能在 fixture 中自行构造这个值就宣称认证通过。真实 host ingress capability owner `host-context-builder.ts` 作为未执行边界保留；sender/nickname/body 自报都不会升级身份。线程测试仅证明**宿主提供不同 session**时 ledger 分离；没有声称所有生产线程配置均采用不同 session。

### 路径覆盖和跳过条件

| 路径 | 固定源码/测试 | 限制 |
| --- | --- | --- |
| 普通 eligible Feishu dispatch | 真 choose-route + builder/mapper 已执行 | 完整 Feishu ingress、Runner 未执行。 |
| heartbeat | [gather.ts:104](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/auto-reply/reply/dispatch-from-config.gather.ts#L104) 令 allowInboundHandlers=false；组件执行该 state 的 skip 分支 | 未运行真实 heartbeat 调度器；before_dispatch 没有 eligibleTriggers 用户筛选契约，不把 arbitrary cron 当作可信用户。 |
| restricted runtime | [events.ts:11](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/auto-reply/reply/dispatch-from-config.events.ts#L11)：permissionMode 非 full 或非空 toolOverrides | 真实 eligibility 函数已执行；后续 restricted refusal 服务是替身。 |
| conversation capture | [prepare-context.ts:514](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/auto-reply/reply/dispatch-from-config.prepare-context.ts#L514) 可观察后直接返回 | SOURCE_CONFIRMED，组件未运行完整 capture。 |
| plugin-bound inbound_claim / fast command | [prepare-operation.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/auto-reply/reply/dispatch-from-config.prepare-operation.ts) 的早退分支 | SOURCE_CONFIRMED，不是全入口广播。 |
| handled / takeover | 真 choose-route 的提前返回分支已执行 | handled 为真实 Hook 结果；ACP/reply takeover 服务是显式替身，ACP integration NOT_EXECUTED。 |
| message_received 早/迟 | [prepare-operation:396](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/auto-reply/reply/dispatch-from-config.prepare-operation.ts#L396) 发出；真 emitter fire-and-forget | 测试显式 await 观察完成以断言，只影响测试协调，不修改真实发射器。 |

## 唯一入口原型及未完成迁移

[before-dispatch-prototype.js](../../test/support/before-dispatch-prototype.js) 只存在于 `test/support`。独立注册候选 `before_dispatch` 为 preparation 唯一写入口，候选 `message_received` 只读；没有 runtime import、FlowStore 引用或 GLPI 操作。

1. 必须取得非空、有限长度的宿主 channel/account/session/sender/message/conversation；event/context 同名身份与 reply 字段冲突即拒绝。只接受 feishu；缺失消息 ID 不造 ID。hash key 包含完整宿主作用域，正文不参与身份构造。
2. 正文摘要仅在 host ID 已相等之后检查冲突。相同 ID/相同内容返回同一个 opaque receipt，不改变候选状态；相同 ID/不同内容将原记录置 CONFLICT。新 ID 是新候选，即使正文相同；不按正文、时间、群 session、昵称或唯一 Flow 去重。
3. 候选 intent/priority/confirmation 是 lexical 数据，**不是可信指令、确认或已准入证据**。receipt 只是进程内不透明 handle，不是宿主 admission token。`resolveAdmittedRun` 永远拒绝，原因 `HOST_MESSAGE_TO_ADMITTED_RUN_LINK_UNPROVEN`；另有上述正文 provenance 阻塞。
4. TTL 只把 PREPARED 变 TOMBSTONE，不删除 ID；显式 retire 后及新消息登记后，旧 ID 重放仍为 duplicate。默认最多 256 条，包含普通消息；达到上限拒绝新登记，不淘汰 tombstone 换取可重放空间。此容量取舍限制可用性，**不是可部署设计**。
5. generation close 拒绝旧回调并保留 tombstone；新实例为空，不恢复确认。但实际 PluginInstance reload、旧代回调撤销和跨进程重放未验证，不因测试中调用 close 就标真实 reload PASS。

本轮没有把建 Flow、修改字段、优先级、确认迁至正式 before_dispatch。迁移必须在消息 provenance 和已准入 Run 关联均解决后，再原子地替换旧入口。仅让 message_received 只读而没有可靠替代，会丢失业务回合；让两个入口同时写则保留竞争。两者均未实施。

新 ID 的真实修改仍由现有业务 handler 撤销旧 preflight/preview/confirmation（原 CASE-11 及既有单元测试通过）；同 ID 迟到重放也撤销，是**尚未修复的 FAIL**。候选 ledger 的 tombstone 测试不能代替完整 Flow completion/replacement/确认幂等验收。

## 测试记录、覆盖率及矩阵

| 套件 | 总数/通过/失败 | 退出码 | 解释 |
| --- | --- | --- | --- |
| 原单元基线 | 448 / 448 / 0 | 0 | 修改前，含原 240 个调度子测试。 |
| 原官方组件基线 | 16 / 16 / 0 | 0 | 修改前，内含额外 240 调度。 |
| [最终单元](unit-tests.txt) | **472 / 472 / 0** | 0 | 增加 24 个 preparation ledger 单元。lib 行/分支/函数覆盖率 **95.15% / 89.61% / 98.37%**。 |
| [原官方组件回归](old-component-tests.txt) | **16 / 16 / 0** | 0 | 原文件未改变；历史 before_agent_reply 阻碍仍可复现。lib 覆盖率 62.30% / 43.56% / 64.55%。 |
| [新官方 dispatch 组件](dispatch-component-tests.txt) | **24 / 24 / 0** | 0 | 新增 240 轮混合异步调度。lib 覆盖率 26.92% / 62.30% / 17.50%，不是上游源码覆盖率。 |
| [正向验收 Gate](readiness-acceptance.txt) | **3 / 0 / 3** | **1** | ACCEPT-01、05、11 均 FAIL；独立文件明确运行，未 skip/todo/反转为绿色。 |
| 完整真实 Runner | **0 / 0 / 0，NOT_EXECUTED** | 不适用 | 不混入 40 个组件断言或 3 个 acceptance 统计。 |

计数：官方组件回归 40/40；正向验收另有 3 项失败，其中 ACCEPT-01/05 使用组件链，ACCEPT-11 使用当前直接 runtime handler。Node coverage 报表统计被测 `lib`，不表示 94 个 VM 上游模块或 test/support 的全覆盖。总计保留/执行 **240 + 240 + 240 = 720** 个构造调度，后两组循环分别属于一个测试；不得把 720 再加到 test runner 总数。

旧 240 调度仍见 Factory/Prompt 各 120 次首轮缺失；旧官方组件 240 调度仍有首 Factory 160 次缺失。新 240 调度始终不授予候选 Flow 权限，因此 readiness 也未通过。以上全是构造调度结果，不是生产故障率。

| 场景 | 对应测试 | 状态 |
| --- | --- | --- |
| 首次明确工单 | DISPATCH-01/02、ACCEPT-01 | 时序组件通过；首 Flow/tool/Skill **FAIL**。 |
| 普通聊天 | DISPATCH-03/04 | 无 Flow/tool/Skill；非空当前正文无误读。 |
| 引用/昵称/mention/转写/空正文 | DISPATCH-03、04b | 非空投影通过；空正文回退反例证明边界不足。 |
| 同群 A/B、账户、线程 session | DISPATCH-07、ledger scope 单元 | 候选隔离通过；完整运行 Flow 关联未证明。 |
| 早/迟 observation | DISPATCH-05、ACCEPT-05 | 候选只读通过；首轮 readiness **FAIL**。 |
| 缺 sender/message、字段冲突 | DISPATCH-06/08、ledger 单元 | 拒绝，不猜身份。 |
| 重复/同 ID 异文/新 ID/迟到 | DISPATCH-06、ledger tombstone | 候选通过；运行时 replay 保留确认 **ACCEPT-11 FAIL**。 |
| busy/aborted/handled/takeover | DISPATCH-09/10/11/11b | 不产生有效 Flow；部分宿主服务替身范围明确。 |
| 异常/超时 | DISPATCH-13 | 真 runner fail-open；候选无业务副作用。 |
| 重试/fallback-shaped 重放 | DISPATCH-14，原 CASE-08 | 候选重复及原 run-once 组件通过；完整模型 fallback 未执行。 |
| generation/reload/重启 | ledger + DISPATCH-14，原 CASE-10 | 进程内关闭/新实例通过；真实 reload NOT_EXECUTED。 |
| 修改后重做预检、完成后新 Flow | 原 CASE-11/12 + 原业务套件 | 既有逻辑回归通过；新入口完整 Flow 生命周期 BLOCKED。 |

### 真实执行组件与明确替身

真实执行：domain registrars、Hook Runner/claiming await/timeout、private claiming route-check wrapper、subagent requester async context、Feishu renderer、inbound builder/finalizer、message mappers、fire-and-forget emitter、chooseDispatchRoute、abort wrapper、restriction predicate、Factory resolver、Prompt helper，以及本仓库的 Factory/Prompt handler。

明确替身见 [dispatch-loader.js](../../test/integration/dispatch-loader.js)、[upstream-loader.js](../../test/integration/upstream-loader.js)、[dispatch-harness.js](../../test/integration/dispatch-harness.js)：host ingress authentication owner、真实 plugin runtime/config/instance/lifecycle、delivery/transcript/媒体 I/O、channel registry lookup、takeover/refusal 服务、final admission/busy/abort 服务返回值。未使用路径直接抛错；channel normalizer 仅提供 fixture 所需 feishu 行为；@normalization aggregate 只映射本链使用的 expectDefined。没有把这称为完整 SDK facade、真实 plugin loader 或完整工具策略 catalog。

Fixture 中真实 choose-route 返回 ready 后，显式调用一次真实 Factory resolver 和一次真实 Prompt helper；二者都无 Flow。完整 Embedded Runner 并未参与。这比自造 Hook event 验证更多投影/顺序，但仍不能证明生产首模型调用。

### 完整 Runner 尝试

[完整入口加载记录](full-runner-load.txt) 使用完整固定源码 archive、扩展的公共 package 叶子解析，尝试加载 `run-orchestrator.ts`，在 `src/agents/system-prompt-params.ts` 的 `node:fs` 依赖处被**测试加载器自身的 native allowlist**终止；上游入口未 evaluate。不是声称操作系统权限拒绝，也不是 OpenClaw 自身异常。

上一轮缺少的 `packages/model-catalog-core/src/provider-id.ts` 此次已从固定 archive 取得并加入 source lock，不能继续报告该源码不存在。但隔离环境没有安装官方工作区 package/dependency 链，Node resolve 对 model-catalog-core、pi-ai、pi-agent-core、zod、jiti 均 MODULE_NOT_FOUND，见 [依赖记录](runner-dependencies.txt)。没有修改上游 node_modules/Core 来安装或构建，也没有用新替身拼成“完整 Runner PASS”。**完整 Runner/loader/catalog/prompt/reload 仍 NOT_EXECUTED**。最终最小源码下载目录只包含组件/审计所需 138 文件，不是可启动 OpenClaw 安装。

## 分文件差异与复现

| 文件 | 变更 |
| --- | --- |
| `test/support/before-dispatch-prototype.js` | 无授权能力的有限候选 ledger、唯一候选写入口、只读 observation。 |
| `test/before-dispatch-ledger.test.js` | 24 个身份冲突/重复/容量/tombstone/generation 单元。 |
| `test/integration/dispatch-loader.js` | 新组件链的显式服务边界。 |
| `test/integration/dispatch-harness.js` | 调用真实 builder/mapper/dispatch/registrar/runner/factory/prompt 的 fixture。 |
| `test/integration/before-dispatch-upstream.test.js` | 24 个官方组件测试与 240 混合调度；含空正文反例。 |
| `test/integration/dispatch-readiness.acceptance.js` | 三项直接正向目标，当前均失败，单独运行并报告。 |
| `test/integration/upstream-loader.js` | 允许显式选择真实组件/边界，新增叶子 package alias；原套件通过。 |
| `test/integration/source-lock.json` | 105 → 138 个固定 SHA-256 文件；不 vendor 或修改 Core。 |
| `docs/before-dispatch-0099/*`、README、原报告链接 | 审计、原始输出、矩阵、风险、机器结果及开发入口。 |

```sh
node --test --experimental-test-coverage test/*.test.js
python3 test/integration/fetch-source.py /tmp/glpi-before-dispatch-locked-source
OPENCLAW_SOURCE=/tmp/glpi-before-dispatch-locked-source node --experimental-vm-modules --test --experimental-test-coverage test/integration/first-turn-upstream.test.js
OPENCLAW_SOURCE=/tmp/glpi-before-dispatch-locked-source node --experimental-vm-modules --test --experimental-test-coverage test/integration/before-dispatch-upstream.test.js
# Required positive acceptance: currently exits 1 with three failures.
OPENCLAW_SOURCE=/tmp/glpi-before-dispatch-locked-source node --experimental-vm-modules --test test/integration/dispatch-readiness.acceptance.js
git diff --check
git diff 889e088990e3827a281fca547e62b16937d4f15d..HEAD -- test README.md docs
```

使用 Node v24.19.0 + VM modules。测试/记录仅有 synthetic fixture 数据；保存输出只规范化行尾空白。未修改或删除旧失败复现，未降低业务安全预期。PR 的 Files changed 和以上 diff 命令提供完整分文件差异；本轮 diff 的起点是 889e088，不覆盖之前业务修复。

## 逐阶段/DEV、兼容性与部署前提

| 项目 | 状态 |
| --- | --- |
| Phase A | PARTIAL：固定源码、真实组件注册/投影/时序完成；完整 ingress/Runner 未运行。 |
| Phase B | PARTIAL：有限只读候选原型与 ledger 完成；**正式 Flow mutation 迁移未实施**。 |
| Phase C | BLOCKED：message→admitted Run 桥未证明，正文 projection provenance 另有缺口。 |
| Phase D | PARTIAL：单元/组件回归完成，三项正向 Gate FAIL，完整 Runner NOT_EXECUTED。 |
| DEV-01 | 既有 offline PASS 保留；新入口空正文不能安全直接复用 detector 授权。 |
| DEV-02 | PARTIAL；现有本人 Flow 隔离保持，无 sender 的 Webchat/Control UI BLOCKED。 |
| DEV-03 | 既有 offline PASS 保留；真实 host requester/run/call 传播待验证。 |
| DEV-04 | **BLOCKED**，不能宣称首轮已修复或群试用就绪。 |
| DEV-05 | PARTIAL；本人最终确认保持，重复 observation 缺陷、出站关联、可信老板例外仍独立 BLOCKED。 |

七项业务必填、三段正文、实时客户查库与单实体窄确认、最终预览、普通技术员本人确认、状态 2/5/6、创建后 solution/update/readback、日志脱敏、Shadow 判定全部保持原实现与测试。不新增领导审批或补签；不放宽老板身份/内容证据。

下一步需要可验证的官方**当前正文来源 + 稳定消息标识 + 已准入 Run 关联**；在未获得该契约前，不把 PREPARED 提升成 Flow。之后还需完整固定 Runner/loader/首工具 catalog/首 Prompt、真实 ingress、fallback/retry/reload、消息丢弃和连续同人消息验收；再单独审查迁移、去重容量与代际关闭。`before_model_resolve`、`agent_turn_prepare`、`before_prompt_build`、`before_agent_run` 的早晚和字段限制仍见[上一轮替代 Hook 比较](../first-turn-001/REPORT.md#other-official-entry-points)。本轮没有证明所有 Plugin API 均不可能；`CORE_PATCH_REQUIRED=NOT_DETERMINED`，且没有修改 Core。

独立部署阻碍继续保留：可信老板完整明确指令例外、senderless Webchat、出站预览/run/message/真实送达关联、默认负责人身份与在职证据、GLPI 服务器初始状态/自动置 5/5→6 迁移及最终格式。实体查询重构不在范围；截断/零提取仍可能误拦，窄实体确认不扩成缓存白名单。直接 REST/exec/python 可绕过 MCP matcher，Shadow 本来就不阻止写入，离线 WOULD_ALLOW 不是生产或 Enforce Ready。

**没有生产部署建议或群试用授权。** 停止于本报告、可审查测试和原 Draft PR。回滚本轮仅在审查分支逐个 revert 本轮 test/docs 提交，回到 889e088 的状态并保留其后独立变更；不 reset/force-push main，不触碰运行环境。由于运行插件/配置从未变更，没有生产回滚动作。

```text
TASK_ID=AUDIT-GLPI-BEFORE-DISPATCH-0099
OPENCLAW_VERSION=2026.9.9
BASE_COMMIT=889e088990e3827a281fca547e62b16937d4f15d
NEW_COMMIT=see published PR head / final delivery
BEFORE_DISPATCH_SUPPORTED=COMPONENT_VERIFIED_DOMAIN_REGISTRATION
HOOK_AWAIT_CONFIRMED=COMPONENT_VERIFIED
TRUSTED_IDENTITY_AVAILABLE=OPTIONAL_HOST_FIELDS; LIVE_AUTH_UNKNOWN
CURRENT_MESSAGE_BOUNDARY_CONFIRMED=CONDITIONAL_NONEMPTY_PROJECTION; BLANK_FALLBACK_NOT_PROVEN
ADMITTED_RUN_MESSAGE_LINK=UNKNOWN
FIRST_TURN_FLOW_READY=FAIL_POSITIVE_ACCEPTANCE
FIRST_TURN_TOOL_READY=FAIL_POSITIVE_ACCEPTANCE
FIRST_TURN_SKILL_READY=FAIL_POSITIVE_ACCEPTANCE
FIRST_TURN_READY=BLOCKED
DUPLICATE_EVENT_SAFE=PREPARATION_ONLY_PASS; ACTIVE_FLOW_FAIL
MULTI_USER_ISOLATION=PREPARATION_COMPONENT_PASS; FULL_RUNNER_UNKNOWN
RETRY_AND_FALLBACK_SAFE=PARTIAL_COMPONENT_ONLY
UNIT_TEST_TOTAL=472
UNIT_TEST_PASS=472
COMPONENT_TEST_TOTAL=40
COMPONENT_TEST_PASS=40
READINESS_ACCEPTANCE_TOTAL=3
READINESS_ACCEPTANCE_PASS=0
READINESS_ACCEPTANCE_FAIL=3
FULL_RUNNER_TEST_TOTAL=0
FULL_RUNNER_STATUS=NOT_EXECUTED
DEV_04_STATUS=BLOCKED
PLUGIN_ONLY_SOLUTION=NOT_PROVEN
CORE_PATCH_REQUIRED=NOT_DETERMINED
CORE_CHANGED=NO
PRODUCTION_CHANGED=NO
SHADOW_MODE=ACTIVE_IN_REPOSITORY; PRODUCTION_NOT_ACCESSED
ENFORCE_ACTIVATED=NO
PR_URL=https://github.com/lisheguo/glpi-ticket-gate/pull/3
NEXT_STEP=review_blockers_and_prove_host_contract; no_deployment
```
