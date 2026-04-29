# OpenClaw for Unraid

**Languages:** [English](./README.md) · [Русский](./README.ru.md) · [中文](./README.zh.md)

[![Unraid](https://img.shields.io/badge/Unraid-CA%20Template-orange)](https://unraid.net/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[OpenClaw](https://github.com/openclaw/openclaw) 的 Community Applications 模板 —— 一个可以在你的 Unraid 服务器上本地运行的自托管 AI 助手网关。

![OpenClaw 仪表板](screenshot.png)

## 目录

- [OpenClaw 是什么？](#what-is-openclaw)
- [系统要求](#requirements)
- [快速开始](#quick-start)
- [自定义 LLM 路由器](#custom-llm-router-litellm-vllm-ollama-etc)
- [配置说明](#configuration)
- [更新升级](#updating)
- [故障排查](#troubleshooting)
- [Community Apps 审核前安装](#install-before-community-apps-approval)
- [资源链接](#resources)
- [许可证](#license)
- [致谢](#credits)

---

## OpenClaw 是什么？<a id="what-is-openclaw"></a>

OpenClaw 是一个运行在你自己服务器上的个人 AI 助手。它通过你日常使用的消息渠道与你交互，并将所有数据保存在你的本地机器上。

### 多渠道消息支持
- WhatsApp、Telegram、Discord、Slack、Google Chat、Signal、iMessage、Microsoft Teams、Matrix、Mattermost、BlueBubbles —— 以及通过插件支持更多平台。

### 强大功能
- 多智能体路由 —— 用独立工作区隔离不同渠道和用户
- 文件管理 —— 在服务器上读写、整理文件
- Shell 命令 —— 执行脚本、管理 Docker、自动化各类任务
- 浏览器控制 —— 上网调研、抓取数据、与网页交互
- Cron 任务 —— 定时任务、提醒、自动化工作流
- 技能系统 —— 通过内置或自定义技能扩展能力
- 语音唤醒 + 对话模式 —— 常驻语音监听与 TTS
- 实时画布 —— 由智能体驱动的可视化工作区
- 移动端节点 —— iOS 和 Android 配套应用

### 数据属于你，服务器属于你
工作区和配置 100% 保留在你的 Unraid 服务器上。对话通过你选择的 LLM 提供商 API 进行处理。如需完全本地化运行，可将**自定义 LLM Base URL** 指向运行在局域网内的 [Ollama](https://ollama.ai)、[LiteLLM](https://github.com/BerriAI/litellm) 或任何兼容 OpenAI 接口的路由器。

## 系统要求<a id="requirements"></a>

- 已启用 Docker 的 Unraid 6.x 或 7.x
- 网关令牌（任意密钥字符串，可用 `openssl rand -hex 24` 生成）
- Allowed Origins URL（例如 `http://YOUR-UNRAID-IP:18789`）—— 参见[为何必填](#allowed-origins-required-since-openclaw-20262)
- 一个 LLM 来源，二选一：
  - 内置提供商的 API 密钥（Anthropic、OpenAI、OpenRouter、Gemini、Groq、xAI、Z.AI），**或**
  - 自定义 LLM 端点 URL（LiteLLM、vLLM、Ollama 或你自己的路由器）—— 参见[自定义 LLM 路由器](#custom-llm-router-litellm-vllm-ollama-etc)

### 获取 Anthropic API 密钥

1. 访问 [console.anthropic.com](https://console.anthropic.com)
2. 添加付款方式（设置 → 账单）
3. 打开 **API Keys**，创建一个新密钥（以 `sk-ant-` 开头）

> **注意：** API 访问需要控制台充值额度，与 Claude.ai Pro/Max 聊天订阅是独立的。**请勿**使用 `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` 来驱动 OpenClaw —— Anthropic 禁止将 Claude Code 订阅令牌用于第三方工具，违规可能导致账号被封禁。

### 使用非 Anthropic 提供商（OpenAI、Gemini、Groq、OpenRouter、xAI、Z.AI） <a id="using-non-anthropic-providers-openai-gemini-groq-openrouter-xai-zai"></a>

OpenClaw 默认使用 Anthropic 的 Claude 模型。**如果你使用其他提供商，请在安装后修改默认模型：**

1. 用你的 API 密钥安装 OpenClaw（例如 `GEMINI_API_KEY`）
2. 打开控制 UI → **Config** 标签页 → **Agents** → **Raw JSON**
3. 将 `agents.defaults.model.primary` 设置为对应提供商的模型：

| 提供商 | 模型示例 |
|--------|---------|
| Anthropic | `anthropic/claude-sonnet-4-5`（默认） |
| Google Gemini | `google/gemini-2.0-flash` |
| OpenAI | `openai/gpt-4o` |
| Groq | `groq/llama-3.1-70b-versatile` |
| OpenRouter | `openrouter/anthropic/claude-3-sonnet` |

4. 保存并重启容器。

> **为什么？** OpenClaw 不会根据 API 密钥自动识别提供商。如果你填了 Gemini 的密钥但保留了默认模型，会收到 `No API key found for provider "anthropic"` 报错。

## 快速开始<a id="quick-start"></a>

### 第一步：从 Community Apps 安装

1. 在 Community Applications 中搜索 **OpenClaw**
2. 点击 **Install**
3. 填写**所有必填字段**：
   - **Gateway Token** —— `openssl rand -hex 24` 或任意密钥值
   - **Allowed Origins** —— `http://YOUR-UNRAID-IP:18789`（填写你的 Unraid IP 和控制 UI 端口）。多个值用英文逗号分隔，不要有空格。**必填 —— 不填网关将拒绝启动。**
   - **LLM 来源** —— 以下二选一：内置提供商 API 密钥（Anthropic、OpenAI 等）**或**自定义 LLM 端点 —— 参见[自定义 LLM 路由器](#custom-llm-router-litellm-vllm-ollama-etc)了解完整字段说明
4. 点击 **Apply**

### 第二步：打开控制 UI

```
http://YOUR-UNRAID-IP:18789/?token=YOUR_GATEWAY_TOKEN
```

`?token=` 参数是必须的。示例：`http://192.168.1.41:18789/?token=mySecretToken123`

### 第三步：选择正确的模型（安装后）

如果你使用了非 Anthropic 提供商或自定义 LLM 端点：

1. 控制 UI → **Config** 标签页 → **Agents** 子标签 → **Raw JSON**
2. 设置 `agents.defaults.model.primary`（内置提供商参见上方表格；自定义路由器使用 `custom/<your-model-id>`）
3. **Save** → 重启容器

### 第四步：（可选）连接消息渠道

控制 UI → **Config** → **Channels** —— 填写 Telegram/Discord/Slack 等渠道信息。或在模板中填入机器人令牌（Discord、Telegram），然后在收到第一条消息后通过 **Agents** 标签页完成配对。

## 自定义 LLM 路由器（LiteLLM、vLLM、Ollama 等） <a id="custom-llm-router-litellm-vllm-ollama-etc"></a>

如果你运行自己的 LLM 路由器或本地模型服务，在模板中填写四个 **Custom LLM** 字段，替代（或搭配）内置提供商密钥使用。

| 字段 | 用途 | 示例 |
|------|------|------|
| `Custom LLM Base URL` | 端点根地址 | `http://192.168.1.50:11434/v1`（Ollama），`http://litellm:4000/v1`，`https://my-router.example.com/v1` |
| `Custom LLM API Key` | 认证令牌 | `ollama`（本地 Ollama），其他路由器填对应令牌 |
| `Custom LLM API Type` | 协议适配器（**非**模型名称） | 以下之一：`openai-completions`（默认，适用于 LiteLLM/vLLM/Ollama/OpenRouter），`openai-responses`，`openai-codex-responses`，`anthropic-messages`，`google-generative-ai`，`github-copilot`，`bedrock-converse-stream`，`ollama`，`azure-openai-responses` |
| `Custom LLM Model ID` | 端点暴露的模型 ID | `gpt-5.5`，`llama-3.1-70b`，或多个：`gpt-5.5,claude-3-opus` |

> **常见错误：** `Custom LLM API Type` 是**协议适配器**，不是模型名称。填入模型名称会导致 OpenClaw schema 校验失败，网关拒绝启动。模型名称应填在 `Custom LLM Model ID` 字段。

当 `Custom LLM Base URL` 已设置时，启动脚本会通过原生 `openclaw config set` CLI 向 `openclaw.json` 写入 `models.providers.custom` 块：

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "custom": {
        "baseUrl": "http://litellm:4000/v1",
        "apiKey": "${CUSTOM_LLM_API_KEY}",
        "api": "openai-completions",
        "models": [
          { "id": "gpt-5.5", "name": "gpt-5.5", "contextWindow": 128000, "maxTokens": 32000 }
        ]
      }
    }
  }
}
```

`${CUSTOM_LLM_API_KEY}` 引用在网关启动时解析，因此密钥不会以明文写入配置文件。

> **说明：** 生成配置中的 `contextWindow` 和 `maxTokens` 来自模板字段 **Custom LLM Context Window** 和 **Custom LLM Max Tokens**（默认值：`128000` / `32000`）。请根据你的模型调整这两个字段 —— 例如 `gpt-4o`：128000 / 16384；`claude-3-opus`：200000 / 4096；`gpt-5.5`：1050000 / 128000。

### 将智能体指向自定义提供商

安装后，将默认模型设置为使用你的自定义提供商：

1. 控制 UI → **Config** → **Agents** → **Raw JSON**
2. 添加（或编辑）agents 块：
   ```json
   {
     "agents": {
       "defaults": {
         "model": { "primary": "custom/llama-3.1-70b" }
       }
     }
   }
   ```
   将 `llama-3.1-70b` 替换为你的路由器实际暴露的模型 ID。
3. 保存 → 重启容器

### 允许的来源（OpenClaw 2026.2 起必填）<a id="allowed-origins-required-since-openclaw-20262"></a>

从 OpenClaw `2026.2.x` 开始，若未显式设置 `gateway.controlUi.allowedOrigins`，网关将拒绝在非回环地址上启动。模板通过 `OPENCLAW_ALLOWED_ORIGINS` 变量强制执行此要求。

- **单个值：** `http://192.168.1.41:18789`
- **多个值（逗号分隔）：** `http://192.168.1.41:18789,http://openclaw.local:18789`
- **反向代理用户：** 同时添加代理后的来源 —— 例如 `http://192.168.1.41:18789,https://openclaw.example.com`

列表中必须填写**完整来源**（协议 + 主机 + 端口），不支持通配符，不允许末尾斜杠。

## 配置说明<a id="configuration"></a>

### 模板设置参考

| 设置项 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| **端口** | | | | |
| Control UI Port | Port | 是 | `18789` | Web UI 和网关 API 端口 |
| **路径** | | | | |
| Config Path | Path | 是 | `/mnt/user/appdata/openclaw/config` | 配置、会话、凭据 |
| Workspace Path | Path | 是 | `/mnt/user/appdata/openclaw/workspace` | 智能体文件、记忆、项目 |
| Projects Path | Path | 否 | `/mnt/user/appdata/openclaw/projects` | 额外的代码项目（高级用法） |
| Homebrew Path | Path | 否 | `/mnt/user/appdata/openclaw/homebrew` | 持久化 Homebrew 软件包 |
| Local Tools Path | Path | 否 | `/mnt/user/appdata/openclaw/local` | 持久化 `~/.local` —— pip `--user` 安装、手动构建的 CLI 工具（`bin/`）、库文件（`lib/`）。容器重启后保留。 |
| Logs Path | Path | 否 | `/mnt/user/appdata/openclaw/logs` | 网关日志文件（挂载到 `/tmp/openclaw` —— OpenClaw 运行时始终写入此处，参见 [issue #61295](https://github.com/openclaw/openclaw/issues/61295)） |
| **必填项** | | | | |
| Gateway Token | Variable | 是 | — | API/UI 访问密钥 |
| Allowed Origins | Variable | 是 | — | 逗号分隔的浏览器来源。参见[上方章节](#allowed-origins-required-since-openclaw-20262) |
| **自定义 LLM（内置密钥的可选替代方案）** | | | | |
| Custom LLM Base URL | Variable | 否 | — | 端点根地址 URL |
| Custom LLM API Key | Variable | 否 | — | 自定义端点令牌 |
| Custom LLM API Type | Variable | 否 | `openai-completions` | 协议适配器 —— 参见[下方列表](#custom-llm-router-litellm-vllm-ollama-etc) |
| Custom LLM Model ID | Variable | 否 | — | 端点暴露的模型 ID。设置了 Custom LLM Base URL 则为必填。多个用逗号分隔。 |
| Custom LLM Context Window | Variable | 否 | `128000` | 总上下文窗口（token 数）。请与你模型的实际值保持一致（gpt-4o=128k，claude-3-opus=200k，gpt-5=400k）。 |
| Custom LLM Max Tokens | Variable | 否 | `32000` | 每次响应的最大输出 token 数。请与你的模型保持一致（gpt-4o=16384，claude-3-opus=4096，gpt-5=32000）。 |
| **内置 LLM 提供商** | | | | |
| Anthropic API Key | Variable | 否 | — | Claude 系列模型 |
| OpenAI API Key | Variable | 否 | — | GPT 系列模型 |
| OpenRouter API Key | Variable | 否 | — | 单一 API 接入 100+ 模型 |
| Gemini API Key | Variable | 否 | — | Google Gemini |
| Groq API Key | Variable | 否 | — | 高速 Llama/Mixtral |
| xAI API Key | Variable | 否 | — | Grok |
| Z.AI API Key | Variable | 否 | — | 智谱 GLM |
| **订阅认证** | | | | |
| GitHub Copilot Token | Variable | 否 | — | 高级用法 —— 参见 OpenClaw 文档 |
| **渠道（安装后配置）** | | | | |
| Discord Bot Token | Variable | 否 | — | Discord 集成 |
| Telegram Bot Token | Variable | 否 | — | 通过 [@BotFather](https://t.me/BotFather) 创建的 Telegram 机器人 |
| **高级设置** | | | | |
| Gateway Port | Variable | 否 | `18789` | 如果 18789 端口被占用则在此覆盖 |
| Disable Device Auth | Variable | 否 | `true` | 局域网友好的默认值；如果你通过 HTTPS 访问 UI，请设为 `false` |
| Log Max File Bytes | Variable | 否 | `26214400` | 日志文件轮转前的大小上限（25 MB）。归档数量由 OpenClaw 硬编码为 5。 |
| Skip Permission Fix | Variable | 否 | `0` | 设为 `1` 可禁用通用权限修复（umask 0002 + 目录 setgid）。仅在你自行管理权限时禁用。 |
| Perm Fix Interval | Variable | 否 | `5` | 运行时属主同步轮询间隔（秒）（`chown --reference` 循环）。慢速磁盘建议调大至 30+；设为 0 则仅在启动时执行一次。 |
| PATH | Variable | 否 | （自动设置） | 系统 PATH —— 包含 `~/.local/bin`、`~/.cargo/bin`、Homebrew、Bun。完整值见 `openclaw.xml` 的 `<Default>`。 |
| Web Search API Key | Variable | 否 | — | Brave Search API |

### 卷挂载

| 容器路径 | 主机路径 | 说明 |
|---------|---------|------|
| `/root/.openclaw` | `/mnt/user/appdata/openclaw/config` | 配置文件、会话、凭据 |
| `/home/node/clawd` | `/mnt/user/appdata/openclaw/workspace` | 智能体工作区 |
| `/projects` | `/mnt/user/appdata/openclaw/projects` | 可选的代码项目 |
| `/home/linuxbrew/.linuxbrew` | `/mnt/user/appdata/openclaw/homebrew` | Homebrew 软件包 |
| `/root/.local` | `/mnt/user/appdata/openclaw/local` | `~/.local` —— pip `--user` 安装、手动构建的 CLI（如 `~/.local/bin/obscura`）、库文件 |
| `/tmp/openclaw` | `/mnt/user/appdata/openclaw/logs` | 网关日志文件（由 OpenClaw 轮转，默认上限约 150 MB） |

### 日志

OpenClaw 运行时始终将日志写入 `/tmp/openclaw/openclaw-YYYY-MM-DD.log`（`logging.file` 配置项目前被忽略 —— 参见 [openclaw issue #61295](https://github.com/openclaw/openclaw/issues/61295)）。模板将 `/tmp/openclaw` 挂载到主机的 `/mnt/user/appdata/openclaw/logs`，使日志不占用容器 overlay 文件系统。

内置轮转规则：当活跃日志达到 `Log Max File Bytes`（默认 25 MB）时，OpenClaw 将其重命名为 `openclaw-YYYY-MM-DD.1.log` 并重新开始写入。保留 5 个带编号的归档（数量由 OpenClaw 硬编码）。总磁盘占用上限约为 `6 * Log Max File Bytes` = 默认约 150 MB。

实时追踪日志：
```bash
tail -f /mnt/user/appdata/openclaw/logs/openclaw-*.log
```

清除日志：
```bash
rm /mnt/user/appdata/openclaw/logs/openclaw-*.log
docker restart OpenClaw
```

### Homebrew 与技能支持

部分技能需要 `go`、`npm` 或其他可通过 brew 安装的工具。Homebrew 为**可选项**。

安装方法：打开容器控制台并运行：
```bash
NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

忽略"Next steps"输出 —— 模板已自动配置好 `PATH`。Homebrew 和软件包会持久保存在 `Homebrew Path` 卷中。

**已知限制：** 需要 Go 的技能（`blogwatcher`、`blucli`）在首次安装时可能因 Go 下载而超时。再次点击 **Install** 即可成功。

### 配置文件参考

主配置文件：`/mnt/user/appdata/openclaw/config/openclaw.json`

启动脚本在首次启动时生成最小配置：
```json
{
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "controlUi": {
      "allowInsecureAuth": true,
      "allowedOrigins": ["http://YOUR-UNRAID-IP:18789"]
    },
    "auth": { "mode": "token" }
  }
}
```

如果设置了 `Custom LLM Base URL`，还会同时写入 `models.providers.custom` 块。

首次启动后，OpenClaw 将接管此文件 —— 请通过控制 UI 的 **Config** → **Raw JSON** 进行编辑，以确保修改不丢失。

> **注意：** OpenClaw 在自身写入时（如通过控制 UI 点击 Save）会重写配置文件，并将 `${VAR}` 引用序列化为明文。如果你手动编辑文件并使用了环境变量替换，下次通过 UI 保存时可能会将解析后的值直接写入。

完整 schema 参考：[docs.openclaw.ai/gateway/configuration-reference](https://docs.openclaw.ai/gateway/configuration-reference)

### 连接消息渠道

安装后，通过控制 UI 的 **Config** 页面配置渠道，或直接编辑 `openclaw.json`：

```json
{
  "channels": {
    "discord": { "enabled": true, "token": "${DISCORD_BOT_TOKEN}" },
    "telegram": { "enabled": true, "botToken": "${TELEGRAM_BOT_TOKEN}" }
  }
}
```

完整渠道指南：[OpenClaw 文档 —— Channels](https://docs.openclaw.ai/channels)

## 更新升级<a id="updating"></a>

**通过 Unraid Docker UI：**
1. Docker 标签页 → 点击 OpenClaw 图标 → Check for Updates → Apply

**通过命令行：**
```bash
docker pull ghcr.io/openclaw/openclaw:latest
docker restart OpenClaw
```

**当模板本身有变更时**（新增环境变量、更新 PostArgs、ExtraParams 结构调整）：

```bash
python3 scripts/merge-template.py \
    --stored /boot/config/plugins/dockerMan/templates-user/my-OpenClaw.xml \
    --upstream /boot/config/plugins/dockerMan/templates-user/openclaw.xml \
    --output /boot/config/plugins/dockerMan/templates-user/my-OpenClaw.xml
```

该脚本将用户在已存模板中填写的值覆盖到上游 XML 上，同时保留原文件的 `.bak` 备份，并打印出所有需要你在 Unraid 编辑容器 UI 中审查的新字段。请在点击**编辑容器**之前运行此脚本，以确保你的令牌、API 密钥和路径在获取新模板字段的同时不会丢失。

## 故障排查<a id="troubleshooting"></a>

### `origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)`

你的浏览器来源不在 `allowedOrigins` 列表中。

1. 确认 **Allowed Origins** 模板字段与你打开的 URL **完全匹配** —— 包括协议（`http`/`https`）、主机（IP 或主机名）和端口。`http://192.168.1.41:18789` ≠ `http://homelab:18789`。
2. 如果你从多个主机名访问（局域网 IP + mDNS + 反向代理），请将**全部**来源用逗号分隔添加进去：
   ```
   http://192.168.1.41:18789,http://openclaw.local:18789,https://openclaw.example.com
   ```
3. 编辑模板变量，点击 **Apply**，然后**重启**容器。启动脚本是幂等的，下次启动时会合并新的来源，不会影响其他配置。

### `non-loopback Control UI requires gateway.controlUi.allowedOrigins`

网关因未设置允许来源而拒绝启动。按上述说明填写 **Allowed Origins** 模板字段，然后重启。

### `control ui requires device identity (use HTTPS or localhost secure context)`

浏览器要求安全上下文（HTTPS 或 `http://localhost`）才能使用 OpenClaw 用于设备身份签名的 Web Crypto API。局域网 IP/主机名上的普通 HTTP 不符合要求。

两种解决方案：
- **使用 HTTPS** —— 用反向代理（Traefik、Caddy、NPM）为容器提供 HTTPS，通过 `https://your-domain/?token=...` 访问。然后在模板中将 `OPENCLAW_DISABLE_DEVICE_AUTH=false` 以启用完整的设备身份保护。
- **禁用设备认证（此模板默认方案）** —— `OPENCLAW_DISABLE_DEVICE_AUTH=true`（默认值）。仍然需要令牌认证。对于仅局域网/homelab 使用是可接受的；不建议在公网上使用。

此模板默认值为 `true`，因为大多数 Unraid 用户通过局域网普通 HTTP 访问控制 UI。如果你的配置已经提供了 HTTPS，可以切换为 `false`。

### `disconnected (1008): control ui requires HTTPS or localhost`

请确认 URL 中附带了令牌：
```
http://YOUR-IP:18789/?token=YOUR_TOKEN
```

如果错误依然存在，请验证配置文件：
```bash
cat /mnt/user/appdata/openclaw/config/openclaw.json
```

### `No API key found for provider "anthropic"`

你填写了非 Anthropic 的密钥，但默认模型仍是 `anthropic/claude-sonnet-4-5`。请将 `agents.defaults.model.primary` 修改为对应提供商 —— 参见[使用非 Anthropic 提供商](#using-non-anthropic-providers-openai-gemini-groq-openrouter-xai-zai)。

### `Config invalid` / `models.providers.custom.api: Invalid option`

你在 **Custom LLM API Type** 中填入了模型名称（如 `gpt-5.5`）。该字段是**协议适配器** —— 有效值参见[自定义 LLM 路由器](#custom-llm-router-litellm-vllm-ollama-etc)章节。模型名称应填在 **Custom LLM Model ID** 字段。

修正模板字段，点击 **Apply**，重启容器。

### `models.providers.custom.models: Invalid input: expected array`

已声明自定义 LLM 端点，但 **Custom LLM Model ID** 为空。请至少填写一个模型 ID（如 `gpt-5.5`）。

### appdata 文件夹中的文件通过 SMB/NFS 不可见

容器以 root 运行。若不加干预，所有新文件都会以 `root:root 0600` 的权限创建，SMB 共享用户将无法看到任何内容。

启动脚本在每次容器启动时分两阶段处理此问题：

1. **一次性修复** —— 将所属权与挂载根目录对齐，并对目录设置 `umask 0002` + `chmod g+s`，使新文件继承组权限。
2. **后台属主同步循环** —— 每隔 `OPENCLAW_PERM_FIX_INTERVAL` 秒（默认 5 秒）对挂载根目录重新执行 `chown --reference`。可捕获 OpenClaw 运行时轮转/写入的文件（如每次 UI 保存后生成的 `openclaw.json.bak`）。

#### 主机端一次性配置

启动脚本从挂载点本身读取 UID/GID 信息，因此**只需在主机上设置一次**所有权，设置为你的 SMB/NFS 用户期望的值。使用 `id $USER` 查找你的 UID/GID，然后执行：

```bash
# 将 YOUR_UID:YOUR_GID 替换为你的实际值（例如 99:100 = nobody:users）
chown -R YOUR_UID:YOUR_GID /mnt/user/appdata/openclaw
chmod -R g+rwX,o+rX /mnt/user/appdata/openclaw
find /mnt/user/appdata/openclaw -type d -exec chmod g+s {} +
```

这与启动脚本在启动时执行的操作完全相同。手动执行可立即修复现有文件，无需等待重启。之后重启容器（或等待 `OPENCLAW_PERM_FIX_INTERVAL` 秒），让运行时循环获取新的属主引用。

#### 验证

```bash
ls -la /mnt/user/appdata/openclaw/config/
```

目录应显示 `drwxrwsr-x`，属主为你的 UID/GID（组执行位中的 `s` 是 setgid 标志）。大多数文件显示 `-rw-rw-r--`。注意：**`openclaw.json` 始终保持 `-rw-------`** —— OpenClaw 故意以 0600 模式写入，因为该文件包含网关令牌和提供商 API 密钥。属主通过 SMB 可以正常读取；其他用户被设计为无法访问。

#### 调优

- `OPENCLAW_PERM_FIX_INTERVAL` —— 运行时属主同步循环的间隔（秒）。默认 5 秒。慢速磁盘建议调大至 30+。
- `OPENCLAW_SKIP_PERM_FIX=1` —— 同时禁用一次性修复和后台循环。仅在你自行管理权限时使用。

### 网关自重启后容器变为 STOP 状态

当你通过控制 UI 保存某些配置更改（如切换默认模型）时，OpenClaw 会退出网关进程。若没有显式设置 Docker 重启策略，容器会保持停止状态而不会自动重启。

此模板在 `ExtraParams` 中设置了 `--restart=unless-stopped`，以便 Docker 在任何非手动退出后自动重启。如果你移除了该标志，或者现有容器是在该标志添加之前创建的：

```bash
docker update --restart=unless-stopped OpenClaw
```

或通过 Unraid Web UI：**编辑容器** → 将**重启策略**设置为 `Unless Stopped` → Apply。

如果容器在保存后仍然变为 STOP 状态，请检查启动脚本的退出消息：

```bash
docker logs OpenClaw 2>&1 | grep "gateway exited"
```

`rc=0` 表示正常退出（配置重载）—— 重启策略应会自动处理。`rc=1` 或更高值表示实际崩溃；请分享周围的日志行。

### 容器无法启动 / "Missing config" 错误

先查看日志：
```bash
docker logs OpenClaw 2>&1 | tail -50
```

启动脚本会为每个操作打印 `[bootstrap]` 行。常见致命错误：
- `FATAL: OPENCLAW_ALLOWED_ORIGINS is required` —— 填写 **Allowed Origins** 模板字段。
- `FATAL: CUSTOM_LLM_API_TYPE='...' is invalid` —— 参见上方允许的适配器值。
- `FATAL: CUSTOM_LLM_MODEL_ID is required` —— 至少设置一个模型 ID。
- `FATAL: openclaw rejected the config update` —— schema 校验失败；错误下方会打印出有问题的批量 JSON。

强制重置为全新配置（会丢失 UI 中的所有编辑）：
```bash
rm /mnt/user/appdata/openclaw/config/openclaw.json
docker restart OpenClaw
```

### 在容器内重启网关

`openclaw gateway restart`（上游 CLI）在此镜像内**无法使用**。它假定主机安装了带有 systemd 用户单元的环境（`systemctl --user`）；容器内没有 systemd，因此 CLI 会报错：

```
systemctl not available; systemd user services are required on Linux.
```

这是上游已知限制，追踪于 [openclaw/openclaw#72224](https://github.com/openclaw/openclaw/issues/72224)（"fix gateway restart outside systemd"）。在该问题修复并发布前，请使用以下替代方案。

#### 三种重启方式，按影响程度从小到大排列

**1. 通过 SIGUSR1 进行热重启**（最快，无容器停机，可读取 `openclaw.json` 变更）：

```bash
docker exec OpenClaw sh -c 'kill -USR1 $(pidof openclaw-gateway)'
```

这与网关内部在配置保存后进行热重载的方式相同。渠道、插件和技能会重新初始化；飞行中的请求可能会丢失。[`docs/cli/gateway.md`](https://github.com/openclaw/openclaw/blob/main/docs/cli/gateway.md) 将其记录为一级重启触发方式（`commands.restart: true` 为默认值，因此授权已开启）。

**2. 容器重启**（保证干净状态，约 10-15 秒停机）：

- Unraid Web UI：**Docker** → 点击 OpenClaw 图标 → **Restart**，或
- ```bash
  docker restart OpenClaw
  ```

在网关卡死、升级镜像后，或 SIGUSR1 未能生效时使用此方式。

**3. 完整启动脚本重跑**（仅当配置文件本身损坏时使用）：

```bash
rm /mnt/user/appdata/openclaw/config/openclaw.json
docker restart OpenClaw
```

这会丢失 UI 侧的所有编辑 —— 启动脚本在下次启动时会从模板环境变量重新生成所有配置。作为最后手段使用。

## Community Apps 审核前安装<a id="install-before-community-apps-approval"></a>

还没进入 CA？通过终端安装：

**第一步：** SSH 登录你的 Unraid 服务器并运行：
```bash
curl -o /boot/config/plugins/dockerMan/templates-user/openclaw.xml \
  https://raw.githubusercontent.com/thebtf/openclaw-unraid/master/openclaw.xml
```

**第二步：** 刷新 Unraid Docker 页面

**第三步：** **Docker** → **Add Container** → 在模板下拉菜单中选择 **OpenClaw**

**第四步：** 填写必填字段（Gateway Token、Allowed Origins、一个 LLM 来源），点击 **Apply**。

<details>
<summary><strong>高级：手动 Docker 运行</strong></summary>

```bash
mkdir -p /mnt/user/appdata/openclaw/{config,workspace,homebrew}

docker run -d \
  --name OpenClaw \
  --network bridge \
  --user root \
  --hostname OpenClaw \
  --restart unless-stopped \
  -p 18789:18789 \
  -v /mnt/user/appdata/openclaw/config:/root/.openclaw:rw \
  -v /mnt/user/appdata/openclaw/workspace:/home/node/clawd:rw \
  -v /mnt/user/appdata/openclaw/homebrew:/home/linuxbrew/.linuxbrew:rw \
  -e OPENCLAW_GATEWAY_TOKEN=YOUR_TOKEN \
  -e OPENCLAW_ALLOWED_ORIGINS=http://YOUR-UNRAID-IP:18789 \
  -e ANTHROPIC_API_KEY=sk-ant-YOUR_KEY \
  -e PATH=/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  ghcr.io/openclaw/openclaw:latest \
  sh -c '...bootstrap from openclaw.xml PostArgs...'
```

（从 `openclaw.xml` 中复制完整的 `PostArgs` 值作为最后一个参数。）

</details>

## 记忆后端（QMD、Graphiti、FalkorDB 等）

内置默认记忆功能对日常使用完全够用。如需更好的召回能力、知识图谱，或多智能体间共享事实，请参见 [`docs/MEMORY-SETUP.zh.md`](docs/MEMORY-SETUP.zh.md) —— 包含 QMD（一键升级）、Graphiti + FalkorDB（图记忆）、Cognee 和 Mem0 的完整配置指南。

## 资源链接<a id="resources"></a>

- **Unraid 支持帖：** https://forums.unraid.net/topic/196865-support-openclaw-ai-personal-assistant/
- **OpenClaw 文档：** https://docs.openclaw.ai
- **OpenClaw GitHub：** https://github.com/openclaw/openclaw
- **OpenClaw Discord：** https://discord.gg/clawd
- **模板仓库：** https://github.com/thebtf/openclaw-unraid
- **记忆配置指南：** [`docs/MEMORY-SETUP.zh.md`](docs/MEMORY-SETUP.zh.md)

## 许可证<a id="license"></a>

[MIT](LICENSE)。OpenClaw 本身也采用 MIT 许可 —— 参见 [OpenClaw 仓库](https://github.com/openclaw/openclaw)。

## 启动脚本工作原理

启动脚本是**幂等的** —— 每次容器启动时都会重新运行，仅更新其负责的字段（`gateway.controlUi.allowedOrigins` 和 `models.providers.custom`）。你通过控制 UI 编辑的所有内容（渠道、智能体、cron 任务、工具）在重启后均会保留。

脚本使用原生 `openclaw config set --batch-json` CLI 执行合并，因此 schema 校验由 OpenClaw 自身完成：无效的 `CUSTOM_LLM_API_TYPE`、缺失的 `CUSTOM_LLM_MODEL_ID`、格式错误的来源 —— 所有问题都会在网关启动前被明确报错。

### 为什么 PostArgs 中使用 base64？

Unraid 模板运行器会将 `PostArgs` 中的 `<` 和 `>` 字符作为防御性措施过滤掉。这会破坏任何使用比较运算符（`i<=NF`）、重定向（`> file`）或 stderr（`>&2`）的内联 shell 脚本。Base64 字母表中不含这两个字符，因此脚本可以原样传递。

实际的启动脚本位于 [`scripts/bootstrap.sh`](scripts/bootstrap.sh)。容器启动时，入口点运行 `/bin/sh -c "echo BASE64 | base64 -d | /bin/sh"`，解码并执行该脚本。

### 修改启动脚本

如果你 fork 了此模板并编辑了 `scripts/bootstrap.sh`，请重新生成 base64：

```bash
base64 -w0 scripts/bootstrap.sh
```

将 `openclaw.xml` 中 `echo ` 和 ` | base64 -d` 之间的长字符串替换为新值。

## 致谢<a id="credits"></a>

- **OpenClaw 团队** —— Peter Steinberger ([@steipete](https://twitter.com/steipete)) 及贡献者
- **原始 CA 模板** —— [@jdhill777](https://github.com/jdhill777)
- **本 fork** —— [@thebtf](https://github.com/thebtf)
- **测试环境** —— Unraid 7.x

---

**有问题？** 提交 Issue 或加入 [OpenClaw Discord](https://discord.gg/clawd)。
