# CHG-GLPI-REPLAY-RETENTION-002

**METRICS_PATCH=PASS（离线）；留存语义未改；长期容量耗尽风险仍存在。** 新增匿名容量/拒绝计数和四档首次告警，没有清理 receipt、扩容或接入持久化。ACCEPT-11 保持通过；首轮 ACCEPT-01/05 仍失败，完整 Runner 未执行，不能据此部署或开始 Enforce。

## 基准、范围和结果

- 需求：[PR #3 评论 #6069209553](https://github.com/lisheguo/glpi-ticket-gate/pull/3#issuecomment-6069209553)，更新时间 `2026-10-08T21:16:27Z`。继续原分支 `codex/chg-glpi-phase2-p0-001` 和原 Draft PR #3。
- `BASE_COMMIT=a5ced4800591f96563b891dceae205954dae1221`；开工本地/远端一致且工作树干净。提交前再次比较远端，避免覆盖并行开发。`NEW_COMMIT` 由包含本报告的提交确定，最终 SHA/CI 核对记录发布到原 PR 描述及交付回复，避免报告自引用 SHA。
- 固定 OpenClaw v2026.9.9 / `bcfc88812a35243893585dbeca87ca41b48272ca`，源码只读；源码锁由 138 扩展为 155 个文件，逐文件 SHA-256 校验。未发现适用 AGENTS.md/checkout skill。
- **修改前**：[515/515 单元](baseline-unit.txt)、[44/44 官方组件](baseline-component.txt)，exit 0；[ACCEPT-11](baseline-accept11.txt) 通过；[完整正向验收](baseline-acceptance.txt) 1 通过、2 失败，exit 1，失败为已知首轮 01/05。
- **修改后**：[523/523 单元](final-unit.txt)、[45/45 官方组件](final-component.txt)、[4/4 留存审计](final-source.txt)，exit 0；[ACCEPT-11](final-accept11.txt) 通过；[完整正向验收](final-acceptance.txt) 仍 1 通过、2 失败，exit 1。没有删除、skip 或放宽验收用例。
- 只修改插件、测试和技术文档。无 Core/dist/node_modules、生产配置、外部 MCP/Skill 或 GLPI 修改，无 SSH、生产消息、Gateway 启停/reload、部署、合并或 Enforce；七项业务字段、实时客户核验、窄实体确认、预览和本人确认不变。

机器可读结果见 [results.json](results.json)，原始基准见 [memory-benchmark.json](memory-benchmark.json)。CI 仅以发布后远端 SHA 的实际查询结果为准，离线通过不代表 CI 或生产验收。

## A. 实际容量与固定源码审计

### 插件现有生命周期：SOURCE_CONFIRMED + COMPONENT_VERIFIED

[guard](../../lib/inbound-replay.js) 的 4096 为**每个 FlowStore 实例**累计 receipt 总数，覆盖该实例所有账户/会话/技术员。具备合法宿主身份、原生 ID 的普通非空聊天也占用；空白正文不占用。不应把工单数量当作 receipt 流量。没有按租户或 sender 的公平配额，一个高流量作用域即可耗尽全实例余量。

receipt 和 `ownerScopes` 均独立于活动 Flow；Flow 完成、2h TTL、替换 Flow 都不释放它们。`ownerScopes` 将 `(sessionKey,senderId)` 持续 pin 到 `(channelId,accountId,conversationId)`，避免同一 Flow 标识跨渠道/账户碰撞；每个 owner 首次占用至少一条 receipt，故自身大小也受 4096 限制。关闭 guard 后拒绝处理，不提供重新打开或清理 API。新实例失去旧 ledger 和计数，这不是跨重启幂等方案。

判定顺序未变：已关闭 → 输入快照/身份、ID、scope、reply 验证 → 原生 key/digest → 已知 key 的重复/冲突 → owner/scope 冲突 → 容量 → 同步预登记 receipt → 原业务修改。**满容量时已知重复仍返回 DUPLICATE_IGNORED，同 ID 异文仍是 MESSAGE_ID_CONFLICT，scope 冲突仍先于容量拒绝；所有合法新 ID 返回 CAPACITY_BLOCKED，不能产生新的 Flow 修改。** 这些是插件 Shadow 状态的拒绝；插件不因此阻断外部 GLPI 写工具或 REST。

ledger 留存 key/digest 哈希，未持有正文；普通重复计算 2 次哈希，首次新消息另算 owner/scope 共 4 次。Map 查询平均 O(1)，但正文/reply 正文的 JSON/哈希成本随长度增长，不能称整个处理 CPU 恒定。现有正文没有本轮新增长度限额；大正文临时分配、全部 Flow 内存、宿主内存均不包含在 receipt 单位堆内存数字中。本轮没有借观测增加业务拒绝条件。

### Feishu 24h / 1000 / 10000：SOURCE_CONFIRMED

下列链接均固定同一个 commit，不依赖最新分支：

| 固定源码 | 结论与边界 |
| --- | --- |
| [dedup-state.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/extensions/feishu/src/dedup-state.ts) | createChannelReplayGuard：内存最多 1000，持久化 namespace 最多 10000，TTL 24h。不是 GLPI 无限期幂等 SLA。 |
| [dedup.ts](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/extensions/feishu/src/dedup.ts) / [dedupe-key.ts:64](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/extensions/feishu/src/dedupe-key.ts#L64) | 逻辑重投可能换 event_id/message_id。文本逻辑键结合 sender、chat、create_time、content hash；字段不足可退到 native message ID，媒体/post 分支不同。不能把该内容逻辑键偷换为本插件原生身份，也不能将源码注释 PERMANENT 理解为无期限留存。 |
| [feishu-ingress.ts:142](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/extensions/feishu/src/feishu-ingress.ts#L142) | 队列按 header/flattened event_id 接收并按 chat 分 lane，持有原始 envelope；receivedAt 为本地接收元数据。tombstone 的 event_id 不能天然覆盖换 ID 的逻辑副本。 |
| [bot.ts:1490](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/extensions/feishu/src/bot.ts#L1490) | broadcast/agent 分支有自己的 claim/namespace 与 adoption/release 流程；不是一个可直接替代插件 ledger 的全局永久集合。 |
| [persistent-dedupe.ts:248](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/plugin-sdk/persistent-dedupe.ts#L248) | 异步 observe/compareAndApply，seenAt 决定 TTL；磁盘错误回调不抛错时可继续内存降级并返回新消息。Feishu 回调记录错误而不抛。此 best-effort 行为不能直接成为业务授权保证。 |
| [durable-ingress.md:96](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/docs/plugins/sdk-channel-plugins/durable-ingress.md#L96) | TTL 或 cap 任一先达到都会结束保护；文档 30 天是 fleet 约定，非 SDK 默认。副作用与完成 tombstone 之间存在 at-least-once 崩溃窗口；effect-once helper 也有副作用成功而提交失败、过期而 pending 未结束等残余窗口。无界 pending/downtime 无法由有限 TTL 完整覆盖。 |

RETENTION-S01 实际执行固定内存 cache，验证 1001 个键挤掉首键以及 24h 到期；**未执行持久化存储/恢复或完整 Feishu ingress**。逻辑换 ID 重放、跨 Gateway、跨重启、磁盘失败的真实表现仍是运行时未验证项。

### SDK 能否复用：UNKNOWN，不能简单断言“没有同步 API”

官方 claim/dedup 与优先推荐的 `api.runtime.state.openKeyedStore` 为异步路径；直接在当前同步观察 handler 中 await 它们会改变完成顺序，不能作为本轮低风险补丁。反之，固定 [runtime/types-core.ts:519](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/plugins/runtime/types-core.ts#L519) **确实公开 `openSyncKeyedStore`**，其注释标记 deprecated、兼容至下一 SDK major。[registry-runtime.ts:247](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/plugins/registry-runtime.ts#L247) 对其执行 trusted runtime 检查并绑定 pluginId；[plugin-state-store.ts:330](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/plugin-state/plugin-state-store.ts#L330) 有同步 register/update 等实现。同步能力的存在属于 SOURCE_CONFIRMED，安全接入本插件不是已证实事实。

[plugin-store-validation.ts:30](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/plugin-state/plugin-store-validation.ts#L30) 默认 overflow 为 evict-oldest，也提供 reject-new；[retention.ts:118](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/plugin-state/plugin-state-store.retention.ts#L118) 会执行有界清理。不能默认参数接入无限期业务 receipt；reject-new 保住拒绝语义但仍会耗尽容量。还须验证运行时权限/lifecycle、同步阻塞预算、错误策略、namespace/version 迁移及 ledger 与内存 Flow 的崩溃/原子性；目前没有 SQLite/完整 host 执行证据。SDK retained 模式不能被当作有限占用方案。

### timestamp 的真实来源：SOURCE_CONFIRMED，年龄 fence NOT_PROVEN

固定 [bot.ts:544](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/extensions/feishu/src/bot.ts#L544) 采用 `parseStrictNonNegativeInteger(event.message.create_time) ?? Date.now()`，之后传入 [host builder](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/channels/inbound-event/context.ts#L530) 的 Timestamp。finalizer 没有增加创建时间来源证明；[mapper:131](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/hooks/message-hook-mappers.ts#L131) 只保留 finite number，[公开事件](https://github.com/openclaw/openclaw/blob/bcfc88812a35243893585dbeca87ca41b48272ca/src/plugins/hook-message.types.ts) 的 timestamp 可缺失，没有“平台创建/本地 fallback”标识。

因此同一个数字可能来自平台 create_time，也可能来自本地收到时间；插件无法仅凭该值区分。原始平台 envelope 的认证、其他渠道/媒体分支、时钟误差、未来时间、停机和重排上界都未在此环境证明。RETENTION-S02 实际运行解析器并检查 producer 固定源码；S03 实际运行 builder/finalizer/mapper，验证数值投影相同、NaN/缺失被丢弃、负 finite 数值仍可通过 mapper。**这些组件事实不证明完整 bot 认证或消息最晚可重放年龄。** 没有用正文、昵称或本地接收时间代替平台创建时间。

## B. 容量观测实现

[replay-metrics.js](../../lib/replay-metrics.js) 维护固定原因计数、容量和匿名作用域桶。它复用 guard 已计算的哈希，仅内部索引持有；没有日志/返回字段包含哈希、原生 ID、正文、昵称或 scope 标签。监控桶只随成功登记的 receipt 创建，未见过的拒绝身份只记 global/unattributed；攻击式 20000 个新 sender 被拒绝后不会继续分配桶。

- `store.inboundReplay.metrics()`：冻结快照，used/capacity/remaining/scope_count/rejected_total/counters/unattributed；不遍历 receipt。
- `store.inboundReplay.scopeMetrics(structuredHostScope)`：验证有界结构身份后 O(1) 查询，返回冻结原因计数或 null；不分配桶、没有枚举所有 scope 的 API。它是内部只读接口，不能把调用者传入的身份用于业务授权；没有新增对外工具/HTTP/CLI 或监控连接器。
- 原因包括 RESERVED、DUPLICATE_IGNORED、MESSAGE_ID_CONFLICT、FLOW_SCOPE_CONFLICT、CAPACITY_BLOCKED、NO_IDENTITY、MISSING_MESSAGE_ID、INVALID_SCOPE、INVALID_MESSAGE_LINK、NONE、GENERATION_CLOSED、IDENTITY_OR_LINK_CONFLICT、HANDLER_ERROR。HANDLER_ERROR 为已登记 receipt 上的辅助计数，不能再与 RESERVED 相加当作消息总数；rejected_total 不含 RESERVED/DUPLICATE/NONE/HANDLER_ERROR。
- 计数在 Number.MAX_SAFE_INTEGER 饱和并置 counters_saturated；桶/receipt 索引均至多 4096。拒绝原因是固定枚举，输出不存在任意字符串拼接业务数据。
- 每实例首次跨越 70/85/95/100%，对应 used **2868/3482/3892/4096**，各最多记录一次。已有每次拒绝的原因日志不变；本轮只保证新增容量告警不刷屏。直接内部调用者若延迟 drain，则告警携带 drain 时当前水位；正常 handler 每次结束即 drain。
- guard 仍同步无 await，快照/key/digest/身份验证/判定顺序未变。receipt 和 owner pin 先于业务回调；计数不参与任何业务条件。阈值日志在 `guard.run` 返回/抛错后的 finally 执行，日志失败不覆盖原结果，也不重试状态修改；已消耗的告警不会重发。故日志故障可能丢告警，应视为 best-effort 观测而非持久审计。

新增容量日志形如：

```text
mode=shadow event=inbound_replay_capacity threshold_pct=70 used=2868 capacity=4096 scope_count=1
```

该补丁没有增加外部通知、业务写授权或独立数据库，也没有将指标作为扩容/重启/清理的自动触发器。

## C. 长期治理方案（仅设计，运行时代码未启用）

安全回收某条 receipt 的条件是：能证明其未来所有副本都会被**独立于该 receipt 的规则**拒绝，或有明确有限重投范围且范围结束。完成 Flow、Flow TTL、观察不到重复、低流量、换实例都不构成此证明。

**有限固定存储、无限期精确重放拒绝、持续接纳无界合法新 ID，三者不能同时无条件满足。** 当前“满后拒绝全部新 ID”保留安全性，代价是可用性；不能为可用性简单删除历史记录。若要继续接纳，需要可信年龄/重放边界、业务保留窗口决策或不同存储/宿主契约。

| 方案 | 占用与收益 | 授权、失效与回滚风险 | 后续验收门槛 |
| --- | --- | --- | --- |
| A：提高容量 + 水位 + 运维 | O(C) receipt/owner/指标内存；仅推迟触顶，无永久解法。本轮仅实现原 C 下的水位。 | 不淘汰时既有安全规则可保持；容量估算错误仍全实例拒绝。降低容量不能截断 ledger；重启/回滚丢内存会失去去重，不能视为恢复手段。 | 实测合法消息速率/峰值/作用域数、目标连续运行周期和堆预算；批准 C 后验证压力和升级交接。不能只按工单量估计。 |
| B：可信创建时间年龄拒绝 + 有界保留 + scope 配额/背压 | O(C)；先对所有消息执行可信年龄 fence，**超龄但首次出现的旧 ID 也拒绝**。可据证明淘汰不再可操作的旧 receipt。 | 合法延迟消息也可能被拒绝；时间缺失、不可信、超出未来偏差需 fail-closed。时钟回拨或重启丢高水位可使旧消息复活；不得默认跨渠道成立。配额改变公平性/准入，需独立业务审批。 | 宿主提供不可被当前正文控制的创建时间及来源、原生 ID 绑定、最晚重投/停机边界、可信非回退时钟或持久年龄下界；验证未来/乱序/缺失/回拨/重启/跨渠道。窗口与配额未定。 |
| C：官方 SDK/宿主持久化 | 可能改善跨重启保护；有界 DB 仍需 C/窗口/拒绝策略；不得新增独立 DB/Redis。 | 默认 evict-oldest/best-effort disk fallback 不安全；异步 claim 非同步 handler 直接替代。deprecated 同步 store 存在，但阻塞、权限、generation 与业务原子性未证实。先落 receipt 后崩溃可损失处理；先处理后落盘可重放。 | 隔离完整宿主测试 async/sync API 生命周期、fail-closed 错误、namespace 所有权、并发/多进程、迁移、crash/restart；明确 loss vs replay 策略。保留 ledger 可读性后再回滚，不能静默回退空内存。 |

`ACTUAL_CHANNEL_VOLUME=UNKNOWN`，没有生产指标、停机分布或已验证的单 Gateway 拓扑。不能给 24h/10000 或其他窗口/容量贴业务 SLA。可验证计算应以全部合法非空入站消息计算：A 的剩余时间粗估 `(C-used)/unique_message_rate`（需峰值和变化范围）；B 的 C 至少覆盖批准窗口内唯一键数量、突发和 pending 预算，并另计 owner/指标/Flow 内存。本文没有代入虚构生产流量。

**PREFERRED_NEXT_STAGE**：先取得脱敏流量/峰值与单实例事实，并独立证明宿主创建时间来源和重投/时钟边界；同时做 C 的官方 API 可行性实验（含 deprecated sync 接口的限制），再由后续任务批准窗口、容量、错误及迁移策略。当前 HOST_DEDUPE_REUSE_FEASIBLE=UNKNOWN，TRUSTED_MESSAGE_AGE_FENCE=NOT_PROVEN。候选仅保留本节设计和固定源码契约测试，没有运行时 TTL、LRU、年龄 fence、持久化或配额原型。

## D. 压力、覆盖矩阵与内存基准

| 覆盖 | 证据 | 结果与范围 |
| --- | --- | --- |
| readonly/匿名/不可变、不分配 receipt 或桶 | 新增 unit 1，10000 次 reads | PASS；内部查询输出仅固定数字/布尔 |
| 4096 触顶 + 20000 未见 sender、四档只告警一次 | 新增 unit 2 | PASS；20k 全 CAPACITY_BLOCKED，receipt=4096、scope=1 |
| sender 隔离、同 ID 异文、scope 冲突、缺身份/ID/link | 新增 unit 3/4 + 原 replay 回归 | PASS；旧判定顺序/证据保持 |
| handler 异常、logger 异常、同步重入 | 新增 unit 5/6 | PASS；receipt 保留、原结果/异常不被观测替换 |
| 100 次完成/过期/新 Flow、旧 ID、容量后新 ID | 新增 unit 7 | PASS；TTL/完成不清 receipt，不自动解封 |
| close/新实例 | 新增 unit 8 | PASS；明确新实例不提供跨重启去重 |
| 正式插件注册/宿主投影/Hook 路径 4096 + 新工单 + 重复 | REPLAY-C05 | PASS；四次匿名告警，触顶新工单无工具，重放不增告警 |
| 固定 cache 上限/TTL、timestamp 来源和投影、SDK 契约 | RETENTION-S01..04 | 4/4；真实叶组件 + 源码断言，未执行 DB/transport |
| 原 unit、before_agent_reply、before_dispatch 各 240 次构造调度 | 原 unit/first-turn-upstream/before-dispatch-upstream | 三组均保留并通过原安全断言；不表示首轮就绪，也非生产故障率 |
| 正向确认重放保持 ACCEPT-11 | 未修改的 dispatch-readiness.acceptance.js | PASS_OFFLINE；确认状态保持 |
| 正向首轮 Flow/Tool/Skill ACCEPT-01/05 | 同上 | FAIL_UNRESOLVED；延迟观察 Hook 时三者未就绪 |
| 完整 Runner、真实 plugin reload、SQLite 恢复、生产试用 | 未执行 | NOT_EXECUTED，不计入 45 或 4 的通过数 |

单元覆盖率：全部文件 lines **95.28%** / branches **90.04%** / functions **98.76%**；inbound-replay lines **100%** / branches **92.22%** / functions **100%**；replay-metrics lines **98.57%** / branches **94.44%** / functions **100%**。MAX_SAFE_INTEGER 饱和分支未通过真实超长运行触达，不宣称全分支覆盖。官方组件使用现有固定源码 VM loader 和明确的外围服务替身；不是完整 Gateway/Runner 集成。REPLAY-C05 使用真实 registrar、builder/finalizer/mapper、message emitter、Hook Runner 和 Factory 路径，未连接模型或 GLPI。

### 合成堆基准

[可执行脚本](../../test/bench/replay-memory.mjs) 从 BASE_COMMIT 读取原 guard，与当前 guard 用同一合成 corpus 对比。Node **v24.19.0 / linux x64**；每个样本独立子进程，先 512 次 warmup、三次 forced GC，记录满集合与空 guard 的 retained heap 差值；每组 3 次，中位数如下。默认 cap 始终 4096。

| 记录数 / scope 数 / 正文字节 | 基线 B/receipt | 观测版 B/receipt | 观测版 fill ms | 重复 2000 次 ms | metrics 10000 次 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1024 / 1 / 128 | 237.4 | 267.3 | 12.61 | 15.84 | 4.79 |
| 1024 / 1024 / 128 | 425.2 | 693.4 | 13.73 | 14.76 | 4.07 |
| 4096 / 1 / 128 | 225.0 | 253.5 | 46.12 | 14.69 | 4.35 |
| 4096 / 4096 / 128 | 412.8 | 678.0 | 55.85 | 18.66 | 4.10 |
| 4096 / 1 / 16384 | 225.0 | 259.5 | 162.91 | 71.97 | 4.37 |

在此样本中满集合增量约 1.04 MB（1 scope）至 2.78 MB（4096 scopes，十进制 MB）；指标以每条 receipt 引用共享 scope 桶，避免每条复制 scope 字符串。原始每次样本、范围与空 guard 分配均在 JSON。GC/JIT/机器噪声使个别空 guard 增量为负；这些数字不是严格上界、生产容量承诺或性能胜出结论。大正文显著增加哈希时间；内存表不计正文临时分配、Flow 业务对象或宿主整体占用。尚无生产长期驻留/高并发指标。

## 完整复现

需要 Node 支持 `--experimental-vm-modules` 和 stripTypeScriptTypes（本次 v24.19.0）、Python3、git 和公共源码下载网络。无需生产配置、凭据或服务。命令从仓库根执行；每条命令分别检查退出码，正向全套预期 exit 1 不应掩盖其他失败。

```bash
git rev-parse HEAD
node --test --experimental-test-coverage test/*.test.js
python3 test/integration/fetch-source.py /tmp/glpi-retention-locked-source
OPENCLAW_SOURCE=/tmp/glpi-retention-locked-source node --experimental-vm-modules --test test/integration/first-turn-upstream.test.js test/integration/before-dispatch-upstream.test.js test/integration/inbound-replay-upstream.test.js
OPENCLAW_SOURCE=/tmp/glpi-retention-locked-source node --experimental-vm-modules --test test/integration/retention-source.test.js
OPENCLAW_SOURCE=/tmp/glpi-retention-locked-source node --experimental-vm-modules --test --test-name-pattern=ACCEPT-11 test/integration/dispatch-readiness.acceptance.js
OPENCLAW_SOURCE=/tmp/glpi-retention-locked-source node --experimental-vm-modules --test test/integration/dispatch-readiness.acceptance.js
node test/bench/replay-memory.mjs > /tmp/replay-memory.json
git diff a5ced4800591f96563b891dceae205954dae1221 -- test/integration/dispatch-readiness.acceptance.js
git diff --check
```

最后的 acceptance diff 应为空。基线复现可在单独、干净且不用于生产的 checkout 上取 BASE_COMMIT 执行相同旧套件；内存脚本本身通过 git show 加载基线，未修改当前工作树。

## 分文件变更与运行前提

| 文件 | 改动目的 |
| --- | --- |
| lib/replay-metrics.js（新增） | 固定原因计数、匿名 scope 桶、四位阈值标记与 best-effort 报告 |
| lib/inbound-replay.js | 在原分支登记计数、暴露只读接口；receipt key/digest/校验/判定顺序与容量不变 |
| lib/handlers.js | 在同步 guard 结束后报告容量，保持原 handler 结果 |
| lib/register.js | 投影冲突增加匿名计数，没有新增 Hook |
| test/replay-metrics.test.js（新增） | 8 项容量/长期流量/隐私/异常/生命周期回归 |
| test/integration/inbound-replay-upstream.test.js | 新增真实官方组件路径容量测试 REPLAY-C05 |
| test/integration/retention-source.test.js（新增） | 4 项固定组件/源码边界验证 |
| test/integration/source-lock.json | 155 个固定文件哈希，新增审计/叶组件依赖 |
| test/bench/replay-memory.mjs（新增） | 可复现基线/当前合成内存对照 |
| README、旧 replay 报告、本文/结果/原始输出 | 更新最新结果、保留历史证据和未完成项 |

完整补丁可由 `git diff BASE_COMMIT NEW_COMMIT` 或原 PR Files changed 复核。未更改首轮候选、业务字段、确认、工具证据、Shadow 判定或已有正向验收文件。

**部署前提（本任务未执行）**：正式人工审查本补丁；确认固定 host SDK、部署渠道的原生 ID/身份投影及 Shadow 日志采集；验证独立组件之外的真实 runner/reload 和实例内存生命周期；解决首次可用性与留存容量的阻塞，并批准升级交接/业务窗口方案。旧内存 receipt 不会因为更新代码自动迁移，不能把重启作为释放容量的安全操作。老板免确认、无 sender Webchat、缺少出站关联、服务器迁移/真实默认负责人证据等既有阻塞仍见前序报告；直接 REST/MCP 绕过插件仍不受强制控制。

**回滚**：仅在代码仓库审查后 revert 本次提交，可移除观测代码并恢复 a5ced48 的同一 replay 语义；没有 DB schema 或配置迁移。未部署所以本轮无需生产回滚。若将来部署后需回滚，必须另行处理实例生命周期/在途消息与 receipt 交接；代码 revert 不恢复已经丢失的内存 ledger，也不授予 restart/reload 权限。运行中监控异常应继续原 fail-closed 业务规则，不能清理 receipt 解封。

停止于审计、观测、设计、离线测试和原 Draft PR 交付。长期可用性、可信时间年龄 fence、宿主持久化原子性均未获证明，**ENFORCE_READY=NO**。
