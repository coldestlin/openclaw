# OpenClaw 配置说明

本文档说明 OpenClaw 配置文件（`openclaw.json`）的相关机制，包括环境变量替换和 models 配置更新机制。

---

## 第一章：环境变量替换机制

OpenClaw 支持在 JSON 配置文件的字符串值中使用 `${VAR_NAME}` 语法引用环境变量：

```json
{
  "gateway": {
    "auth": {
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    }
  }
}
```

### 语法规则

- 变量名必须是**大写字母、数字和下划线**组成
- 必须以**字母或下划线**开头
- 正则表达式：`/^[A-Z_][A-Z0-9_]*$/`

有效示例：

- `${API_KEY}`
- `${OPENAI_API_KEY}`
- `${_PRIVATE_VAR}`
- `${VAR_123}`

无效示例（不会被替换）：

- `${lowercase}` - 小写字母
- `${MixedCase}` - 混合大小写
- `${123_VAR}` - 数字开头

### 配置加载流程

OpenClaw 加载配置时的处理顺序：

```
1. 读取 JSON 配置文件
2. 解析 $include 指令
3. 应用 env.vars 到 process.env（仅当变量不存在时）
4. 替换所有 ${VAR_NAME} 引用
5. 验证配置
```

### 关键点

- `env.vars` 中定义的值会**先**注入到 `process.env`
- 然后**再**进行 `${VAR}` 替换
- 这意味着 `env.vars` 可以提供默认值，同时允许系统环境变量覆盖

### env.vars 的作用

`env.vars` 用于定义环境变量的**默认值**：

```json
{
  "env": {
    "vars": {
      "OPENCLAW_DEFAULT_MODEL": "gpt-4",
      "OPENCLAW_WORKSPACE": "/data/workspace"
    }
  }
}
```

#### 工作原理

1. 如果系统环境变量 `OPENCLAW_DEFAULT_MODEL` **已存在** → 使用系统的值
2. 如果系统环境变量 `OPENCLAW_DEFAULT_MODEL` **不存在** → 使用 `env.vars` 中的值

#### 重要：env.vars 不支持占位符

**错误写法**：

```json
{
  "env": {
    "vars": {
      "API_KEY": "${API_KEY}" // 错误！这样写没有意义
    }
  }
}
```

如果这样写，当 `API_KEY` 环境变量不存在时：

- 字符串 `"${API_KEY}"` 会被写入 `process.env.API_KEY`
- 后续替换时，配置值会变成字面字符串 `"${API_KEY}"`

**正确写法**：

```json
{
  "env": {
    "vars": {
      "API_KEY": "default-key-value" // 写实际的默认值
    }
  }
}
```

### 不支持 Shell 风格的默认值语法

OpenClaw **不支持** `${VAR:-default}` 语法：

```json
{
  "gateway": {
    // 错误！:-default 不会被解析
    "port": "${PORT:-8080}"
  }
}
```

`PORT:-8080` 不是有效的变量名（包含 `:-`），整个字符串会保持原样。

#### 正确的默认值写法

在 `env.vars` 中定义默认值，在配置中只引用变量：

```json
{
  "env": {
    "vars": {
      "PORT": "8080" // 默认值写在这里
    }
  },
  "gateway": {
    "port": "${PORT}" // 这里只写变量引用
  }
}
```

### 缺失环境变量的处理

如果配置中引用了一个环境变量，但该变量：

- 系统环境变量中不存在
- `env.vars` 中也没有定义

**配置加载会报错**，抛出 `MissingEnvVarError`：

```
Missing env var "SOME_VAR" referenced at config path: gateway.auth.token
```

#### 设计原则

| 变量类型                           | 处理方式                                          |
| ---------------------------------- | ------------------------------------------------- |
| 有默认值的变量                     | 在 `env.vars` 中定义默认值                        |
| 必须由用户提供的变量（如 API Key） | 不要写在 `env.vars` 中，让缺失时报错（fail-fast） |

### 转义语法

如果需要在配置中输出字面字符串 `${VAR}`，使用 `$${}` 转义：

```json
{
  "message": "$${VAR}" // 输出: ${VAR}
}
```

### 完整示例

```json
{
  "env": {
    "vars": {
      // 有默认值的配置
      "OPENCLAW_DEFAULT_MODEL": "gpt-4",
      "OPENCLAW_WORKSPACE": "/data/workspace",
      "API_BASE_URL": "https://api.example.com"
      // 注意：必须由用户提供的变量（如 API_KEY）不要写在这里
    }
  },
  "gateway": {
    "auth": {
      // 必须提供，否则启动报错
      "token": "${OPENCLAW_GATEWAY_TOKEN}"
    }
  },
  "models": {
    "providers": {
      "openai": {
        // 使用 env.vars 中的默认值，或被系统环境变量覆盖
        "baseUrl": "${API_BASE_URL}",
        // 必须提供
        "apiKey": "${OPENAI_API_KEY}"
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        // 使用 env.vars 中的默认值
        "primary": "${OPENCLAW_DEFAULT_MODEL}"
      },
      "workspace": "${OPENCLAW_WORKSPACE}"
    }
  }
}
```

---

## 第二章：Models 配置更新机制

OpenClaw 的 models 配置支持两种更新模式：`merge` 和 `replace`，用于控制 `agents/models.json` 的生成行为。

### 配置文件结构

```
/opt/openclaw/openclaw.default.json  # Docker 镜像中的默认配置
/data/.openclaw/openclaw.json       # 实际使用的配置（固化挂载）
/data/agents/models.json            # 生成的模型配置（固化挂载）
```

### 更新模式

#### mode: "merge"（默认）

`merge` 模式会保留现有的 providers，新的配置会覆盖同名的 provider：

```typescript
if (mode === "merge") {
  const existing = await readJson(targetPath);
  if (isRecord(existing) && isRecord(existing.providers)) {
    const existingProviders = existing.providers as Record<...>;
    mergedProviders = { ...existingProviders, ...providers };
  }
}
```

**行为**：

- 同名的 provider：新的配置**完全替换**旧的
- 不同名的 provider：旧的 provider 会被**保留**
- 新的 provider：会被**添加**

#### mode: "replace"

`replace` 模式会完全替换 `agents/models.json`，不保留任何旧的 providers。

**行为**：

- 所有 providers 都会被新的配置**完全替换**
- 旧的 providers 会被**删除**

### 实际场景示例

#### 场景 1：修改了 provider 的 models 列表

**修改前**（`openclaw.json` 和 `agents/models.json`）：

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "ski-gateway-openai": {
        "models": [
          { "id": "gpt-5.2", "name": "GPT-5.2" },
          { "id": "gpt-5-mini", "name": "GPT-5 Mini" }
        ]
      }
    }
  }
}
```

**修改后**（`openclaw.json`）：

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "ski-gateway-openai": {
        "models": [
          { "id": "MiniMax-M2.5", "name": "MiniMax-M2.5" },
          { "id": "glm-5", "name": "GLM-5" }
        ]
      }
    }
  }
}
```

**结果**（`agents/models.json`）：

```json
{
  "providers": {
    "ski-gateway-openai": {
      // 完全被新的配置替换（因为 provider 名称相同）
      "models": [
        { "id": "MiniMax-M2.5", "name": "MiniMax-M2.5" },
        { "id": "glm-5", "name": "GLM-5" }
      ]
    }
  }
}
```

**结论**：✅ 不会乱，新的 provider 配置会完全替换旧的。

#### 场景 2：添加了新的 provider

**修改前**（`agents/models.json`）：

```json
{
  "providers": {
    "ski-gateway-openai": {
      "models": [{ "id": "gpt-5.2", "name": "GPT-5.2" }]
    }
  }
}
```

**修改后**（`openclaw.json`）：

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "ski-gateway-claude": {
        "models": [{ "id": "claude-opus-4-6", "name": "Claude Opus 4.6" }]
      }
    }
  }
}
```

**结果**（`agents/models.json`）：

```json
{
  "providers": {
    "ski-gateway-openai": {
      // 保留旧的 provider
      "models": [{ "id": "gpt-5.2", "name": "GPT-5.2" }]
    },
    "ski-gateway-claude": {
      // 添加新的 provider
      "models": [{ "id": "claude-opus-4-6", "name": "Claude Opus 4.6" }]
    }
  }
}
```

**结论**：✅ 不会乱，新的 provider 会被添加，旧的 provider 会被保留。

#### 场景 3：删除了 provider

**修改前**（`agents/models.json`）：

```json
{
  "providers": {
    "ski-gateway-openai": {
      "models": [{ "id": "gpt-5.2", "name": "GPT-5.2" }]
    },
    "ski-gateway-claude": {
      "models": [{ "id": "claude-opus-4-6", "name": "Claude Opus 4.6" }]
    }
  }
}
```

**修改后**（`openclaw.json`）：

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "ski-gateway-openai": {
        "models": [{ "id": "MiniMax-M2.5", "name": "MiniMax-M2.5" }]
      }
    }
  }
}
```

**结果**（`agents/models.json`）：

```json
{
  "providers": {
    "ski-gateway-openai": {
      // 被新的配置替换
      "models": [{ "id": "MiniMax-M2.5", "name": "MiniMax-M2.5" }]
    },
    "ski-gateway-claude": {
      // 保留旧的 provider（因为新的配置中没有）
      "models": [{ "id": "claude-opus-4-6", "name": "Claude Opus 4.6" }]
    }
  }
}
```

**结论**：⚠️ **会乱！** 旧的 provider 会被保留，即使新的配置中没有。

### 配置更新行为总结

| 场景                | mode: "merge"      | mode: "replace"    |
| ------------------- | ------------------ | ------------------ |
| 修改同名的 provider | 新的完全替换旧的   | 新的完全替换旧的   |
| 添加新的 provider   | 新的添加，旧的保留 | 新的添加，旧的删除 |
| 删除 provider       | 旧的保留（会乱）   | 旧的删除           |

### Docker 重启行为

#### 首次启动

```bash
# entrypoint.sh 会复制
cp /opt/openclaw/openclaw.default.json /data/.openclaw/openclaw.json
```

#### Docker 重启（已有配置）

```bash
# entrypoint.sh 不会覆盖
echo "[entrypoint] Using existing configuration at $CONFIG_PATH"
```

#### 强制重置

```bash
# 设置环境变量
export OPENCLAW_RESET_CONFIG=true

# entrypoint.sh 会覆盖
cp /opt/openclaw/openclaw.default.json /data/.openclaw/openclaw.json
```

### models.json 生成时机

`agents/models.json` 会在每次启动时根据 `openclaw.json` 重新生成：

```typescript
export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
): Promise<{ agentDir: string; wrote: boolean }> {
  const cfg = config ?? loadConfig();
  const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveOpenClawAgentDir();

  // 1. 读取显式配置的 providers
  const explicitProviders = cfg.models?.providers ?? {};

  // 2. 解析隐式 providers（从环境变量、AWS Bedrock 等）
  const implicitProviders = await resolveImplicitProviders({ agentDir });

  // 3. 合并 providers
  const providers: Record<string, ProviderConfig> = mergeProviders({
    implicit: implicitProviders,
    explicit: explicitProviders,
  });

  // 4. 添加 AWS Bedrock 和 GitHub Copilot（如果可用）
  const implicitBedrock = await resolveImplicitBedrockProvider({ agentDir, config: cfg });
  if (implicitBedrock) {
    providers["amazon-bedrock"] = existing
      ? mergeProviderModels(implicitBedrock, existing)
      : implicitBedrock;
  }

  // 5. 根据 mode 合并现有的 models.json
  const mode = cfg.models?.mode ?? DEFAULT_MODE;
  const targetPath = path.join(agentDir, "models.json");

  let mergedProviders = providers;
  if (mode === "merge") {
    const existing = await readJson(targetPath);
    if (isRecord(existing) && isRecord(existing.providers)) {
      const existingProviders = existing.providers as Record<...>;
      mergedProviders = { ...existingProviders, ...providers };
    }
  }

  // 6. 写入 models.json
  await fs.writeFile(targetPath, JSON.stringify({ providers: normalizedProviders }, null, 2));
  return { agentDir, wrote: true };
}
```

### 推荐做法

#### 开发环境

使用 `mode: "replace"`，避免旧的 providers 残留：

```json
{
  "models": {
    "mode": "replace",
    "providers": {
      "ski-gateway-openai": {
        "models": [...]
      }
    }
  }
}
```

#### 生产环境

使用 `mode: "merge"`，但要注意手动清理不需要的 providers。

#### 强制重置

设置 `OPENCLAW_RESET_CONFIG=true` + 删除 `agents/models.json`：

```bash
export OPENCLAW_RESET_CONFIG=true
rm /data/agents/models.json
# 重启容器
```

**效果**：`openclaw.json` 和 `agents/models.json` 都会被重置。

### 配置文件对比

| 配置文件                | 位置               | 作用                    | 更新方式                                |
| ----------------------- | ------------------ | ----------------------- | --------------------------------------- |
| `openclaw.default.json` | `/opt/openclaw/`   | Docker 镜像中的默认配置 | 重新构建 Docker 镜像                    |
| `openclaw.json`         | `/data/.openclaw/` | 实际使用的配置          | 手动编辑或 `OPENCLAW_RESET_CONFIG=true` |
| `models.json`           | `/data/agents/`    | 生成的模型配置          | 每次启动时根据 `openclaw.json` 生成     |

### 关键点

- `models.mode: merge` 会保留现有的 `models.json` 中的 providers
- 更新 `openclaw.default.json` 不会自动更新已存在的 `openclaw.json`
- 需要设置 `OPENCLAW_RESET_CONFIG=true` 才会覆盖 `openclaw.json`
- `agents/models.json` 会在每次启动时根据 `openclaw.json` 重新生成
- 删除 provider 时，使用 `mode: "merge"` 会导致旧的 provider 残留

---

## 相关源码

- 环境变量替换实现：`src/config/env-substitution.ts`
- env.vars 收集：`src/config/env-vars.ts`
- 配置加载流程：`src/config/io.ts`
- models 配置生成：`src/agents/models-config.ts`
- agent 目录解析：`src/agents/agent-paths.ts`
