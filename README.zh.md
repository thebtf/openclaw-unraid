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
OpenClaw 2.0 会将浏览器配对为已签名设备；令牌本身不会批准浏览器。如果请求等待批准，请按照“浏览器设备配对等待批准”一节操作。

### 第三步：选择正确的模型（安装后）

如果你使用了非 Anthropic 提供商或自定义 LLM 端点：

1. 控制 UI → **Config** 标签页 → **Agents** 子标签 → **Raw JSON**
2. 对内置提供商，按上方表格设置 `agents.defaults.model.primary`。对自定义路由器，将 `agents.entries.main.model` 设置为 `custom/<your-model-id>`。
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

安装后，将主智能体模型设置为使用你的自定义提供商：

1. 控制 UI → **Config** → **Agents** → **Raw JSON**
2. 添加（或编辑）agents 块：
   ```json
   {
     "agents": {
       "entries": {
         "main": {
           "model": "custom/llama-3.1-70b"
         }
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
| OpenClaw Data | Path | 是 | `/mnt/user/appdata/openclaw/data` | 位于 `/home/node/.openclaw` 的 OpenClaw 主目录：配置、会话、插件、媒体和凭据。 |
| Workspace | Path | 是 | `/mnt/user/appdata/openclaw/workspace` | 位于 `/home/node/.openclaw/workspace` 的智能体工作区。这是 OpenClaw Data 内 `workspace/` 目录的子挂载。 |
| Projects Path | Path | 否 | `/mnt/user/appdata/openclaw/projects` | 额外的代码项目（高级用法） |
| Homebrew Path | Path | 否 | `/mnt/user/appdata/openclaw/homebrew` | 持久化 Homebrew 软件包 |
| Local Tools Path | Path | 否 | `/mnt/user/appdata/openclaw/local` | 持久化 `/home/node/.local` —— pip `--user` 安装、手动构建的 CLI 工具（`bin/`）和库文件（`lib/`）。容器重启后保留。 |
| Logs Path | Path | 否 | `/mnt/user/appdata/openclaw/logs` | 网关日志文件。镜像将 `logging.file=/tmp/openclaw/openclaw.log` 固定；默认在 100 MB 时轮转，并保留五个归档。 |
| **必填项** | | | | |
| PUID | Variable | 是 | `99` | 运行网关的主机 UID。Unraid 中 `99` = `nobody`。在 Unraid 控制台运行 `id $USER` 查看你的 UID。 |
| PGID | Variable | 是 | `100` | 主机 GID。Unraid 中 `100` = `users`。 |
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
| Log Max File Bytes | Variable | 否 | `104857600` | 每个日志文件轮转前的最大大小为 100 MB。OpenClaw 将归档数量固定为 5。 |
| Skip Ownership Init | Variable | 否 | `0` | 设为 `1` 可跳过容器启动时对挂载点所有权的一次性对齐。仅在外部管理所有权时使用。 |
| Custom LLM Reasoning | Variable | 否 | `1` | 指定自定义 LLM 模型是否支持 reasoning/thinking 块。现代 reasoning 模型默认使用 `1`；不支持 reasoning 的模型设为 `0`。 |
| Skip System Path Remap | Variable | 否 | `0` | 设为 `1` 可跳过启动时对 `/home/node` 和 `/app` 的递归 `chown`。仅在文件系统已经对齐且不会重新创建容器时使用。 |
| PATH | Variable | 否 | （自动设置） | 系统 PATH —— 包含 `/home/node/.local/bin`、`/home/node/.cargo/bin`、Homebrew 和 Bun。完整值见 `openclaw.xml` 的 `<Default>`。 |
| Web Search API Key | Variable | 否 | — | Brave Search API |

### 卷挂载

| 容器路径 | 主机路径 | 说明 |
|---------|---------|------|
| `/home/node/.openclaw` | `/mnt/user/appdata/openclaw/data` | OpenClaw 主目录：配置、会话、插件、媒体和凭据 |
| `/home/node/.openclaw/workspace` | `/mnt/user/appdata/openclaw/workspace` | 智能体工作区；OpenClaw Data 内的子挂载 |
| `/projects` | `/mnt/user/appdata/openclaw/projects` | 可选的代码项目 |
| `/home/linuxbrew/.linuxbrew` | `/mnt/user/appdata/openclaw/homebrew` | Homebrew 软件包 |
| `/home/node/.local` | `/mnt/user/appdata/openclaw/local` | pip `--user` 安装、手动构建的 CLI 和库文件 |
| `/tmp/openclaw` | `/mnt/user/appdata/openclaw/logs` | 网关日志文件：默认每个文件 100 MB、保留五个归档，总计约 600 MB |

### 日志

启动脚本将 `logging.file=/tmp/openclaw/openclaw.log` 固定到主机卷。OpenClaw 2026.4 会按网关实例命名默认路径（`/tmp/openclaw-0/`），而固定路径使用 `/tmp/openclaw` 挂载。

内置轮转：活动日志达到 `Log Max File Bytes`（默认 100 MB）时，OpenClaw 将其重命名为 `openclaw.1.log` 并创建新日志。保留 5 个带编号的归档。默认总磁盘占用约为 `6 × Log Max File Bytes` = ~600 MB。

实时追踪日志：
```bash
tail -f /mnt/user/appdata/openclaw/logs/openclaw-*.log
```

清除日志：
```bash
rm /mnt/user/appdata/openclaw/logs/openclaw*.log
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

主配置文件：`/mnt/user/appdata/openclaw/data/openclaw.json`

启动脚本在首次启动时生成最小配置：
```json
{
  "gateway": {
    "mode": "local",
    "bind": "lan",
    "controlUi": {
      "allowedOrigins": ["http://YOUR-UNRAID-IP:18789"]
    },
    "auth": { "mode": "token" }
  }
}
```
令牌认证仍然必填。OpenClaw 还要求对浏览器设备进行已签名配对：令牌不会批准浏览器。

如果设置了 `Custom LLM Base URL`，首次启动时还会创建 `models.providers.custom` 块。

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
docker pull ghcr.io/thebtf/openclaw-unraid:latest
docker restart OpenClaw
```
> **OpenClaw 2.0 重要提示：** 会话和转录记录已迁移到 SQLite。升级前，请创建并验证 OpenClaw Data 的备份。降级前，请使用当前 OpenClaw CLI 恢复已归档的旧版转录记录工件。请参阅 [OpenClaw 更新和降级指南](https://docs.openclaw.ai/install/updating)。

### 已持久化的现有配置

升级前，请创建并验证 OpenClaw Data 的备份。升级后的首次启动中，如果现有配置未通过验证，镜像会在模板管理的写入和首次启动初始化之前执行窄范围的备份优先迁移。它会创建带时间戳的 `openclaw.json.v2026.8.1-backup-*` 备份，验证迁移后的配置，然后在同一次启动中继续执行受管理的写入和初始化。如果迁移或验证失败，入口脚本会安全地失败关闭。

OpenClaw 2.0 仍要求已签名的浏览器设备配对。请按照[浏览器设备配对等待批准](#浏览器设备配对等待批准)一节批准等待中的浏览器请求。

如需针对性排查，请在容器日志中查找 `[bootstrap] existing config needs OpenClaw migration; applying narrow backup-first migration`。不要将完整的 `openclaw doctor --fix` 用作常规升级恢复。它是在保留备份后使用的手动排查工具；入口脚本绝不会自动运行它。

如果容器已停止且无法运行镜像迁移器，请使用此仓库中的手动备用方法。在 Unraid 模板中找到 **OpenClaw Data** 的主机路径。不要将配置值粘贴到命令中。先运行 `python3 scripts/migrate-openclaw-2-config.py <OpenClaw-Data-主机路径>/openclaw.json`；该命令默认执行演练。确认输出后，添加 `--apply` 以执行迁移。该脚本会在相邻位置创建带时间戳、与原始文件逐字节相同的备份，并且只打印受影响的路径。
更新会保留已填写的值和自定义环境变量，但会丢弃明确已弃用的模板变量。`OPENCLAW_DISABLE_DEVICE_AUTH` 不再生效。


**当模板本身有变更时**（新增设置、镜像行为或挂载布局变更），请在 Unraid 控制台中运行：

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/thebtf/openclaw-unraid/master/scripts/update-on-unraid.sh)"
```

该包装器会通过模板的唯一标识自动定位已安装的容器，更新上游 `openclaw.xml`，并将其合并到保存的 `my-<Name>.xml`。它会保留你填写的值，创建 `.bak`，并列出新增字段。

完成后，打开 Unraid Web UI → Docker → 你的容器 → **编辑容器**，填写显示的新字段并点击 **Apply**。

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

### 浏览器设备配对等待批准

OpenClaw 2.0 除令牌认证外还要求浏览器设备已签名配对。Dashboard 链接中的令牌不会批准浏览器。

1. 获取新的 Dashboard 链接，并在要使用的浏览器中打开它。
2. 在容器控制台中运行 `openclaw devices list`，找到等待处理的配对请求。
3. 如果需要批准，请对该请求运行 `openclaw devices approve <requestId>`。

### `No API key found for provider "anthropic"`

你填写了非 Anthropic 的密钥，但默认模型仍是 `anthropic/claude-sonnet-4-5`。请将 `agents.defaults.model.primary` 修改为对应提供商 —— 参见[使用非 Anthropic 提供商](#using-non-anthropic-providers-openai-gemini-groq-openrouter-xai-zai)。

### `Config invalid` / `models.providers.custom.api: Invalid option`

你在 **Custom LLM API Type** 中填入了模型名称（如 `gpt-5.5`）。该字段是**协议适配器** —— 有效值参见[自定义 LLM 路由器](#custom-llm-router-litellm-vllm-ollama-etc)章节。模型名称应填在 **Custom LLM Model ID** 字段。

修正模板字段，点击 **Apply**，重启容器。

### `models.providers.custom.models: Invalid input: expected array`

已声明自定义 LLM 端点，但 **Custom LLM Model ID** 为空。请至少填写一个模型 ID（如 `gpt-5.5`）。

### appdata 文件夹中的文件无法通过 SMB/NFS 访问

网关以 `PUID:PGID` 运行；默认值为 `99:100`（`nobody:users`）。镜像启动时会将挂载点所有权与这些标识一次性对齐，然后以这些标识启动网关。不存在后台所有权同步循环。

1. 在 Unraid 中运行 `id $USER` 查看用户的 UID 和 GID。
2. 在模板的 **PUID** 和 **PGID** 字段中填写这些值，点击 **Apply**，然后重启容器。
3. 如果由外部工具管理所有权，请设置 `OPENCLAW_SKIP_OWNERSHIP_INIT=1`，以仅跳过启动时的一次性对齐。

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
rm /mnt/user/appdata/openclaw/data/openclaw.json
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
rm /mnt/user/appdata/openclaw/data/openclaw.json
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
mkdir -p /mnt/user/appdata/openclaw/{data,workspace,homebrew,local,logs}

docker run -d \
  --name OpenClaw \
  --network bridge \
  --hostname OpenClaw \
  --restart unless-stopped \
  -p 18789:18789 \
  -v /mnt/user/appdata/openclaw/data:/home/node/.openclaw:rw \
  -v /mnt/user/appdata/openclaw/workspace:/home/node/.openclaw/workspace:rw \
  -v /mnt/user/appdata/openclaw/homebrew:/home/linuxbrew/.linuxbrew:rw \
  -v /mnt/user/appdata/openclaw/local:/home/node/.local:rw \
  -v /mnt/user/appdata/openclaw/logs:/tmp/openclaw:rw \
  -e PUID=99 \
  -e PGID=100 \
  -e OPENCLAW_GATEWAY_PORT=18789 \
  -e OPENCLAW_LOG_MAX_FILE_BYTES=104857600 \
  -e OPENCLAW_GATEWAY_TOKEN=YOUR_TOKEN \
  -e OPENCLAW_ALLOWED_ORIGINS=http://YOUR-UNRAID-IP:18789 \
  -e ANTHROPIC_API_KEY=sk-ant-YOUR_KEY \
  -e PATH=/home/node/.local/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/home/node/.bun/bin:/home/node/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  ghcr.io/thebtf/openclaw-unraid:latest

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

## 镜像如何启动

派生镜像包含版本化入口点，每次容器启动时都会运行。它会将持久挂载点与 `PUID:PGID` 对齐，应用受支持的网关和日志设置，并以该用户身份启动 OpenClaw。

首次启动时，如果填写了 Custom LLM 字段，入口点会创建 Custom LLM 提供商和主智能体。后续启动会保留你通过 Control UI 修改的 OpenClaw 配置。

入口点使用原生 OpenClaw 配置 CLI，因此 OpenClaw 会在网关启动前验证值。手动 Docker 命令使用镜像内置的用户和入口点行为。不要添加引导命令。

## 致谢<a id="credits"></a>

- **OpenClaw 团队** —— Peter Steinberger ([@steipete](https://twitter.com/steipete)) 及贡献者
- **原始 CA 模板** —— [@jdhill777](https://github.com/jdhill777)
- **本 fork** —— [@thebtf](https://github.com/thebtf)
- **测试环境** —— Unraid 7.x

---

**有问题？** 提交 Issue 或加入 [OpenClaw Discord](https://discord.gg/clawd)。
