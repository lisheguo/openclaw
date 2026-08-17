# Ark Responses stale response ID 修复与升级测试说明

适用版本：`v2026.7.1-2-responses-cache.4`
适用 Provider：Ark（火山方舟）`openai-responses`
基线版本：OpenClaw 官方 `v2026.7.1-2`

## 1. 修复目标

Ark 会在 `previous_response_id` 过期、不存在或不可继续使用时返回 HTTP 400。典型错误为：

```text
code: InvalidParameter.PreviousResponseNotFound
param: previous_response_id
message: Previous response with id ... not found.
```

旧版本只识别百炼的 `Not found previous_response_id` 文本，因此 Ark 错误不会进入会话重建路径，业务请求会直接失败。

## 2. .4 的处理方式

`v2026.7.1-2-responses-cache.4` 扩展了 `isStalePreviousResponseIdError()`：

- 只处理 HTTP 400，兼容 `status`、`statusCode` 和 `response.status`。
- 精确识别 Ark 错误码 `InvalidParameter.PreviousResponseNotFound`。
- 兼容 Ark 的 `Previous response with id ... not found` 消息格式。
- 支持 SDK 错误对象、JSON 字符串 `body`、对象 `body` 和 `response.data`。
- 保留百炼 `Not found previous_response_id` 的原有识别规则。
- 兜底规则必须同时满足 `param=previous_response_id` 和明确的失效语义。

识别成功后，OpenClaw 自动执行一次不携带旧 `previous_response_id` 的 `full-rebuild`。重建成功后保存新的 `response.id`，下一轮恢复增量会话。重建路径只执行一次，不会形成循环重试。

## 3. 不会被误判的错误

以下错误不会标记为 `reason=stale-response-id`：

- 工具 JSON Schema 或 `patternProperties` 校验失败；
- 401 鉴权失败；
- 429 限流；
- 500 服务端错误；
- 其他 `InvalidParameter`，例如模型不存在；
- `param=previous_response_id` 但消息没有过期、不存在等语义；
- 无法解析的非 JSON 错误体。

## 4. 升级方式

推荐使用固定 Git Tag，避免分支后续变化影响部署：

```bash
git fetch origin --tags
git checkout v2026.7.1-2-responses-cache.4
pnpm install --frozen-lockfile
pnpm build
```

如果使用发布 ZIP：

```text
https://github.com/lisheguo/openclaw/archive/refs/tags/v2026.7.1-2-responses-cache.4.zip
```

升级前应备份当前安装目录和 `openclaw.json`。本修复不要求新增 Ark 配置项，也不会修改 API Key。

## 5. 配置要求

继续使用现有 Ark Responses Provider 配置即可。确认模型使用的是 `openai-responses` API，并允许服务端保存响应：

- 请求包含 `store=true`；
- 正常续接请求包含 `previous_response_id`；
- 首轮或重建请求不包含旧 `previous_response_id`。

## 6. 升级后测试清单

### 6.1 基础健康检查

1. 启动或重启 Gateway。
2. 确认进程为 active/running。
3. 检查启动日志中没有 JS 语法错误、模块加载错误或 Provider 配置错误。

### 6.2 Ark 正常增量会话

1. 第一轮发送普通业务问题，确认 HTTP 200，并记录返回的 `response.id`。
2. 第二轮在同一会话发送追问。
3. 日志应显示 `mode=incremental`、`hasPreviousResponseId=true` 和 `store=true`。
4. 模型应正确引用上一轮上下文。

### 6.3 Ark stale ID 恢复

使用测试会话或可控测试环境注入无效/过期的 Ark response ID。预期：

1. Ark 首次返回 HTTP 400 和 `InvalidParameter.PreviousResponseNotFound`。
2. OpenClaw 日志出现：

```text
[responses-session] mode=full-rebuild reason=stale-response-id provider=... model=...
```

3. fallback 请求不包含旧 `previous_response_id`。
4. full-rebuild 只执行一次并成功返回。
5. 新的 `response.id` 被保存，下一轮重新进入 incremental。

### 6.4 百炼回归

使用百炼模型完成两轮正常增量会话，并验证无效 ID 的 `Not found previous_response_id` 仍触发一次 full-rebuild。普通工具 Schema 400 不应标记为 `stale-response-id`。

### 6.5 负例回归

至少验证 Schema 400、401、429、其他参数 400 和 500 均不会进入 full-rebuild。出现这些错误时，应保留其真实错误类型，便于排查。

## 7. 源码自动化验证

仓库包含专项测试：

```bash
pnpm exec vitest run src/agents/openai-transport-stream.stale-response.test.ts
```

发布前结果：28/28 通过（同一组 14 个用例在两个工作区执行），`oxlint` 为 0 errors / 0 warnings，格式与差异检查通过。

## 8. 验收判定

满足以下条件即可判定升级成功：

- Ark 正常会话连续两轮成功；
- Ark stale ID 能触发且仅触发一次 full-rebuild；
- fallback 不携带旧 ID；
- 后续会话保存并使用新的 response ID；
- 百炼原有 stale ID 恢复能力未回归；
- Schema、鉴权、限流及服务端错误没有被误判。

## 9. 回滚

如果升级后发现异常，停止 Gateway，恢复升级前的安装目录或切回上一版本 `v2026.7.1-2-responses-cache.3`，然后重新构建并启动。`openclaw.json` 无需因本修复而变更。

## 10. 相关链接

- [.4 固定分支](https://github.com/lisheguo/openclaw/tree/fix/ark-stale-response-id)
- [.4 Git Tag](https://github.com/lisheguo/openclaw/tree/v2026.7.1-2-responses-cache.4)
- [.4 源码 ZIP](https://github.com/lisheguo/openclaw/archive/refs/tags/v2026.7.1-2-responses-cache.4.zip)
