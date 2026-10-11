# glpi-ticket-gate

OpenClaw 插件：GLPI 工单模板门控（SHADOW_ONLY）。

Phase2 P0 开发交付见 [审计与验收报告](docs/phase2-p0-001/REPORT.md)：固定 OpenClaw v2026.9.9；整体 **PARTIAL**，首轮时序 **BLOCKED**，无身份 Webchat 和无 runId 出站路径不支持。未部署，未实现 Enforce。

最新 [Replay 容量观测与留存设计](docs/replay-retention-002/REPORT.md)：新增匿名计数和 70/85/95/100% 首次水位告警；523/523 单元、45/45 官方组件、4/4 留存审计测试通过。默认容量仍为 4096，满后仍拒绝新 mutation；没有 TTL/淘汰/扩容/持久化。长期耗尽风险尚未解决，可信消息年龄边界未证明，宿主去重安全复用仍 UNKNOWN。

[入站重放修复](docs/inbound-replay-001/REPORT.md) 保持有效：同一原生消息重复到达时，在读取 Flow 前退出，保留已确认草稿，ACCEPT-11 通过。首轮 ACCEPT-01/05 仍失败，完整 Runner 未执行；receipt 不随 Flow TTL/完成删除，不保证跨重启或多 Gateway 去重。

[before_dispatch 审计](docs/before-dispatch-0099/REPORT.md) 的正文来源和消息准入关联阻塞仍在；候选未接入运行插件。DEV-04 仍 BLOCKED，不能据此开始群试用。

当前最终确认须由发起人回复完整预览消息或其确认码。缺项补齐不算确认，ownerSenderIds 不授予跨人确认或免确认权限；关键字段改变后必须重新预检、预览和本人确认。

已按 [契约评论 #6060561318](https://github.com/lisheguo/glpi-ticket-gate/pull/3#issuecomment-6060561318) 和固定 MCP v3.2.0 源码修正 P0：`glpi_ticket_preflight` 返回三段正文、`final_preview` 与不含 `status` 的 `create_params`；创建回执只绑定工单 ID，后续 solution/update/readback 才能证明目标 2/5/6。创建或解决方案结果未知时不建议重复提交；创建中及已创建后不再返回创建参数。所有操作仍只作 Shadow 观察。

[完整 Skill 比对报告](docs/phase2-p0-001/skill-contract-reviewed.md) 区分 SOURCE_CONFIRMED / HISTORICAL_OBSERVED / UNKNOWN：本环境附件下载失败，但已通过父环境审阅后转述取得完整契约。解决方案现绑定处理方法和结果；类别须按1–8规则推导并展示，优先级限1–5、默认3，非默认值须本人明确指令证据。服务器迁移、默认负责人实时核验及原身份/时序/出站关联/老板例外阻塞仍保留，`WOULD_ALLOW` 不是生产迁移证明。

在工单录入会话中强制执行「7 项最小信息集」预检与证据链；shadow 模式只记录判定结果（WOULD_ALLOW / WOULD_BLOCK），**永不阻断**生产工单创建。

## 功能

- **工单意图检测**（`message_received`）：命中「新增工单」等意图即建立 flow；每 (session, sender) 同时最多 1 个 pending flow，TTL 默认 2 小时
- **流程规则注入**（`before_prompt_build`）：flow 有效期内向会话注入外部 SKILL.md 工单录入流程规则（每次真实读文件，sha256 随日志记录）
- **7 项预检工具 `glpi_ticket_preflight`**：**Flow 门控动态暴露**——仅当存在本人 active flow 时进入本轮工具面；无 flow 时 factory 返回 null，普通聊天零 schema 开销。纯结构化校验，不调 GLPI、不写库、不建单；每次调用额外返回**证据链快照**（preflight/entity/preview/confirmed 四项状态 + 距离可录入还缺什么 + 下一步，可程序化验证反馈）
- **实体提取诊断观测（FIX-GLPI-ENTITY-EVIDENCE-001A）**：`analyzeEntityExtraction` 对 hook 侧实体查询结果输出四态观测（COMPLETE / ZERO / PARTIAL_SUSPECTED / UNKNOWN）+ parse/fallback/结构/尺寸/截断信号；`glpi_list_entities` 后输出统一日志 `event=entity_lookup`（只记结构与计数，不落实体名等业务值）。**仅观测**：不改变提取行为、matched 集与 Gate 判定
- **实时查库证据**（`after_tool_call`，matcher=`glpi__glpi_list_entities`）：记录本次实体匹配结果
- **预览 / 确认证据**（`message_sent` / `message_received`）：预览送达后记录；仅真实入站确认词可置 confirmed（模型自述确认不算数）
- **Shadow 判定与阶段观察**：create、add_solution、update_ticket、get_ticket 的前后 Hook 关联本人 Flow、run/call 和参数；保留预检/实体/预览/确认检查，记录 WOULD_ALLOW / WOULD_BLOCK，永不 block。create 成功不清 Flow，目标状态回读后才完成；服务端迁移仍 UNKNOWN。

## 安装

```bash
git clone https://github.com/lisheguo/glpi-ticket-gate.git
openclaw plugins install --link /path/to/glpi-ticket-gate
```

`openclaw.json` 示例（非 bundled 插件的 hook 注入需要显式授权）：

```json
{
  "plugins": {
    "entries": {
      "glpi-ticket-gate": {
        "enabled": true,
        "config": {
          "mode": "shadow",
          "skillPath": "/path/to/glpi-ticket/SKILL.md"
        },
        "hooks": {
          "allowConversationAccess": true,
          "allowPromptInjection": true
        }
      }
    }
  }
}
```

## 配置项

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `shadow` | Phase1 仅支持 shadow；ENFORCE 未实现 |
| `ownerSenderIds` | `[]` | 仅保留解析兼容；不授予任何确认或绕过权限 |
| `skillPath` | 内置路径 | 工单模板规则文件（SKILL.md）路径，部署时必须按环境配置 |
| `ttlMs` | `7200000` | flow 过期时间（毫秒） |
| `entityListToolId` | `glpi__glpi_list_entities` | 实体查库证据 hook 的 matcher |
| `createTicketToolId` | `glpi__glpi_create_ticket` | 建单判定 hook 的 matcher |

## 测试

```bash
node --test test/*.test.js
```

当前 523 项单元测试通过；45 项固定 OpenClaw 官方组件回归和 4 项留存契约审计通过。命令、覆盖率和原始输出见[最新报告](docs/replay-retention-002/REPORT.md)。原单元、before_agent_reply 和 before_dispatch 三组各 240 次构造调度均保留。`before_agent_reply` 虽被提前等待，但其正文和跨 Hook 消息 ID 契约不足；测试原型未接入插件，DEV-04 仍 BLOCKED。ACCEPT-01/05 正向验收失败，ACCEPT-11 通过；完整 Runner 和真实 reload 未执行，不能把组件断言通过解释为首轮可用性或生产验收。业务状态路径与错误恢复均使用离线虚构数据。

## 设计约束

- **MODE=SHADOW 永不阻断**：只记录 WOULD_ALLOW / WOULD_BLOCK；ENFORCE 属后续阶段
- **FlowState 仅进程内 Map**：不落库、fail-closed、网关重启即清空（预期行为）
- **依赖外部组件**：GLPI MCP 工具（`glpi__glpi_list_entities` / `glpi__glpi_create_ticket`）与工单模板规则文件 SKILL.md（不在本仓库，需自行提供并通过 `skillPath` 指定）
- 日志脱敏 sessionKey / senderId
- 此次源码审计固定 OpenClaw v2026.9.9；其他版本兼容性未验证

## 历史记录：gen10 加固（确认语义已由 Phase2 覆盖）

以下记录仅保留历史背景；“补齐即确认”“创建回执即完成”“创建结果未知可直接重试”等旧行为已被上面的 Phase2 规则覆盖。

### gen10 加固（HARDEN-GLPI-GATE-20261003，2026-10-03 老板批准）

PR#1（v1.1）评审后的精选吸收——不切换确认流程（补齐即确认保留）：

- **单实体包络完整性**：`extractSingleEntityId` 拒绝 `isError:true`/多文本块/多记录；`glpi_get_entity` 请求实体 ID（事件 `params`）与结果 ID 必须一致，别名冲突拒绝，params 缺失 fail-closed。
- **严格归属**：查库/窄确认/建单三个证据 handler 只写发起人本人 flow，无本人 flow 即跳过，不再回退到 session 内他人 flow。
- **建单结果关联**：WOULD_ALLOW 只登记提交中（toolCallId），新增 HOOK-05b `after_tool_call` 关联建单结果——成功返回非零工单 ID 才 complete flow，失败/异常/未关联保留证据可重试；在途重复建单记 `CREATE_IN_PROGRESS`（共 7 个 hook 注册）。
- **最小内容绑定**：窄证据实体必须等于预检实体，提交参数中的标题/状态与预检登记一致，不一致记 `CONTENT_MISMATCH`。
- **小加固**：flow key 防分隔符碰撞（JSON.stringify）、TTL 边界即过期、占位词扩充（待补充/待填写/未提供/尚未提供/unknown）、非字符串字段一律按缺项、整数超安全范围拒绝、意图识别空格/IT 大小写归一、补齐 marker 小数修复（"1、耗时1.5小时"不再误判两段）、handler 错误日志不落原文。
- **配置声明**：`entityGetToolId` 已入 `configSchema`（保持 additionalProperties:false）。

测试 84/84（72 存量 + H-01..H-12 加固回归）。Shadow 模式照旧，ENFORCE 不涉及。

## License

MIT
