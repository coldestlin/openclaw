# Telegram Bot 双向通讯机制详解

本文档详细说明 OpenClaw 中 Telegram Bot 的双向通讯原理，包括 Webhook 模式、Polling 模式、冲突处理机制等。

---

## 第一章：核心概念

### 1.1 Telegram Bot API 的两种消息获取模式

Telegram Bot API 支持两种模式来获取用户发送给 bot 的消息：

#### Webhook 模式（OpenClaw 推荐）

- **机制**：Telegram 服务器主动推送消息到你的服务器
- **优点**：实时性强，延迟低，无需轮询
- **缺点**：需要一个公网可访问的服务器地址
- **适用场景**：生产环境、需要实时响应的场景

#### Long Polling 模式

- **机制**：你的服务器定期向 Telegram 服务器查询新消息
- **优点**：不需要公网地址，配置简单
- **缺点**：有延迟，需要持续轮询
- **适用场景**：开发环境、内网部署

### 1.2 为什么只需要一个 Token？

Bot Token 的作用：

1. **身份验证**：证明你是这个 bot 的所有者
2. **API 访问**：使用 token 可以调用 Telegram Bot API 的所有方法
3. **Webhook 设置**：告诉 Telegram 将消息发送到哪里

**关键点**：

- Token 不需要存储接收消息的地址，因为 webhook URL 是在运行时动态设置的
- Telegram 服务器知道将消息推送到哪里，是因为你通过 API 告诉了它

---

## 第二章：Webhook 模式详解

### 2.1 接收消息流程（Telegram → OpenClaw）

从源码 [src/telegram/webhook.ts:103-108](file:///home/gee/projects/gee/openclaw-debug/src/telegram/webhook.ts#L103-L108)：

```typescript
await withTelegramApiErrorLogging({
  operation: "setWebhook",
  runtime,
  fn: () =>
    bot.api.setWebhook(publicUrl, {
      secret_token: opts.secret,
      allowed_updates: resolveTelegramAllowedUpdates(),
    }),
});
```

**完整流程**：

1. **OpenClaw 启动时**，调用 `setWebhook()` 告诉 Telegram：
   - "当有消息时，请 POST 到 `http://your-server:8787/telegram-webhook`"
   - 可选的 secret token 用于验证请求来源

2. **用户在 Telegram 中发送消息**给 bot

3. **Telegram 服务器主动推送**这个消息到 OpenClaw 的 webhook URL

4. **OpenClaw 的 HTTP 服务器接收 POST 请求**，通过 [webhookCallback](file:///home/gee/projects/gee/openclaw-debug/src/telegram/webhook.ts#L32) 处理消息

5. **消息传递给 bot 的处理器**（[bot-handlers.ts](file:///home/gee/projects/gee/openclaw-debug/src/telegram/bot-handlers.ts)）

### 2.2 发送消息流程（OpenClaw → Telegram）

从源码 [src/telegram/send.ts:233-275](file:///home/gee/projects/gee/openclaw-debug/src/telegram/send.ts#L233-L275)：

```typescript
export async function sendMessageTelegram(
  to: string,
  text: string,
  opts: TelegramSendOpts = {},
): Promise<TelegramSendResult> {
  const cfg = loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.token, account);
  const target = parseTelegramTarget(to);
  const chatId = normalizeChatId(target.chatId);
  const client = resolveTelegramClientOptions(account);
  const api = opts.api ?? new Bot(token, client ? { client } : undefined).api;

  // 调用 Telegram Bot API 发送消息
  await api.sendMessage(chatId, text, params);
}
```

**完整流程**：

1. OpenClaw 需要发送消息时，调用 `bot.api.sendMessage()`

2. 这会向 Telegram Bot API 发送 HTTP POST 请求

3. Telegram 服务器接收请求并发送消息给用户

### 2.3 Webhook 服务器实现

从源码 [src/telegram/webhook.ts:47-70](file:///home/gee/projects/gee/openclaw-debug/src/telegram/webhook.ts#L47-L70)：

```typescript
const server = createServer((req, res) => {
  if (req.url === healthPath) {
    res.writeHead(200);
    res.end("ok");
    return;
  }
  if (req.url !== path || req.method !== "POST") {
    res.writeHead(404);
    res.end();
    return;
  }
  const startTime = Date.now();
  if (diagnosticsEnabled) {
    logWebhookReceived({ channel: "telegram", updateType: "telegram-post" });
  }
  const handled = handler(req, res);
  if (handled && typeof handled.catch === "function") {
    void handled
      .then(() => {
        if (diagnosticsEnabled) {
          logWebhookProcessed({
            channel: "telegram",
            updateType: "telegram-post",
            durationMs: Date.now() - startTime,
          });
        }
      })
      .catch((err) => {
        const errMsg = formatErrorMessage(err);
        if (diagnosticsEnabled) {
          logWebhookError({
            channel: "telegram",
            updateType: "telegram-post",
            error: errMsg,
          });
        }
        runtime.log?.(`webhook handler failed: ${errMsg}`);
        if (!res.headersSent) {
          res.writeHead(500);
        }
        res.end();
      });
  }
});
```

**服务器功能**：

- 健康检查端点：`/healthz`
- Webhook 端点：`/telegram-webhook`（默认）
- 诊断日志记录
- 错误处理

### 2.4 Webhook 设置和认证详解

#### 2.4.1 Telegram 如何知道我们的服务器地址？

**答案：OpenClaw 主动告诉 Telegram 的！**

从源码 [src/telegram/webhook.ts:100-108](file:///home/gee/projects/gee/openclaw-debug/src/telegram/webhook.ts#L100-L108) 可以看到：

```typescript
const publicUrl =
  opts.publicUrl ?? `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${path}`;

await withTelegramApiErrorLogging({
  operation: "setWebhook",
  runtime,
  fn: () =>
    bot.api.setWebhook(publicUrl, {
      secret_token: opts.secret,
      allowed_updates: resolveTelegramAllowedUpdates(),
    }),
});
```

**关键点**：

- OpenClaw 启动时，读取配置中的 `webhookUrl`（如果没有配置，则使用默认值）
- OpenClaw 调用 Telegram Bot API：`POST https://api.telegram.org/bot<TOKEN>/setWebhook`
- 请求体包含 webhook URL 和 secret token
- Telegram 服务器收到请求后，记录下这个 webhook URL
- 之后有消息时，Telegram 就会 POST 到这个地址

**所以是 OpenClaw 主动告诉 Telegram，而不是 Telegram 自动发现的！**

#### 2.4.2 OpenClaw 拿哪个地址去通知 Telegram？

**答案：从配置文件或环境变量中读取**

##### 配置方式

**方式 1：配置文件（推荐）**

```json
{
  "channels": {
    "telegram": {
      "botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
      "webhookUrl": "https://your-domain.com/telegram-webhook",
      "webhookSecret": "your-secret-token-here"
    }
  }
}
```

**方式 2：环境变量**

```bash
export TELEGRAM_BOT_TOKEN="your-bot-token"
```

##### 地址来源优先级

从源码可以看到：

```typescript
const publicUrl =
  opts.publicUrl ?? `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${path}`;
```

1. **优先使用配置的 `webhookUrl`**（`opts.publicUrl`）
2. 如果没有配置，则使用默认值：`http://localhost:8787/telegram-webhook`

**注意**：默认值 `localhost` 只能用于本地测试，生产环境必须配置公网可访问的 `webhookUrl`。

#### 2.4.3 Telegram 调用 OpenClaw 哪个 API？认证是怎么弄的？

##### Telegram 调用的 API

**答案：就是你的 webhook URL，比如 `https://your-domain.com/telegram-webhook`**

这不是 OpenClaw 提供的 API，而是 OpenClaw 监听的一个 HTTP 端点，专门用来接收 Telegram 推送的消息。

##### 认证机制

**答案：使用 `webhookSecret` 进行验证**

从源码 [src/telegram/webhook.ts:32-34](file:///home/gee/projects/gee/openclaw-debug/src/telegram/webhook.ts#L32-L34) 可以看到：

```typescript
const handler = webhookCallback(bot, "http", {
  secretToken: opts.secret,
});
```

**认证流程**：

###### 步骤 1：设置 webhook 时传递 secret

OpenClaw 调用 Telegram API 时传递 `secret_token`：

```typescript
bot.api.setWebhook(publicUrl, {
  secret_token: opts.secret, // 你的 webhookSecret
  allowed_updates: resolveTelegramAllowedUpdates(),
});
```

###### 步骤 2：Telegram 推送消息时携带 secret

当有用户发送消息时，Telegram 会 POST 到你的 webhook URL，并在请求头中携带：

```
X-Telegram-Bot-Api-Secret-Token: your-secret-token-here
```

###### 步骤 3：OpenClaw 验证 secret

grammy 框架（`webhookCallback`）会自动验证这个请求头：

```typescript
const handler = webhookCallback(bot, "http", {
  secretToken: opts.secret, // 期望的 secret
});
```

如果请求头中的 `X-Telegram-Bot-Api-Secret-Token` 与配置的 `webhookSecret` 不匹配，则拒绝请求。

#### 2.4.4 完整的 Webhook 设置和消息接收流程图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        OpenClaw 启动流程                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. 读取配置                                                         │
│    - botToken: "123456789:ABCdefGHIjklMNOpqrsTUVwxyz"              │
│    - webhookUrl: "https://your-domain.com/telegram-webhook"            │
│    - webhookSecret: "your-secret-token-here"                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. 启动 HTTP 服务器                                                 │
│    - 监听端口：8787（默认）                                         │
│    - 监听地址：0.0.0.0（所有网络接口）                              │
│    - Webhook 路径：/telegram-webhook                                   │
│    - 健康检查：/healthz                                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. 调用 Telegram API 设置 Webhook                                   │
│                                                                     │
│  POST https://api.telegram.org/bot<TOKEN>/setWebhook                   │
│                                                                     │
│  请求体：                                                            │
│  {                                                                  │
│    "url": "https://your-domain.com/telegram-webhook",                  │
│    "secret_token": "your-secret-token-here",                            │
│    "allowed_updates": ["message", "callback_query", ...]                │
│  }                                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. Telegram API 服务器记录 Webhook 配置                               │
│    - URL: https://your-domain.com/telegram-webhook                      │
│    - Secret: your-secret-token-here                                    │
│    - 状态：active                                                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. OpenClaw 等待接收 Telegram 推送的消息                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        用户发送消息给 Bot                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 6. Telegram 服务器检测到新消息                                        │
│    - 消息 ID: 123456789                                             │
│    - 发送者: user123                                                 │
│    - 聊天 ID: 987654321                                             │
│    - 文本: "Hello, bot!"                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 7. Telegram 服务器推送消息到 Webhook URL                               │
│                                                                     │
│  POST https://your-domain.com/telegram-webhook                          │
│                                                                     │
│  请求头：                                                            │
│  {                                                                  │
│    "Content-Type": "application/json",                                 │
│    "X-Telegram-Bot-Api-Secret-Token": "your-secret-token-here"         │
│  }                                                                  │
│                                                                     │
│  请求体：                                                            │
│  {                                                                  │
│    "update_id": 123456789,                                           │
│    "message": {                                                       │
│      "message_id": 987654321,                                       │
│      "from": {                                                        │
│        "id": 123456789,                                              │
│        "is_bot": false,                                               │
│        "first_name": "John",                                          │
│        "username": "john_doe"                                         │
│      },                                                              │
│      "chat": {                                                       │
│        "id": 987654321,                                             │
│        "first_name": "John",                                          │
│        "username": "john_doe",                                        │
│        "type": "private"                                              │
│      },                                                              │
│      "date": 1709095200,                                             │
│      "text": "Hello, bot!"                                           │
│    }                                                                │
│  }                                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 8. OpenClaw HTTP 服务器接收请求                                       │
│    - 验证请求方法：POST                                               │
│    - 验证请求路径：/telegram-webhook                                  │
│    - 验证 Content-Type：application/json                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 9. grammy webhookCallback 验证 Secret Token                           │
│    - 读取请求头：X-Telegram-Bot-Api-Secret-Token                      │
│    - 对比配置的 webhookSecret                                         │
│    - 如果匹配：继续处理                                               │
│    - 如果不匹配：返回 403 Forbidden                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 10. OpenClaw 处理消息                                               │
│     - 解析消息内容                                                   │
│     - 检查发送者权限（dmPolicy, allowFrom）                            │
│     - 路由到对应的 Agent                                             │
│     - 生成回复                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 11. OpenClaw 调用 Telegram API 发送回复                              │
│                                                                     │
│  POST https://api.telegram.org/bot<TOKEN>/sendMessage                  │
│                                                                     │
│  请求体：                                                            │
│  {                                                                  │
│    "chat_id": 987654321,                                            │
│    "text": "Hello, John! How can I help you today?",                  │
│    "parse_mode": "HTML"                                              │
│  }                                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 12. Telegram 服务器发送回复给用户                                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 13. 用户在 Telegram 中收到回复                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 2.4.5 手动测试 Webhook

你可以手动测试 webhook 的认证：

```bash
# 1. 正确的 secret（应该成功）
curl -X POST https://your-domain.com/telegram-webhook \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: your-secret-token" \
  -d '{"update_id": 1, "message": {"message_id": 1, "from": {"id": 1}, "chat": {"id": 1}, "text": "test"}}'

# 2. 错误的 secret（应该被拒绝）
curl -X POST https://your-domain.com/telegram-webhook \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: wrong-secret" \
  -d '{"update_id": 1, "message": {"message_id": 1, "from": {"id": 1}, "chat": {"id": 1}, "text": "test"}}'
```

#### 2.4.6 查看 Webhook 配置

你可以查看 Telegram 服务器记录的 webhook 信息：

```bash
curl https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo
```

返回示例：

```json
{
  "ok": true,
  "result": {
    "url": "https://your-domain.com/telegram-webhook",
    "has_custom_certificate": false,
    "pending_update_count": 0,
    "last_error_date": 0,
    "last_error_message": "",
    "max_connections": 40,
    "ip_address": "1.2.3.4"
  }
}
```

#### 2.4.7 删除 Webhook

如果你想删除 webhook（切换到 Polling 模式）：

```bash
curl https://api.telegram.org/bot<YOUR_BOT_TOKEN>/deleteWebhook
```

### 2.5 架构图（简化版）

```
┌─────────────┐         1. setWebhook(url)         ┌──────────────┐
│  OpenClaw   │ ──────────────────────────────────►│ Telegram API │
│  (你的服务器)│                                    │  服务器      │
└─────────────┘                                    └──────────────┘
     ▲                                                   │
     │                                                   │ 2. 用户发消息
     │                                                   │
     │ 3. POST webhook (推送消息)                        │
     │◄──────────────────────────────────────────────────┘
     │
     │ 4. 处理消息
     │
     │
     │ 5. sendMessage() (主动发送)
     └──────────────────────────────────────────────────►
                                                         │
                                                         │ 6. 发送消息给用户
                                                         │
                                                         ▼
                                                    ┌──────────┐
                                                    │  用户    │
                                                    └──────────┘
```

---

## 第三章：OpenClaw 启动流程

### 3.1 自动设置 Webhook

从源码 [src/telegram/monitor.ts:148-157](file:///home/gee/projects/gee/openclaw-debug/src/telegram/monitor.ts#L148-L157)：

```typescript
if (opts.useWebhook) {
  await startTelegramWebhook({
    token,
    accountId: account.accountId,
    config: cfg,
    path: opts.webhookPath,
    port: opts.webhookPort,
    secret: opts.webhookSecret,
    runtime: opts.runtime as RuntimeEnv,
    fetch: proxyFetch,
    abortSignal: opts.abortSignal,
    publicUrl: opts.webhookUrl,
  });
  return;
}
```

**关键点**：

- 每次 OpenClaw 启动时，如果配置了 `useWebhook: true`，就会调用 `startTelegramWebhook()`
- 这个函数内部会调用 `bot.api.setWebhook()` 来告诉 Telegram 服务器新的 webhook URL
- 这确保了即使服务器地址改变，Telegram 也能正确推送消息

### 3.2 启动流程图

```
OpenClaw 启动
    ↓
加载配置 (openclaw.json)
    ↓
检查 channels.telegram.useWebhook
    ↓
    ├─ useWebhook: true
    │   ↓
    │ 启动 HTTP 服务器 (监听 webhook 端口)
    │   ↓
    │ 调用 bot.api.setWebhook(publicUrl)
    │   ↓
    │ Telegram 服务器记录新的 webhook URL
    │   ↓
    │ 等待接收 Telegram 推送的消息
    │
    └─ useWebhook: false (Polling 模式)
        ↓
        调用 bot.start() (grammy runner)
        ↓
        定期调用 bot.api.getUpdates()
        ↓
        处理返回的消息
```

---

## 第四章：冲突处理机制

### 4.1 多实例冲突场景

#### 场景 1：OpenClaw 停机

- Telegram 服务器会尝试推送消息到 webhook URL，但会失败（连接超时或 404）
- Telegram 会重试几次（通常是几次，间隔递增），如果都失败，消息可能会丢失
- 当 OpenClaw 重新启动后，重新设置 webhook，消息接收恢复正常

#### 场景 2：多个实例使用相同的 token（Webhook 模式）

- **最后设置 webhook 的实例会生效**
- 之前的实例会收不到消息
- Telegram 服务器只记住最新的 webhook URL

#### 场景 3：多个实例使用相同的 token（Polling 模式）

- 多个实例同时调用 `getUpdates()` 会收到 **HTTP 409 Conflict 错误**
- OpenClaw 会检测到 409 错误，并使用指数退避策略重试

### 4.2 冲突检测实现

从源码 [src/telegram/monitor.ts:60-72](file:///home/gee/projects/gee/openclaw-debug/src/telegram/monitor.ts#L60-L72)：

```typescript
const isGetUpdatesConflict = (err: unknown) => {
  if (!err || typeof err !== "object") {
    return false;
  }
  const typed = err as {
    error_code?: number;
    errorCode?: number;
    description?: string;
    method?: string;
    message?: string;
  };
  const errorCode = typed.error_code ?? typed.errorCode;
  if (errorCode !== 409) {
    return false;
  }
  const haystack = [typed.method, typed.description, typed.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes("getupdates");
};
```

**检测逻辑**：

1. 检查错误代码是否为 409（Conflict）
2. 检查错误描述中是否包含 "getupdates"
3. 如果两者都满足，则判定为 `getUpdates` 冲突

### 4.3 冲突处理策略

从源码 [src/telegram/monitor.ts:185-204](file:///home/gee/projects/gee/openclaw-debug/src/telegram/monitor.ts#L185-L204)：

```typescript
try {
  await runner.task();
  return;
} catch (err) {
  if (opts.abortSignal?.aborted) {
    throw err;
  }
  const isConflict = isGetUpdatesConflict(err);
  const isRecoverable = isRecoverableTelegramNetworkError(err, { context: "polling" });
  if (!isConflict && !isRecoverable) {
    throw err;
  }
  restartAttempts += 1;
  const delayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, restartAttempts);
  const reason = isConflict ? "getUpdates conflict" : "network error";
  const errMsg = formatErrorMessage(err);
  (opts.runtime?.error ?? console.error)(
    `Telegram ${reason}: ${errMsg}; retrying in ${formatDurationPrecise(delayMs)}.`,
  );
  try {
    await sleepWithAbort(delayMs, opts.abortSignal);
  } catch (sleepErr) {
    if (opts.abortSignal?.aborted) {
      return;
    }
    throw sleepErr;
  }
}
```

**处理策略**：

1. **检测冲突**：判断是否为 409 Conflict 错误
2. **指数退避**：使用指数退避策略等待重试
   - 初始延迟：2000ms
   - 最大延迟：30000ms
   - 退避因子：1.8
   - 抖动：0.25
3. **重试机制**：持续重试直到成功或收到终止信号

### 4.4 退避策略配置

```typescript
const TELEGRAM_POLL_RESTART_POLICY = {
  initialMs: 2000, // 初始延迟 2 秒
  maxMs: 30_000, // 最大延迟 30 秒
  factor: 1.8, // 退避因子 1.8
  jitter: 0.25, // 抖动 25%
};
```

**退避时间计算示例**：

| 重试次数 | 延迟时间（无抖动） | 延迟时间（有抖动） |
| -------- | ------------------ | ------------------ |
| 1        | 2000ms             | 1500-2500ms        |
| 2        | 3600ms             | 2700-4500ms        |
| 3        | 6480ms             | 4860-8100ms        |
| 4        | 11664ms            | 8748-14580ms       |
| 5        | 20995ms            | 15746-26244ms      |
| 6+       | 30000ms            | 22500-37500ms      |

---

## 第五章：Telegram 配置指南

### 5.1 配置位置

OpenClaw 支持两种配置方式：

#### 方式 1：环境变量（推荐用于简单场景）

```bash
export TELEGRAM_BOT_TOKEN="your-bot-token"
```

#### 方式 2：配置文件（推荐用于生产环境）

在 `/data/.openclaw/openclaw.json` 中配置（**不是** `openclaw.default.json`）

**重要**：

- `/opt/openclaw/openclaw.default.json`：Docker 镜像中的默认配置（不要修改）
- `/data/.openclaw/openclaw.json`：实际使用的配置（固化挂载，在这里修改）

### 5.2 配置示例

#### 最简单的配置（环境变量）

```bash
# 设置环境变量
export TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"

# 启动 OpenClaw
openclaw gateway
```

#### 生产环境配置（Webhook 模式）

在 `/data/.openclaw/openclaw.json` 中添加：

```json
{
  "channels": {
    "telegram": {
      "botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
      "webhookUrl": "https://your-domain.com/telegram-webhook",
      "webhookSecret": "your-secret-token-here",
      "dmPolicy": "pairing",
      "enabled": true
    }
  }
}
```

#### 开发环境配置（Polling 模式）

```json
{
  "channels": {
    "telegram": {
      "botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
      "dmPolicy": "pairing",
      "enabled": true
    }
  }
}
```

#### 多账户配置

```json
{
  "channels": {
    "telegram": {
      "accounts": {
        "primary": {
          "botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
          "webhookUrl": "https://your-domain.com/telegram-webhook",
          "webhookSecret": "secret1"
        },
        "secondary": {
          "botToken": "987654321:ZYXwvutSRQponmLKJIHGFedcba",
          "webhookUrl": "https://your-domain.com/telegram-webhook-2",
          "webhookSecret": "secret2"
        }
      }
    }
  }
}
```

#### 完整配置示例

```json
{
  "channels": {
    "telegram": {
      "botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
      "webhookUrl": "https://your-domain.com/telegram-webhook",
      "webhookSecret": "your-secret-token-here",
      "webhookPath": "/telegram-webhook",
      "dmPolicy": "pairing",
      "enabled": true,
      "allowFrom": [],
      "groupPolicy": "open",
      "groups": {
        "*": {
          "requireMention": true,
          "enabled": true
        }
      },
      "textChunkLimit": 4000,
      "mediaMaxMb": 5,
      "retry": {
        "attempts": 3,
        "minDelayMs": 1000,
        "maxDelayMs": 10000,
        "jitter": 0.25
      }
    }
  }
}
```

### 5.3 配置参数说明

| 参数             | 类型    | 必需 | 说明                                                        |
| ---------------- | ------- | ---- | ----------------------------------------------------------- |
| `botToken`       | string  | 是\* | Telegram Bot Token（或使用 `TELEGRAM_BOT_TOKEN` 环境变量）  |
| `tokenFile`      | string  | 否   | 从文件读取 token（用于密钥管理）                            |
| `webhookUrl`     | string  | 否\* | Webhook URL（生产环境必需）                                 |
| `webhookSecret`  | string  | 否\* | Webhook 密钥（生产环境必需）                                |
| `webhookPath`    | string  | 否   | Webhook 路径（默认 `/telegram-webhook`）                    |
| `dmPolicy`       | string  | 否   | DM 策略：`pairing`（默认）、`allowlist`、`open`、`disabled` |
| `enabled`        | boolean | 否   | 是否启用（默认 `true`）                                     |
| `allowFrom`      | array   | 否   | 允许的用户 ID 或用户名列表                                  |
| `groupPolicy`    | string  | 否   | 群组策略：`open`、`disabled`、`allowlist`                   |
| `textChunkLimit` | number  | 否   | 文本分块大小（默认 4000）                                   |
| `mediaMaxMb`     | number  | 否   | 最大媒体文件大小（默认 5MB）                                |

- `botToken` 和 `webhookUrl/webhookSecret` 至少需要一个

### 5.4 配置文件优先级

配置的优先级从高到低：

1. 环境变量 `TELEGRAM_BOT_TOKEN`
2. 配置文件 `channels.telegram.botToken`
3. 配置文件 `channels.telegram.tokenFile`

### 5.5 是否需要重启？

**Webhook 相关配置需要重启**：

- `webhookUrl`
- `webhookSecret`
- `webhookPath`
- `botToken`

**其他配置支持热重载**：

- `dmPolicy`
- `allowFrom`
- `groupPolicy`
- `groups.*`
- `textChunkLimit`
- `mediaMaxMb`

**热重载方法**：

```bash
# 方法 1：通过 Gateway API
curl -X POST http://localhost:18789/_admin/config/reload \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN"

# 方法 2：重启容器
docker restart openclaw
```

### 5.6 配置验证

修改配置后，可以验证配置是否正确：

```bash
# 1. 检查配置文件语法
openclaw config validate

# 2. 检查 Telegram webhook 信息
curl https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo

# 3. 测试 webhook 连接
curl -X POST https://your-domain.com/telegram-webhook \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: your-secret" \
  -d '{"update_id": 1, "message": {"message_id": 1, "from": {"id": 1}, "chat": {"id": 1}, "text": "test"}}'
```

### 5.7 获取 Bot Token

1. 在 Telegram 中搜索 [@BotFather](https://t.me/botfather)
2. 发送 `/newbot` 命令
3. 按提示设置 bot 名称和用户名
4. BotFather 会返回 bot token，格式如：`123456789:ABCdefGHIjklMNOpqrsTUVwxyz`

### 5.8 常见配置场景

#### 场景 1：只允许特定用户使用

```json
{
  "channels": {
    "telegram": {
      "botToken": "your-token",
      "dmPolicy": "allowlist",
      "allowFrom": ["123456789", "username1", "username2"]
    }
  }
}
```

#### 场景 2：允许所有人使用（不推荐）

```json
{
  "channels": {
    "telegram": {
      "botToken": "your-token",
      "dmPolicy": "open",
      "allowFrom": ["*"]
    }
  }
}
```

#### 场景 3：群组需要 @ 提及

```json
{
  "channels": {
    "telegram": {
      "botToken": "your-token",
      "groupPolicy": "open",
      "groups": {
        "*": {
          "requireMention": true
        }
      }
    }
  }
}
```

#### 场景 4：特定群组配置

```json
{
  "channels": {
    "telegram": {
      "botToken": "your-token",
      "groups": {
        "-1001234567890": {
          "enabled": true,
          "requireMention": false,
          "skills": ["weather", "calculator"]
        }
      }
    }
  }
}
```

---

## 第六章：模式对比

### 6.1 Webhook vs Polling

| 特性           | Webhook 模式   | Polling 模式         |
| -------------- | -------------- | -------------------- |
| **实时性**     | 高（秒级）     | 低（取决于轮询间隔） |
| **资源消耗**   | 低（被动接收） | 高（主动轮询）       |
| **网络要求**   | 需要公网地址   | 无特殊要求           |
| **配置复杂度** | 中等           | 简单                 |
| **冲突处理**   | 最后设置者生效 | 409 错误 + 退避重试  |
| **适用场景**   | 生产环境       | 开发环境、内网       |

### 6.2 推荐配置

#### 生产环境（Webhook 模式）

```json
{
  "channels": {
    "telegram": {
      "useWebhook": true,
      "webhookUrl": "https://your-domain.com/telegram-webhook",
      "webhookSecret": "your-secret-token"
    }
  }
}
```

#### 开发环境（Polling 模式）

```json
{
  "channels": {
    "telegram": {
      "useWebhook": false
    }
  }
}
```

---

## 第七章：故障排查

### 7.1 Webhook 无法接收消息

**症状**：用户发送消息后，OpenClaw 没有收到

**检查清单**：

1. **确认 webhook 已设置**：

   ```bash
   curl https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo
   ```

2. **确认服务器可访问**：

   ```bash
   curl -X POST https://your-domain.com/telegram-webhook \
     -H "Content-Type: application/json" \
     -d '{"test": "message"}'
   ```

3. **检查防火墙规则**：
   - 确保端口 8787（或自定义端口）对外开放
   - 检查云服务器的安全组配置

4. **查看 OpenClaw 日志**：
   ```bash
   docker logs openclaw | grep telegram
   ```

### 7.2 409 Conflict 错误

**症状**：日志中出现 "getUpdates conflict" 错误

**原因**：

- 多个实例同时使用相同的 token
- Webhook 和 Polling 模式混用

**解决方案**：

1. **停止其他实例**：

   ```bash
   # 查找运行中的进程
   ps aux | grep openclaw

   # 停止其他实例
   kill <PID>
   ```

2. **统一模式**：
   - 要么全部使用 Webhook 模式
   - 要么全部使用 Polling 模式

3. **等待退避时间**：
   - 实例会自动重试
   - 最多等待 30 秒

### 7.3 消息丢失

**症状**：OpenClaw 停机期间的消息丢失

**原因**：

- Telegram 服务器推送失败
- 超过重试次数

**解决方案**：

1. **使用 Polling 模式**：
   - Polling 模式会记录 `update_offset`
   - 重启后会从上次的位置继续接收

2. **使用 Update Offset Store**：
   - OpenClaw 会持久化 `update_offset`
   - 从 [src/telegram/update-offset-store.ts](file:///home/gee/projects/gee/openclaw-debug/src/telegram/update-offset-store.ts) 实现

3. **监控服务可用性**：
   - 使用健康检查端点 `/healthz`
   - 配置自动重启

---

## 第八章：最佳实践

### 8.1 生产环境部署

1. **使用 Webhook 模式**：
   - 实时性更好
   - 资源消耗更低

2. **配置 HTTPS**：
   - Telegram 要求 webhook URL 使用 HTTPS
   - 使用 Let's Encrypt 免费证书

3. **设置 Webhook Secret**：
   - 验证请求来源
   - 防止伪造请求

4. **配置健康检查**：
   - 使用 `/healthz` 端点
   - 配置负载均衡器健康检查

5. **监控日志**：
   - 启用诊断日志
   - 监控错误率和延迟

### 8.2 开发环境部署

1. **使用 Polling 模式**：
   - 不需要公网地址
   - 配置简单

2. **使用 ngrok（临时）**：

   ```bash
   ngrok http 8787
   ```

   - 获取公网 URL
   - 设置 webhook

3. **本地测试**：
   - 使用 Telegram Bot API 的测试环境
   - 创建测试 bot

### 8.3 高可用部署

1. **使用负载均衡**：
   - 多个实例分担流量
   - 但要注意：Webhook 模式只能有一个实例生效

2. **使用 Polling 模式 + 消息队列**：
   - 多个实例轮询
   - 使用消息队列去重

3. **使用 Telegram Bot API 的 Webhook 集群**：
   - Telegram 支持多个 webhook URL
   - 需要特殊配置

---

## 第九章：相关源码

| 文件                                                                                                                    | 说明                  |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------- |
| [src/telegram/webhook.ts](file:///home/gee/projects/gee/openclaw-debug/src/telegram/webhook.ts)                         | Webhook 服务器实现    |
| [src/telegram/monitor.ts](file:///home/gee/projects/gee/openclaw-debug/src/telegram/monitor.ts)                         | 监控和冲突处理        |
| [src/telegram/bot.ts](file:///home/gee/projects/gee/openclaw-debug/src/telegram/bot.ts)                                 | Bot 创建和配置        |
| [src/telegram/send.ts](file:///home/gee/projects/gee/openclaw-debug/src/telegram/send.ts)                               | 消息发送实现          |
| [src/telegram/bot-handlers.ts](file:///home/gee/projects/gee/openclaw-debug/src/telegram/bot-handlers.ts)               | 消息处理器            |
| [src/telegram/update-offset-store.ts](file:///home/gee/projects/gee/openclaw-debug/src/telegram/update-offset-store.ts) | Update Offset 持久化  |
| [src/config/types.telegram.ts](file:///home/gee/projects/gee/openclaw-debug/src/config/types.telegram.ts)               | Telegram 配置类型定义 |

---

## 第十章：常见问题

### Q1: 为什么我的 bot 收不到消息？

**A**: 检查以下几点：

1. 确认 bot 已启动：`docker logs openclaw`
2. 确认 webhook 已设置：`curl https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo`
3. 确认服务器可访问：`curl https://your-domain.com/healthz`
4. 确认用户已启动 bot：在 Telegram 中搜索并启动 bot

### Q2: 可以同时使用 Webhook 和 Polling 吗？

**A**: 不可以。Telegram Bot API 不允许同时使用两种模式。

- 如果设置了 webhook，`getUpdates()` 会返回 409 错误
- 如果正在使用 `getUpdates()`，设置 webhook 会失败

### Q3: 如何切换模式？

**A**:

1. **从 Polling 切换到 Webhook**：

   ```json
   {
     "channels": {
       "telegram": {
         "webhookUrl": "https://your-domain.com/telegram-webhook",
         "webhookSecret": "your-secret"
       }
     }
   }
   ```

   重启 OpenClaw

2. **从 Webhook 切换到 Polling**：
   ```json
   {
     "channels": {
       "telegram": {
         "webhookUrl": null,
         "webhookSecret": null
       }
     }
   }
   ```
   重启 OpenClaw

### Q4: 如何测试 webhook？

**A**: 使用以下命令：

```bash
# 1. 检查 webhook 信息
curl https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo

# 2. 删除 webhook（切换到 Polling）
curl https://api.telegram.org/bot<YOUR_BOT_TOKEN>/deleteWebhook

# 3. 手动测试 webhook
curl -X POST https://your-domain.com/telegram-webhook \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: your-secret" \
  -d '{"update_id": 1, "message": {"message_id": 1, "from": {"id": 1}, "chat": {"id": 1}, "text": "test"}}'
```

### Q5: 如何处理多个环境（开发、测试、生产）？

**A**: 为每个环境创建独立的 bot：

1. **开发环境**：
   - Bot 名称：`MyBotDev`
   - Token: `dev_bot_token`
   - 使用 Polling 模式

2. **测试环境**：
   - Bot 名称：`MyBotTest`
   - Token: `test_bot_token`
   - 使用 Webhook 模式（测试服务器）

3. **生产环境**：
   - Bot 名称：`MyBot`
   - Token: `prod_bot_token`
   - 使用 Webhook 模式（生产服务器）

### Q6: 修改配置后需要重启吗？

**A**:

- **Webhook 相关配置需要重启**：`webhookUrl`、`webhookSecret`、`webhookPath`、`botToken`
- **其他配置支持热重载**：`dmPolicy`、`allowFrom`、`groupPolicy`、`groups.*` 等

热重载方法：

```bash
curl -X POST http://localhost:18789/_admin/config/reload \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN"
```

### Q7: 配置文件应该放在哪里？

**A**:

- **不要修改**：`/opt/openclaw/openclaw.default.json`（Docker 镜像中的默认配置）
- **应该修改**：`/data/.openclaw/openclaw.json`（实际使用的配置，固化挂载）

### Q8: 如何使用环境变量配置 Telegram？

**A**:

```bash
# 设置环境变量
export TELEGRAM_BOT_TOKEN="your-bot-token"

# 启动 OpenClaw
openclaw gateway
```

或者在 Docker 中：

```bash
docker run -e TELEGRAM_BOT_TOKEN="your-bot-token" openclaw
```

---

## 第十二章：OpenClaw 认证机制

### 12.1 Gateway API 认证

OpenClaw 的 Gateway API 有完整的认证机制，不是随便访问的。

#### 12.1.1 认证方式

从源码 [src/gateway/server/ws-connection/message-handler.ts:91-126](file:///home/gee/projects/gee/openclaw-debug/src/gateway/server/ws-connection/message-handler.ts#L91-L126) 可以看到，支持以下认证方式：

| 认证方式    | 说明                    | 推荐场景         |
| ----------- | ----------------------- | ---------------- |
| `token`     | 使用 token 认证         | 生产环境（推荐） |
| `password`  | 使用密码认证            | 简单场景         |
| `oauth`     | 使用 OAuth 认证         | 需要第三方登录   |
| `tailscale` | 使用 Tailscale 身份认证 | 内网部署         |

#### 12.1.2 配置方式

**方式 1：配置文件**

```json
{
  "gateway": {
    "bind": "0.0.0.0:8788",
    "auth": {
      "mode": "token",
      "token": "your-gateway-token-here"
    }
  }
}
```

**方式 2：环境变量**

```bash
export OPENCLAW_GATEWAY_TOKEN="your-gateway-token-here"
```

#### 12.1.3 验证逻辑

从源码可以看到详细的错误提示：

```typescript
case "token_missing":
  return `unauthorized: gateway token missing (${tokenHint})`;
case "token_mismatch":
  return `unauthorized: gateway token mismatch (${tokenHint})`;
case "token_missing_config":
  return "unauthorized: gateway token not configured on gateway (set gateway.auth.token)";
```

**优先级**：

1. 环境变量 `OPENCLAW_GATEWAY_TOKEN`
2. 配置文件 `gateway.auth.token`
3. 远程配置 `gateway.remote.token`

#### 12.1.4 安全建议

- **使用强 token**：至少 24 个字符的随机字符串
- **不要重复使用**：不要将 gateway token 用于其他用途
- **定期更换**：定期更新 token 以提高安全性
- **使用 HTTPS**：生产环境必须使用 HTTPS

### 12.2 Telegram Webhook 认证

**重要**：`/telegram-webhook` 端点**不使用** gateway token，而是使用独立的 `webhookSecret`。

#### 12.2.1 认证机制

从源码 [src/telegram/webhook.ts:32-34](file:///home/gee/projects/gee/openclaw-debug/src/telegram/webhook.ts#L32-L34) 可以看到：

```typescript
const handler = webhookCallback(bot, "http", {
  secretToken: opts.secret, // webhookSecret
});
```

**认证流程**：

1. **设置 webhook 时传递 secret**

   ```typescript
   bot.api.setWebhook(publicUrl, {
     secret_token: opts.secret, // 你的 webhookSecret
     allowed_updates: resolveTelegramAllowedUpdates(),
   });
   ```

2. **Telegram 推送消息时携带 secret**

   ```
   X-Telegram-Bot-Api-Secret-Token: your-webhook-secret-here
   ```

3. **OpenClaw 验证 secret**
   - grammy 的 `webhookCallback` 自动验证请求头
   - 如果不匹配，拒绝请求（返回 403）

#### 12.2.2 配置方式

```json
{
  "channels": {
    "telegram": {
      "botToken": "your-bot-token",
      "webhookUrl": "https://your-domain.com/telegram-webhook",
      "webhookSecret": "your-webhook-secret-here"
    }
  }
}
```

#### 12.2.3 为什么不使用 gateway token？

| 原因              | 说明                                          |
| ----------------- | --------------------------------------------- |
| **Telegram 机制** | Telegram Bot API 要求使用 `secret_token` 参数 |
| **独立性**        | Webhook 认证与 Gateway API 认证分离           |
| **安全性**        | 即使 gateway token 泄露，也不会影响 webhook   |
| **灵活性**        | 可以独立配置和管理                            |

### 12.3 Feishu 配置

从源码搜索结果可以看到，Feishu 也使用类似的 webhook 机制。

#### 12.3.1 配置方式

```json
{
  "channels": {
    "feishu": {
      "appSecret": "your-feishu-app-secret-here"
    }
  }
}
```

#### 12.3.2 认证机制

- `appSecret` 用于验证来自 Feishu 的请求
- Feishu 推送消息时会携带签名信息
- OpenClaw 使用 `appSecret` 验证签名

#### 12.3.3 获取 App Secret

1. 登录 [飞书开放平台](https://open.feishu.cn/)
2. 创建应用
3. 在应用设置中获取 `App ID` 和 `App Secret`
4. 配置 webhook URL

### 12.4 认证机制对比

| 端点                | 认证方式             | 配置项                            | 用途                    |
| ------------------- | -------------------- | --------------------------------- | ----------------------- |
| Gateway API         | `gateway.auth.token` | `gateway.auth.token`              | WebSocket 连接、控制 UI |
| `/telegram-webhook` | `webhookSecret`      | `channels.telegram.webhookSecret` | Telegram 消息推送       |
| `/feishu-webhook`   | `appSecret`          | `channels.feishu.appSecret`       | Feishu 消息推送         |
| `/slack-webhook`    | Signing Secret       | `channels.slack.signingSecret`    | Slack 消息推送          |

### 12.5 安全最佳实践

#### 12.5.1 Token 管理

```bash
# 生成强 token
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

#### 12.5.2 配置示例

```json
{
  "gateway": {
    "bind": "0.0.0.0:8788",
    "auth": {
      "mode": "token",
      "token": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f"
    }
  },
  "channels": {
    "telegram": {
      "botToken": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
      "webhookUrl": "https://your-domain.com/telegram-webhook",
      "webhookSecret": "f1e2d3c4b5a6987654321fedcba9876543210abcdef"
    },
    "feishu": {
      "appSecret": "cli_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
    }
  }
}
```

#### 12.5.3 环境变量示例

```bash
# Gateway token
export OPENCLAW_GATEWAY_TOKEN="your-gateway-token-here"

# Telegram bot token
export TELEGRAM_BOT_TOKEN="your-bot-token"

# Feishu app secret
export FEISHU_APP_SECRET="your-feishu-app-secret"
```

---

## 第十三章：Webhook 超时处理

### 13.1 Telegram Webhook 超时限制

根据 Telegram Bot API 官方文档：

| 参数             | 值        | 说明                                       |
| ---------------- | --------- | ------------------------------------------ |
| **响应超时**     | **60 秒** | Telegram 服务器等待 webhook 响应的最长时间 |
| **重试机制**     | 自动重试  | 如果超时或返回 5xx 错误，Telegram 会重试   |
| **重试次数**     | 多次      | 通常会重试多次，间隔递增                   |
| **最大重试时间** | 24 小时   | 最多保留 24 小时后丢弃                     |

### 13.2 超时场景分析

#### 场景 1：处理时间超过 60 秒

```
用户发送消息 → Telegram 推送到 webhook → OpenClaw 开始处理
  ↓
处理超过 60 秒 → Telegram 超时 → 返回错误
  ↓
Telegram 稍后重试 → OpenClaw 收到重复消息 → 可能重复处理
```

**影响**：

- 用户可能会收到重复的回复
- 消息可能被处理多次
- 用户体验下降

#### 场景 2：OpenClaw 崩溃或网络中断

```
用户发送消息 → Telegram 推送到 webhook → 连接失败
  ↓
Telegram 返回 5xx 错误 → 稍后重试
  ↓
重复重试，最多 24 小时
```

**影响**：

- 消息延迟
- 如果长时间无法恢复，消息可能丢失

#### 场景 3：处理逻辑卡住

```
用户发送消息 → OpenClaw 开始处理
  ↓
处理逻辑进入死循环或等待外部资源
  ↓
60 秒后超时 → Telegram 重试
  ↓
重复处理，可能导致资源耗尽
```

**影响**：

- 重复处理
- 资源耗尽
- 可能触发 Telegram 的限流

### 13.3 OpenClaw 的配置选项

#### 13.3.1 `timeoutSeconds` 配置

从源码 [src/config/types.telegram.ts:103](file:///home/gee/projects/gee/openclaw-debug/src/config/types.telegram.ts#L103) 可以看到：

```json
{
  "channels": {
    "telegram": {
      "timeoutSeconds": 60
    }
  }
}
```

**作用**：

- 控制 OpenClaw 调用 Telegram API 的超时时间
- **不是** webhook 响应的超时时间
- 默认值：60 秒

**注意**：

- 这个配置只影响 OpenClaw 主动调用 Telegram API 的超时
- 不影响 Telegram 推送消息到 webhook 的超时

#### 13.3.2 健康检查端点

从源码 [src/telegram/webhook.ts:34](file:///home/gee/projects/gee/openclaw-debug/src/telegram/webhook.ts#L34) 可以看到：

```typescript
const healthPath = opts.healthPath ?? "/healthz";
```

**用途**：

- 用于负载均衡器或反向代理的健康检查
- 确保服务正常运行
- 不影响 webhook 消息处理

**示例**：

```bash
curl https://your-domain.com/healthz
# 返回：ok
```

### 13.4 最佳实践

#### 13.4.1 快速响应 + 异步处理

**❌ 不好的做法：同步处理，可能超时**

```typescript
app.post("/telegram-webhook", (req, res) => {
  const result = await processMessage(req.body); // 可能需要 2 分钟
  res.send(result);
});
```

**✅ 好的做法：快速响应，异步处理**

```typescript
app.post("/telegram-webhook", (req, res) => {
  res.status(200).send("OK"); // 立即响应

  // 异步处理
  processMessage(req.body).catch((err) => {
    console.error("处理失败:", err);
  });
});
```

**OpenClaw 的实现**：

从源码 [src/telegram/webhook.ts:72-93](file:///home/gee/projects/gee/openclaw-debug/src/telegram/webhook.ts#L72-L93) 可以看到，OpenClaw 使用了类似的模式：

```typescript
const handled = handler(req, res);
if (handled && typeof handled.catch === "function") {
  void handled
    .then(() => {
      if (diagnosticsEnabled) {
        logWebhookProcessed({
          channel: "telegram",
          updateType: "telegram-post",
          durationMs: Date.now() - startTime,
        });
      }
    })
    .catch((err) => {
      const errMsg = formatErrorMessage(err);
      if (diagnosticsEnabled) {
        logWebhookError({
          channel: "telegram",
          updateType: "telegram-post",
          error: errMsg,
        });
      }
      runtime.log?.(`webhook handler failed: ${errMsg}`);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
}
```

#### 13.4.2 幂等性处理

**避免重复处理**：

```typescript
const processedUpdates = new Set();

async function processMessage(update) {
  const { update_id } = update;

  if (processedUpdates.has(update_id)) {
    console.log("重复消息，跳过处理");
    return;
  }

  processedUpdates.add(update_id);

  // 定期清理旧的 update_id
  if (processedUpdates.size > 10000) {
    const oldest = Array.from(processedUpdates)[0];
    processedUpdates.delete(oldest);
  }

  // 处理消息...
}
```

#### 13.4.3 超时保护

**设置处理超时**：

```typescript
const PROCESSING_TIMEOUT_MS = 50000; // 50 秒，留 10 秒余量

async function processMessageWithTimeout(update) {
  return Promise.race([
    processMessage(update),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("处理超时")), PROCESSING_TIMEOUT_MS),
    ),
  ]);
}
```

#### 13.4.4 错误处理

**优雅降级**：

```typescript
async function processMessage(update) {
  try {
    const result = await handleMessage(update);
    return result;
  } catch (err) {
    console.error("处理失败:", err);

    // 发送错误消息给用户
    await sendErrorMessage(update, "处理失败，请稍后重试");

    // 记录错误日志
    logError(err);

    // 返回成功，避免 Telegram 重试
    return { success: false };
  }
}
```

### 13.5 监控和告警

#### 13.5.1 关键指标

| 指标     | 阈值    | 说明                       |
| -------- | ------- | -------------------------- |
| 响应时间 | < 10 秒 | 大部分请求应在 10 秒内完成 |
| 超时率   | < 1%    | 超时请求比例应低于 1%      |
| 错误率   | < 0.1%  | 错误请求比例应低于 0.1%    |
| 重试率   | < 5%    | 重复消息比例应低于 5%      |

#### 13.5.2 日志记录

```typescript
// 记录处理时间
const startTime = Date.now();
await processMessage(update);
const duration = Date.now() - startTime;

if (duration > 5000) {
  console.warn(`处理时间过长: ${duration}ms`);
}

// 记录错误
if (err) {
  console.error("处理失败:", {
    error: err.message,
    update_id: update.update_id,
    duration,
  });
}
```

### 13.6 故障排查

#### 13.6.1 检查 Webhook 状态

```bash
curl https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo
```

**关注字段**：

- `pending_update_count`: 待处理消息数量（应接近 0）
- `last_error_date`: 最后一次错误时间
- `last_error_message`: 最后一次错误消息

#### 13.6.2 检查处理时间

```typescript
// 在 webhook 处理器中添加计时
const startTime = Date.now();
await handler(req, res);
const duration = Date.now() - startTime;

console.log(`处理时间: ${duration}ms`);

if (duration > 50000) {
  console.warn("处理时间接近超时！");
}
```

#### 13.6.3 检查重复消息

```typescript
// 记录 update_id
const seenUpdates = new Set();

app.post("/telegram-webhook", (req, res) => {
  const { update_id } = req.body;

  if (seenUpdates.has(update_id)) {
    console.log(`重复消息: ${update_id}`);
  }

  seenUpdates.add(update_id);
  // ...
});
```

### 13.7 总结

| 问题                            | 答案                                     |
| ------------------------------- | ---------------------------------------- |
| **Telegram webhook 超时时间？** | **60 秒**，超时会自动重试                |
| **如果卡住了？**                | Telegram 会重试，可能导致重复处理        |
| **如何避免超时？**              | 快速响应 + 异步处理                      |
| **如何避免重复处理？**          | 使用 `update_id` 实现幂等性              |
| **如何监控？**                  | 记录响应时间、错误率、重试率             |
| **最佳实践？**                  | 快速响应、异步处理、幂等性保护、错误处理 |

---

## 第十四章：总结

### 核心要点

1. **双向通讯原理**：
   - 接收消息：Telegram 服务器主动推送（Webhook）或主动轮询（Polling）
   - 发送消息：OpenClaw 主动调用 Telegram Bot API

2. **只需要一个 Token**：
   - Token 用于身份验证和 API 访问
   - Webhook URL 在运行时动态设置

3. **启动流程**：
   - OpenClaw 启动时自动设置 webhook（如果配置了）
   - 确保 Telegram 服务器知道最新的 webhook URL

4. **冲突处理**：
   - Webhook 模式：最后设置者生效
   - Polling 模式：409 错误 + 指数退避重试

5. **配置方式**：
   - 环境变量：简单场景
   - 配置文件：生产环境（`/data/.openclaw/openclaw.json`）

6. **重启策略**：
   - Webhook 配置需要重启
   - 其他配置支持热重载

7. **认证机制**：
   - Gateway API：使用 `gateway.auth.token` 认证
   - Telegram Webhook：使用独立的 `webhookSecret` 认证
   - Feishu：使用 `appSecret` 认证
   - 不同端点使用不同的认证方式，提高安全性

8. **超时处理**：
   - Telegram webhook 超时：60 秒
   - 超时会自动重试，可能导致重复处理
   - 最佳实践：快速响应 + 异步处理 + 幂等性保护

### 快速参考

| 场景     | 推荐模式           | 配置                           |
| -------- | ------------------ | ------------------------------ |
| 生产环境 | Webhook            | `webhookUrl` + `webhookSecret` |
| 开发环境 | Polling            | 无需额外配置                   |
| 内网部署 | Polling            | 无需额外配置                   |
| 高可用   | Polling + 消息队列 | 多实例 + 去重                  |

### 认证配置参考

| 端点                | 认证方式             | 配置项                            |
| ------------------- | -------------------- | --------------------------------- |
| Gateway API         | `gateway.auth.token` | `gateway.auth.token`              |
| `/telegram-webhook` | `webhookSecret`      | `channels.telegram.webhookSecret` |
| `/feishu-webhook`   | `appSecret`          | `channels.feishu.appSecret`       |

### 超时配置参考

| 配置项                | 默认值  | 说明                              |
| --------------------- | ------- | --------------------------------- |
| Telegram webhook 超时 | 60 秒   | Telegram 服务器等待响应的时间     |
| `timeoutSeconds`      | 60 秒   | OpenClaw 调用 Telegram API 的超时 |
| 建议处理时间          | < 10 秒 | 大部分请求应在 10 秒内完成        |

---

**文档版本**: 3.0  
**最后更新**: 2026-02-27  
**维护者**: OpenClaw Team
