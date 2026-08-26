# OpenClaw responses-cache.6 配置汇总

本文汇总个人定制版本 `v2026.7.1-2-responses-cache.6` 中与
`openclaw.json` 有关的配置。它同时供运维人员和 OpenClaw 自身读取，目标是只修改
指定模型，不覆盖已有 Provider、凭据、请求头或兼容设置。

> 本版本基于 OpenClaw 官方 `v2026.7.1-2`，不是 OpenClaw 官方发行版。
> API Key、认证令牌和完整响应 ID 不应出现在提交、截图、日志或测试报告中。

## 先判断需要哪组配置

| 使用场景                             | 需要配置                                                                                                  | 不要配置                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 百炼或 DashScope Session Cache       | `x-dashscope-session-cache`、`supportsPreviousResponseId`，自定义 Provider 名称时增加 `toolSchemaProfile` | `preserveNativeResponsesToolCallIds`、手动 `store` |
| Ark Kimi 返回原生工具调用 ID         | `supportsPreviousResponseId`、`preserveNativeResponsesToolCallIds`                                        | DashScope 请求头和 Schema Profile                  |
| Ark Responses 模型存在 1000 项硬限制 | `responsesMaxInputItems`、可选的 `responsesInputItemsSafetyMargin`                                        | 把 1000 复制给所有 Responses 模型                  |
| Ark stale response ID 自动恢复       | 无                                                                                                        | 不需要新增重试或 full-rebuild 配置                 |
| Overflow compaction 与摘要连续性修复 | 无                                                                                                        | 不需要配置内部重试计数或摘要锚点                   |

所有功能都要求目标模型实际使用相应能力。不要仅根据模型名称或 Provider 名称推断
API 能力；先确认服务端支持 Responses API、`previous_response_id` 或输入项目限制。

## 百炼和 DashScope 推荐配置

把以下字段合并到一个确定支持 Session Cache 的目标模型。保留该模型已有的
`headers`、`compat`、上下文窗口、输出上限和其他字段：

```json5
{
  models: {
    providers: {
      "bailian-token-plan": {
        // 保留已有 baseUrl、apiKey、auth 和其他 Provider 设置。
        models: [
          {
            id: "qwen3.7-plus",
            api: "openai-responses",
            headers: {
              // 与已有 headers 合并，不要替换整个对象。
              "x-dashscope-session-cache": "enable",
            },
            compat: {
              // 与已有 compat 合并，不要替换整个对象。
              supportsPreviousResponseId: true,
              toolSchemaProfile: "dashscope",
            },
          },
        ],
      },
    },
  },
}
```

配置含义：

- `x-dashscope-session-cache: "enable"` 请求百炼启用服务端 Session Cache。
- `supportsPreviousResponseId: true` 允许 OpenClaw 保存响应 ID，并在下一轮只发送增量
  输入和 `previous_response_id`。
- `toolSchemaProfile: "dashscope"` 把工具 Schema 中百炼不支持的
  `patternProperties` 转换为 `additionalProperties`。Provider 使用自定义名称时应显式
  配置；如果已有其他 Profile，不要直接覆盖。
- `store=true` 由 Responses 会话链逻辑自动处理，不要手动加入配置。

## Ark Kimi 推荐配置

只有确认 Ark 托管的 Kimi 模型返回 `read_0`、`exec_7` 等原生工具调用 ID，并且续接
请求要求逐字复用该 ID 时，才打开原生 ID 保留：

```json5
{
  models: {
    providers: {
      "volcengine-agent-plan": {
        models: [
          {
            id: "kimi-k3",
            api: "openai-responses",
            compat: {
              supportsPreviousResponseId: true,
              preserveNativeResponsesToolCallIds: true,
              responsesMaxInputItems: 1000,
              responsesInputItemsSafetyMargin: 150,
            },
          },
        ],
      },
    },
  },
}
```

规则：

- `preserveNativeResponsesToolCallIds` 默认关闭，只应配置在已验证需要它的模型上。
- 不要在整个 Ark Provider 上统一开启原生 ID 保留。豆包等对照模型应继续走默认 ID
  规范化逻辑。
- `responsesMaxInputItems: 1000` 只适用于服务端明确存在 1000 项硬限制的模型；它不是
  所有 `openai-responses` 模型的通用限制。
- 安全边距为 150 时，会在估算值达到 `1000 - 150 = 850` 项时提前压缩；`.6`
  会继续压到约 `850 - 150 = 700` 项的安全目标。

如果 Ark Kimi 模型没有输入项目硬限制，只保留前两个字段：

```json5
compat: {
  supportsPreviousResponseId: true,
  preserveNativeResponsesToolCallIds: true,
}
```

## Ark 非 Kimi 模型配置

Ark 豆包等模型不需要原生工具调用 ID 保留。仅在 Provider 已确认支持
`previous_response_id`，且该模型存在输入项目硬限制时配置：

```json5
{
  id: "<ARK_MODEL_ID>",
  api: "openai-responses",
  compat: {
    supportsPreviousResponseId: true,
    responsesMaxInputItems: 1000,
    responsesInputItemsSafetyMargin: 150,
  },
}
```

将 `<ARK_MODEL_ID>` 替换为真实模型 ID。不要添加
`preserveNativeResponsesToolCallIds`，除非实际错误和回归测试证明该模型也要求保留
Provider 原生 ID。

## 输入项目限制的两种配置层级

推荐在模型级配置，这样不会影响同一 Provider 下没有该限制的模型：

```json5
{
  id: "<MODEL_ID>",
  api: "openai-responses",
  compat: {
    responsesMaxInputItems: 1000,
    responsesInputItemsSafetyMargin: 150,
  },
}
```

如果同一 Provider 下的所有 Responses 模型都具有相同限制，也可以设置 Provider
默认值。Provider 级字段位于 Provider 对象，不在 `compat` 内：

```json5
{
  models: {
    providers: {
      "<PROVIDER_ID>": {
        responsesMaxInputItems: 1000,
        responsesInputItemsSafetyMargin: 150,
        models: [
          // 保留已有模型定义。
        ],
      },
    },
  },
}
```

解析优先级：

1. 模型级 `compat.responsesMaxInputItems`；
2. Provider 级 `responsesMaxInputItems`；
3. 旧版 `agents.defaults.compaction.maxInputItems`；
4. 未解析到上限时关闭按项目数压缩。

安全边距优先级：

1. 模型级 `compat.responsesInputItemsSafetyMargin`；
2. Provider 级 `responsesInputItemsSafetyMargin`；
3. 默认值 150。

`responsesInputItemsSafetyMargin` 必须是非负整数，可以设置为 0；没有有效上限时，
安全边距不生效。旧版 Agent 级配置只作为兼容回退，不建议新部署继续使用：

```json5
{
  agents: {
    defaults: {
      compaction: {
        maxInputItems: 1000,
      },
    },
  },
}
```

`.6` 没有增加新的配置字段。解析到上限和安全边距后，运行时先计算触发阈值
`maxInputItems - safetyMargin`，再为压缩结果保留一个安全边距。以 1000/150 为例，
850 项触发，目标约为 700 项。实际保留数量可能因完整消息和工具调用/结果配对边界略低于
目标，但不得为了精确凑数拆开配对。即使安全边距配置为 0 或 1，运行时也会至少预留
2 个历史项目位置，确保重新加入当前输入后不会立即再次触发同一阈值。

## 配置字段速查

| 完整路径                                                                | 类型与默认值                     | 作用范围     | 说明                                            |
| ----------------------------------------------------------------------- | -------------------------------- | ------------ | ----------------------------------------------- |
| `models.providers.*.models[].headers.x-dashscope-session-cache`         | 字符串；未设置                   | 模型         | 百炼 Session Cache 请求头，值为 `"enable"`      |
| `models.providers.*.models[].compat.supportsPreviousResponseId`         | 布尔；默认关闭                   | 模型         | 允许 Responses 增量续接                         |
| `models.providers.*.models[].compat.toolSchemaProfile`                  | 字符串；未设置                   | 模型         | 百炼使用 `"dashscope"` 执行工具 Schema 兼容转换 |
| `models.providers.*.models[].compat.preserveNativeResponsesToolCallIds` | 布尔；默认关闭                   | 模型         | 保留 Provider 原生工具调用 ID                   |
| `models.providers.*.models[].compat.responsesMaxInputItems`             | 正整数；未设置                   | 模型         | Responses 输入项目硬上限                        |
| `models.providers.*.models[].compat.responsesInputItemsSafetyMargin`    | 非负整数；有效上限存在时默认 150 | 模型         | 在硬上限前提前压缩                              |
| `models.providers.*.responsesMaxInputItems`                             | 正整数；未设置                   | Provider     | Provider 下模型的默认输入项目上限               |
| `models.providers.*.responsesInputItemsSafetyMargin`                    | 非负整数；有效上限存在时默认 150 | Provider     | Provider 下模型的默认安全边距                   |
| `agents.defaults.compaction.maxInputItems`                              | 正整数；未设置                   | 全局兼容回退 | 旧配置入口，不建议新配置使用                    |

## 升级后自动生效的规则

以下行为由 `.6` 源码实现，不需要写入 `openclaw.json`：

- Ark 返回 `InvalidParameter.PreviousResponseNotFound` 时，准确识别 stale response
  ID，并且只执行一次不带旧 ID 的 full rebuild。
- 百炼原有的 stale response ID 判断继续保留，普通 Schema 400、401、429、500
  不会被误判。
- 当前用户输入会计入 Responses 输入项目估算，越过阈值前先压缩。
- 输入项目压缩会断开旧 `previous_response_id` 链，并在完整重建成功后保存新 ID。
- item-aware compaction 会把压缩结果降到计算出的安全目标，并保持消息与工具调用/结果
  的完整边界。
- `compactionSummary` 会作为真实会话锚点，连续压缩后不丢失摘要上下文。
- overflow 恢复预算会在正常尝试后重置；已经持久化的当前用户消息不会被重复回放。
- 严格校验 Provider、API、模型、base URL、Session、认证 Profile 和响应来源，避免
  跨模型、跨账号或跨会话错误复用响应 ID。

不要在配置中自行增加 `store`、`fullRebuild`、`overflowCompactionAttempts`、
`compactionSummary` 或 stale ID 重试次数。这些不是本定制版公开的配置字段。

## 让 OpenClaw 安全修改配置

当要求 OpenClaw 修改 `openclaw.json` 时，应给它以下约束：

1. 通过 OpenClaw 正常配置发现机制定位当前生效文件，不创建第二份配置。
2. 修改前读取完整文件并备份；只匹配指定 Provider 和模型 ID。
3. 确认模型使用 `api: "openai-responses"`，并确认服务端能力。
4. 只把需要的键合并进现有 `headers` 或 `compat`，不替换整个对象。
5. 保留所有无关 Provider、模型、注释、凭据和格式。
6. 不显示、复制或改写 API Key、Token 和认证 Profile 内容。
7. 修改后展示脱敏差异，运行配置验证，再重启 Gateway。
8. 重启后确认目标模型可用，并进行一轮新会话和一轮增量会话验证。

建议验证命令：

```bash
openclaw config validate
openclaw models status --json
openclaw gateway restart
openclaw status
```

## 回滚

- 停用百炼增量会话：移除目标模型的 `supportsPreviousResponseId`，并在不被其他功能
  使用时移除 `x-dashscope-session-cache`。
- 停用百炼 Schema 转换：仅在确认不再需要时移除 `toolSchemaProfile`；不要用其他值
  覆盖未知的现有 Profile。
- 停用 Ark Kimi 原生 ID 保留：移除
  `preserveNativeResponsesToolCallIds`，不要同时关闭仍然需要的 Session Cache。
- 停用输入项目保护：移除模型或 Provider 的 `responsesMaxInputItems` 和
  `responsesInputItemsSafetyMargin`。旧 Agent 级回退应在所有目标模型迁移完成后再移除。
- 不要清理历史会话中的 response ID；关闭 capability 后 OpenClaw 会忽略它们。

## 相关文档

- [`.6` item-aware compaction 升级与验收说明](docs/providers/responses-item-aware-compaction-v2026.7.1-2-responses-cache.6.md)
- [`.5` 升级与验收说明](docs/providers/ark-kimi-responses-v2026.7.1-2-responses-cache.5.md)
- [Ark Kimi 原生工具调用 ID](docs/providers/ark-kimi-native-responses-tool-call-ids.md)
- [Ark stale response ID 修复](docs/providers/ark-responses-stale-response-id-v2026.7.1-2-responses-cache.4.md)
- [DashScope Responses Session Cache](docs/providers/dashscope-responses-session-cache.md)
