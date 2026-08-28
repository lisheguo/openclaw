---
summary: "OpenClaw responses-cache.7 长任务生命周期修复、升级与验收说明"
read_when:
  - 准备从 responses-cache.6 升级到 responses-cache.7
  - 使用 timeoutSeconds 0 运行长任务或 Heartbeat
  - 验收自托管模型超时分类和 ReplyOperation 收尾
title: "responses-cache.7 长任务生命周期升级与验收"
---

# responses-cache.7 长任务生命周期升级与验收

`v2026.7.1-2-responses-cache.7` 是基于官方 `v2026.7.1-2` 和定制 `.6` 的候选版本。
本文描述候选代码；在分支和 Tag 真正创建前，不应把它当作已发布版本下载或部署。

## 本次候选修复

| 任务                | 修复                                                 | 预期结果                                                      |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| `TEST-20260828-001` | 自托管首事件分类与流中空闲分类共用同一 locality 事实 | vLLM、SGLang、LM Studio 等使用 FQDN 时仍采用 300 秒首事件保护 |
| `TEST-20260828-002` | Heartbeat 原样继承全局 `timeoutSeconds: 0`           | 不再被错误转换为 1 秒                                         |
| `TEST-20260828-003` | 补齐根依赖 `node-llama-cpp@3.18.1` 的 pnpm lockfile  | `pnpm install --frozen-lockfile` 不再因 importer 不一致失败   |
| `TEST-20260828-004` | 更新配置、Provider、Heartbeat 和发布候选文档         | 人和 OpenClaw 都能区分已发布 `.6` 与未发布 `.7` 候选          |

候选还包含归档中已审计的 Gate 1 和 Gate 2A 基础修复：

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

真实“无事件 120/300 秒”测试耗时较长。发布候选可以先用 fake timers 的源码回归作为
阻断证据，再在虚拟机进行一轮受控真实超时测试；不要通过杀死 Gateway 模拟 Provider 超时。

## 发布候选检查

- 代码、测试、lockfile 和文档必须来自同一 Commit。
- 创建 `.7` 分支后再修改 README 中的分支状态。
- 只有候选验收完成后才创建 `v2026.7.1-2-responses-cache.7` Tag。
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
