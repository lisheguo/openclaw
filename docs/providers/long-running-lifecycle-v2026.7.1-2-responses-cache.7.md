---
summary: "OpenClaw responses-cache.7 长任务生命周期修复、升级与验收说明"
read_when:
  - 准备从 responses-cache.6 升级到 responses-cache.7
  - 使用 timeoutSeconds 0 运行长任务或 Heartbeat
  - 验收自托管模型超时分类和 ReplyOperation 收尾
title: "responses-cache.7 长任务生命周期升级与验收"
---

# responses-cache.7 长任务生命周期升级与验收

`v2026.7.1-2-responses-cache.7` 是基于官方 `v2026.7.1-2` 和定制 `.6` 的个人定制版本，
不是 OpenClaw 官方上游发行版。

## 本次发布修复

| 任务                | 修复                                                          | 预期结果                                                      |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| `TEST-20260828-001` | 自托管首事件分类与流中空闲分类共用同一 locality 事实          | vLLM、SGLang、LM Studio 等使用 FQDN 时仍采用 300 秒首事件保护 |
| `TEST-20260828-002` | Heartbeat 原样继承全局 `timeoutSeconds: 0`                    | 不再被错误转换为 1 秒                                         |
| `TEST-20260828-003` | 移除误放在根包的 `node-llama-cpp@3.18.1` 并对齐 pnpm lockfile | 根包不再携带未使用依赖，frozen-lockfile 安装通过              |
| `TEST-20260828-004` | 更新配置、Provider、Heartbeat 和正式发布文档                  | 人和 OpenClaw 都能识别 `.7` 的行为、配置与验收范围            |

本版本还包含归档中已审计的 Gate 1 和 Gate 2A 基础修复：

- `agents.defaults.timeoutSeconds: 0` 关闭整轮 Agent 的外层截止时间。
- 不限时运行仍保留 Provider 健康保护，避免请求永久无首事件或云端流永久静默。
- 本地端点允许长时间流中静默，但请求创建阶段仍有 300 秒上限。
- 终态 ReplyOperation 最多保留 60 秒用于所有者完成 delivery/cleanup，超时后释放会话 lane。

## 配置

默认 48 小时截止时间适合多数部署。只有长任务确实需要时才设置：

```json5
{
  agents: {
    defaults: {
      timeoutSeconds: 0,
    },
  },
}
```

不要把 `0` 理解为关闭所有健康检查：

| 模型端点                      | 隐式首事件保护 | 隐式流中空闲保护 |
| ----------------------------- | -------------: | ---------------: |
| 云端 Provider                 |         120 秒 |           120 秒 |
| 已识别自托管 Provider         |         300 秒 |           300 秒 |
| 回环、私网、`.local` 本地端点 |         300 秒 |             关闭 |

显式 `models.providers.<id>.timeoutSeconds` 会设置该 Provider 的请求和流空闲上限；较短的
Agent 或单次运行上限仍优先。Ollama `*:cloud` 模型保持云端分类。

Heartbeat 未设置自己的 `timeoutSeconds` 时继承全局值，包括 `0`。Heartbeat 专用
`agents.defaults.heartbeat.timeoutSeconds` 和 `agents.list[].heartbeat.timeoutSeconds` 仍接受
正整数，用于为 Heartbeat 单独设置有界运行时间。

## 升级前检查

```bash
git rev-parse HEAD
git status --short
openclaw config validate
openclaw status
```

确认当前版本是 `.6`，工作区没有未备份修改，并备份生效的 `openclaw.json`、会话数据和
安装目录。不要在报告中复制 API Key、认证令牌或完整 response ID。

## 源码验收

至少运行以下聚焦测试：

```bash
node scripts/run-vitest.mjs src/agents/embedded-agent-runner/run/llm-idle-timeout.test.ts
node scripts/run-vitest.mjs src/infra/heartbeat-runner.model-override.test.ts
node scripts/run-vitest.mjs src/agents/subagent-depth.test.ts
node scripts/run-vitest.mjs src/auto-reply/reply/reply-run-registry.test.ts
node scripts/run-vitest.mjs src/config/zod-schema.agent-defaults.test.ts
pnpm install --lockfile-only --offline --frozen-lockfile
```

验收点：

1. vLLM、SGLang、LM Studio 的 FQDN 首事件上限为 300 秒。
2. 普通云端 FQDN 保持 120 秒；Ollama Cloud 不被误判为本地或自托管。
3. 有限的短 run timeout 仍能压低首事件和流中空闲上限。
4. Heartbeat 从全局配置继承 `0`，传入的 `timeoutOverrideSeconds` 仍为 `0`。
5. ReplyOperation 在正常 complete 时清理定时器，在所有者未 complete 时能有界释放。
6. frozen lockfile 验证不修改 `pnpm-lock.yaml`。

## 生产环境冒烟

使用临时会话，不修改业务会话：

1. 用现有有限超时配置完成一轮普通云端模型对话。
2. 设置 `agents.defaults.timeoutSeconds: 0`，验证长任务不会在 1 秒或旧外层上限被中止。
3. 让自托管模型完成首轮和工具续接；确认没有 120 秒误分类日志。
4. 触发一次 Heartbeat，确认它继承 `0`，同时 Provider 无首事件时仍会触发有限健康保护。
5. 测试后确认 Gateway PID、配置 SHA-256、源码和 dist 文件未被测试修改。

真实“无事件 120/300 秒”测试耗时较长。发布验收使用 fake timers 的源码回归作为阻断
证据，并在虚拟机进行受控真实超时测试；不要通过杀死 Gateway 模拟 Provider 超时。

## 已完成验收

- Long-running lifecycle：`timeoutSeconds: 0` 的逻辑运行持续 15 分 23 秒，未出现
  `timeoutMs=900000`，最终 `timedOut=false`。
- LLM liveness：云端 120 秒、自托管 300 秒、本地端点保留创建/首事件保护；自托管 FQDN
  分类专项回归通过。
- Heartbeat：未设置专用超时时正确继承全局 `timeoutSeconds: 0`。
- ReplyOperation：terminal owner hang 在 60 秒内有界收尾；重复 terminal 不续命，及时
  `complete()` 会取消 timer，会话 lane 可以重新 admission。
- Auto-Compaction：真实运行完成 `overflow → compact_only → transcript rotation`，无需用户
  介入继续执行，保持同一 `runId` 并最终成功。
- Build/Test：frozen lockfile、build 均通过；RC.7 生命周期专项测试 259/259 通过。

## 已知非阻断项

- `qwen3.8-max` 配置的 256K 上下文与 Provider 实际 prompt ceiling 仍存在偏差。
- successor trajectory 的 `compactionCount` 记录存在展示层瑕疵，不影响压缩执行和恢复。
- `/stop` 文本快捷命令 routing 可在后续版本独立优化。

`BASELINE_WAIVER:` 本次发布仅豁免以下 `.6` 已存在债务，不表示问题已解决：

| 豁免项                                          | 状态                                                                                          | 后续要求                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `security-fast`: 15 项 High/Critical advisories | `PRESENT_IN_6=YES`<br>`INTRODUCED_BY_7=NO`<br>`NOT_FIXED_IN_7=YES`<br>`FOLLOWUP_REQUIRED=YES` | 单独的安全维护版本；不在 `.7` 中批量升级依赖                      |
| baseline lint: 7 issues                         | `PRESENT_IN_6=YES`<br>`INTRODUCED_BY_7=NO`<br>`NOT_FIXED_IN_7=YES`<br>`FOLLOWUP_REQUIRED=YES` | 独立 lint 债务清理                                                |
| existing OpenAI Responses test type errors      | `PRESENT_IN_6=YES`<br>`INTRODUCED_BY_7=NO`<br>`NOT_FIXED_IN_7=YES`<br>`FOLLOWUP_REQUIRED=YES` | 独立修复 OpenAI Responses 测试类型；不修改 `.7` production source |

`.7` 新增的 `llm-idle-timeout.test.ts` 类型错误已作 test-only 修正，不属于上述基线豁免。

## 发布检查

- 代码、测试、lockfile 和文档来自同一最终发布 Commit。
- Tag `v2026.7.1-2-responses-cache.7` 与发布分支指向该 Commit。
- Tag 创建后确认 Tag、分支和 Commit 指向一致，再提供 ZIP 下载链接。
- 百炼额度不足时明确记为 `SKIP_NO_QUOTA`，不要用 `.4` 或 `.6` 历史在线证据冒充 `.7`。

## 回滚

1. 将 symlink 或部署目录切回已验收的 `.6`。
2. 恢复升级前的配置备份；如果 `.6` 仍需长任务，可保留其他兼容字段，但不要依赖 `.7`
   对 `timeoutSeconds: 0` 的修复语义。
3. 重启 Gateway，执行 `openclaw config validate`、`openclaw status` 和一轮模型冒烟。
4. 保留失败日志、Commit、配置脱敏差异和文件 SHA-256，便于复核。

## 相关文档

- [Agent loop timeouts](/concepts/agent-loop#timeouts)
- [Heartbeat](/gateway/heartbeat)
- [vLLM](/providers/vllm)
- [`.6` item-aware compaction](./responses-item-aware-compaction-v2026.7.1-2-responses-cache.6.md)
- Repository root: `OPENCLAW_JSON_CUSTOM_CONFIG.zh-CN.md`
