# OpenClaw for Unraid

[![Unraid](https://img.shields.io/badge/Unraid-CA%20Template-orange)](https://unraid.net/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Community Applications template for [OpenClaw](https://github.com/openclaw/openclaw) — a self-hosted AI assistant gateway that runs locally on your Unraid server.

![OpenClaw Dashboard](screenshot.png)

## Table of Contents

- [What is OpenClaw?](#what-is-openclaw)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Custom LLM Router](#custom-llm-router-litellm-vllm-ollama-etc)
- [Configuration](#configuration)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [Install Before CA Approval](#install-before-community-apps-approval)
- [Resources](#resources)
- [License](#license)
- [Credits](#credits)

---

## What is OpenClaw?

OpenClaw is a personal AI assistant you run on your own server. It answers you on the messaging channels you already use and keeps your data on your machine.

### Multi-Channel Messaging
- WhatsApp, Telegram, Discord, Slack, Google Chat, Signal, iMessage, Microsoft Teams, Matrix, Mattermost, BlueBubbles — and more via plugins.

### Powerful Features
- Multi-Agent Routing — isolate channels/users with separate workspaces
- File Management — read, write, organize files on your server
- Shell Commands — execute scripts, manage Docker, automate anything
- Browser Control — research, fetch data, interact with web pages
- Cron Jobs — scheduled tasks, reminders, automated workflows
- Skills System — extend capabilities with bundled or custom skills
- Voice Wake + Talk Mode — always-on speech with TTS
- Live Canvas — agent-driven visual workspace
- Mobile Nodes — iOS and Android companion apps

### Your Data, Your Server
Workspace and configuration stay 100% on your Unraid server. Conversations are processed through your chosen LLM provider's API. For fully local operation, point the **Custom LLM Base URL** at [Ollama](https://ollama.ai), [LiteLLM](https://github.com/BerriAI/litellm), or any OpenAI-compatible router running on your LAN.

## Requirements

- Unraid 6.x or 7.x with Docker enabled
- A Gateway Token (any secret string — generate with `openssl rand -hex 24`)
- Allowed Origins URL (e.g. `http://YOUR-UNRAID-IP:18789`) — see [why this is required](#allowed-origins-required-since-openclaw-20262)
- One LLM source — either:
  - An API key from a built-in provider (Anthropic, OpenAI, OpenRouter, Gemini, Groq, xAI, Z.AI), **or**
  - A custom LLM endpoint URL (LiteLLM, vLLM, Ollama, your own router) — see [Custom LLM Router](#custom-llm-router-litellm-vllm-ollama-etc)

### Getting an Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Add a payment method (Settings → Billing)
3. Open **API Keys**, create a new key (starts with `sk-ant-`)

> **Note:** API access requires console credits — it is separate from a Claude.ai Pro/Max chat subscription. Do **not** use `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` to drive OpenClaw — Anthropic prohibits using Claude Code subscription tokens with third-party tooling and your account can be suspended.

### Using Non-Anthropic Providers (OpenAI, Gemini, Groq, OpenRouter, xAI, Z.AI)

OpenClaw defaults to Anthropic's Claude. **If you use a different provider, change the default model after install:**

1. Install OpenClaw with your API key (e.g. `GEMINI_API_KEY`)
2. Open the Control UI → **Config** tab → **Agents** → **Raw JSON**
3. Set `agents.defaults.model.primary` to match your provider:

| Provider | Model Example |
|----------|---------------|
| Anthropic | `anthropic/claude-sonnet-4-5` (default) |
| Google Gemini | `google/gemini-2.0-flash` |
| OpenAI | `openai/gpt-4o` |
| Groq | `groq/llama-3.1-70b-versatile` |
| OpenRouter | `openrouter/anthropic/claude-3-sonnet` |

4. Save and restart the container.

> **Why?** OpenClaw doesn't auto-detect the provider from the API key. If you set a Gemini key but leave the default model, you get `No API key found for provider "anthropic"` errors.

## Quick Start

### Step 1: Install from Community Apps

1. Search for **OpenClaw** in Community Applications
2. Click **Install**
3. Fill in **all required fields**:
   - **Gateway Token** — `openssl rand -hex 24` or any secret value
   - **Allowed Origins** — `http://YOUR-UNRAID-IP:18789` (use your Unraid IP and the Control UI Port). Multiple values comma-separated, no spaces. **Required — gateway will refuse to start without this.**
   - **LLM source** — one of: a built-in provider API key (Anthropic, OpenAI, etc.) **or** the Custom LLM quartet (`Custom LLM Base URL`, `Custom LLM API Key`, `Custom LLM API Type`, `Custom LLM Model ID`)
4. Click **Apply**

### Step 2: Open the Control UI

```
http://YOUR-UNRAID-IP:18789/?token=YOUR_GATEWAY_TOKEN
```

The `?token=` parameter is mandatory. Example: `http://192.168.1.41:18789/?token=mySecretToken123`

### Step 3: Pick the right model (post-install)

If you used a non-Anthropic provider or the Custom LLM endpoint:

1. Control UI → **Config** tab → **Agents** sub-tab → **Raw JSON**
2. Set `agents.defaults.model.primary` (see table above for built-in providers; for the custom router use `custom/<your-model-id>`)
3. **Save** → restart the container

### Step 4: (Optional) Connect a messaging channel

Control UI → **Config** → **Channels** — fill in Telegram/Discord/Slack/etc. Or set the bot tokens in the template (Discord, Telegram) and configure pairing in the **Agents** tab on first message.

## Custom LLM Router (LiteLLM, vLLM, Ollama, etc.)

If you run your own LLM router or local model server, set the four **Custom LLM** fields in the template instead of (or alongside) the built-in provider keys.

| Field | Purpose | Example |
|-------|---------|---------|
| `Custom LLM Base URL` | Endpoint root | `http://192.168.1.50:11434/v1` (Ollama), `http://litellm:4000/v1`, `https://my-router.example.com/v1` |
| `Custom LLM API Key` | Auth token | `ollama` (for local Ollama), your router token otherwise |
| `Custom LLM API Type` | Protocol adapter (NOT the model name) | One of: `openai-completions` (default — LiteLLM/vLLM/Ollama/OpenRouter), `openai-responses`, `openai-codex-responses`, `anthropic-messages`, `google-generative-ai`, `github-copilot`, `bedrock-converse-stream`, `ollama`, `azure-openai-responses` |
| `Custom LLM Model ID` | Model id(s) exposed by the endpoint | `gpt-5.5`, `llama-3.1-70b`, or multiple: `gpt-5.5,claude-3-opus` |

> **Common mistake:** `Custom LLM API Type` is the **protocol adapter**, not the model name. Putting a model name there fails openclaw's schema validation and the gateway refuses to start. Model name goes in `Custom LLM Model ID`.

When `Custom LLM Base URL` is set, the bootstrap writes a `models.providers.custom` block into `openclaw.json` via the native `openclaw config set` CLI:

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

The `${CUSTOM_LLM_API_KEY}` reference is resolved at gateway start, so the key is never written in plaintext to the config file.

### Pointing the agent at the custom provider

After install, set the default model to use your custom provider:

1. Control UI → **Config** → **Agents** → **Raw JSON**
2. Add (or edit) the agents block:
   ```json
   {
     "agents": {
       "defaults": {
         "model": { "primary": "custom/llama-3.1-70b" }
       }
     }
   }
   ```
   Replace `llama-3.1-70b` with whatever model id your router exposes.
3. Save → restart the container

### Allowed Origins (required since OpenClaw 2026.2)

Starting with OpenClaw `2026.2.x` the gateway refuses to start on non-loopback hosts unless `gateway.controlUi.allowedOrigins` is explicitly set. The template enforces this through the `OPENCLAW_ALLOWED_ORIGINS` variable.

- **Single value:** `http://192.168.1.41:18789`
- **Multiple values (comma-separated):** `http://192.168.1.41:18789,http://openclaw.local:18789`
- **Reverse-proxy users:** add the proxied origin too — e.g. `http://192.168.1.41:18789,https://openclaw.example.com`

The list must contain **full origins** (scheme + host + port). No wildcards, no trailing slashes.

## Configuration

### Template Settings Reference

| Setting | Type | Required | Default | Description |
|---------|------|----------|---------|-------------|
| **Ports** |
| Control UI Port | Port | Yes | `18789` | Web UI and Gateway API port |
| **Paths** |
| Config Path | Path | Yes | `/mnt/user/appdata/openclaw/config` | Configuration, sessions, credentials |
| Workspace Path | Path | Yes | `/mnt/user/appdata/openclaw/workspace` | Agent files, memory, projects |
| Projects Path | Path | No | `/mnt/user/appdata/openclaw/projects` | Additional coding projects (advanced) |
| Homebrew Path | Path | No | `/mnt/user/appdata/openclaw/homebrew` | Persistent Homebrew packages |
| Local Tools Path | Path | No | `/mnt/user/appdata/openclaw/local` | Persistent `~/.local` — pip `--user` installs, manually-built CLIs in `bin/`, libs in `lib/`. Survives restarts. |
| Logs Path | Path | No | `/mnt/user/appdata/openclaw/logs` | Gateway log files (mounted to `/tmp/openclaw` — openclaw runtime always writes there, see [issue #61295](https://github.com/openclaw/openclaw/issues/61295)) |
| **Required** |
| Gateway Token | Variable | Yes | — | Secret for API/UI access |
| Allowed Origins | Variable | Yes | — | Comma-separated browser origins. See [section above](#allowed-origins-required-since-openclaw-20262) |
| **Custom LLM (optional alternative to built-in keys)** |
| Custom LLM Base URL | Variable | No | — | Endpoint root URL |
| Custom LLM API Key | Variable | No | — | Token for the custom endpoint |
| Custom LLM API Type | Variable | No | `openai-completions` | Protocol adapter — see [list below](#custom-llm-router-litellm-vllm-ollama-etc) |
| Custom LLM Model ID | Variable | No | — | Model id(s) exposed by the endpoint. Required if Custom LLM Base URL is set. Comma-separated for multiple. |
| Custom LLM Context Window | Variable | No | `128000` | Total context window in tokens. Match your model's real value (gpt-4o=128k, claude-3-opus=200k, gpt-5=400k). |
| Custom LLM Max Tokens | Variable | No | `32000` | Max output tokens per response. Match your model (gpt-4o=16384, claude-3-opus=4096, gpt-5=32000). |
| **Built-in LLM Providers** |
| Anthropic API Key | Variable | No | — | Claude models |
| OpenAI API Key | Variable | No | — | GPT models |
| OpenRouter API Key | Variable | No | — | 100+ models via single API |
| Gemini API Key | Variable | No | — | Google Gemini |
| Groq API Key | Variable | No | — | Fast Llama/Mixtral |
| xAI API Key | Variable | No | — | Grok |
| Z.AI API Key | Variable | No | — | Zhipu GLM |
| **Subscription Auth** |
| GitHub Copilot Token | Variable | No | — | Advanced — see OpenClaw docs |
| **Channels (configure after install)** |
| Discord Bot Token | Variable | No | — | Discord integration |
| Telegram Bot Token | Variable | No | — | Telegram bot from [@BotFather](https://t.me/BotFather) |
| **Advanced** |
| Gateway Port | Variable | No | `18789` | Override if 18789 is taken |
| Disable Device Auth | Variable | No | `true` | LAN-friendly default; set `false` if you front the UI with HTTPS |
| Log Max File Bytes | Variable | No | `26214400` | 25 MB per log file before rotation. Archive count is hardcoded to 5 by openclaw. |
| Skip Permission Fix | Variable | No | `0` | Set `1` to disable the generic permission fix (umask 0002 + setgid on dirs). Disable only if you manage permissions externally. |
| PATH | Variable | No | (auto-set) | System PATH including Homebrew |
| Web Search API Key | Variable | No | — | Brave Search API |

### Volume Mounts

| Container Path | Host Path | Description |
|----------------|-----------|-------------|
| `/root/.openclaw` | `/mnt/user/appdata/openclaw/config` | Config file, sessions, credentials |
| `/home/node/clawd` | `/mnt/user/appdata/openclaw/workspace` | Agent workspace |
| `/projects` | `/mnt/user/appdata/openclaw/projects` | Optional coding projects |
| `/home/linuxbrew/.linuxbrew` | `/mnt/user/appdata/openclaw/homebrew` | Homebrew packages |
| `/root/.local` | `/mnt/user/appdata/openclaw/local` | `~/.local` — pip `--user`, manually-built CLIs (e.g. `~/.local/bin/obscura`), libs |
| `/tmp/openclaw` | `/mnt/user/appdata/openclaw/logs` | Gateway log files (rotated by openclaw, default cap ~150 MB) |

### Logs

OpenClaw runtime always writes logs to `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (the `logging.file` config option is currently ignored — see [openclaw issue #61295](https://github.com/openclaw/openclaw/issues/61295)). The template mounts `/tmp/openclaw` to `/mnt/user/appdata/openclaw/logs` on the host so they stay off the container overlay fs.

Built-in rotation: when the active log hits `Log Max File Bytes` (default 25 MB), openclaw renames it to `openclaw-YYYY-MM-DD.1.log` and starts fresh. 5 numbered archives are kept (count is hardcoded in openclaw). Total disk cap ≈ `6 * Log Max File Bytes` = ~150 MB at defaults.

To tail live:
```bash
tail -f /mnt/user/appdata/openclaw/logs/openclaw-*.log
```

To purge:
```bash
rm /mnt/user/appdata/openclaw/logs/openclaw-*.log
docker restart OpenClaw
```

### Homebrew & Skills Support

Some skills require `go`, `npm`, or other brew-installable tools. Homebrew is **optional**.

To install: open the container console and run:
```bash
NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Ignore the "Next steps" output — the template already configures `PATH`. Homebrew and packages persist in the `Homebrew Path` volume.

**Known limitation:** Skills that require Go (`blogwatcher`, `blucli`) may timeout on first install while Go downloads. Click **Install** again and it will succeed.

### Config File Reference

Main config: `/mnt/user/appdata/openclaw/config/openclaw.json`

Bootstrap creates a minimal config on first start:
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

If you set `Custom LLM Base URL`, the `models.providers.custom` block is added too.

After first start, OpenClaw owns this file — edit via Control UI **Config** → **Raw JSON** to keep changes.

> **Heads-up:** OpenClaw rewrites the config on its own writes (e.g. via the Control UI Save button), and serializes `${VAR}` references as plaintext. If you edit the file by hand and use env-var substitution, the next save through the UI may inline the resolved values.

Full schema: [docs.openclaw.ai/gateway/configuration-reference](https://docs.openclaw.ai/gateway/configuration-reference)

### Connecting Messaging Channels

After installation, configure channels via Control UI **Config** page or edit `openclaw.json` directly:

```json
{
  "channels": {
    "discord": { "enabled": true, "token": "${DISCORD_BOT_TOKEN}" },
    "telegram": { "enabled": true, "botToken": "${TELEGRAM_BOT_TOKEN}" }
  }
}
```

Full channel guides: [OpenClaw Docs — Channels](https://docs.openclaw.ai/channels)

## Updating

**Via Unraid Docker UI:**
1. Docker tab → Click OpenClaw icon → Check for Updates → Apply

**Via command line:**
```bash
docker pull ghcr.io/openclaw/openclaw:latest
docker restart OpenClaw
```

## Troubleshooting

### `origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)`

Your browser's origin is not in the `allowedOrigins` list.

1. Confirm your **Allowed Origins** template field matches **exactly** the URL you opened — same scheme (`http`/`https`), host (IP or hostname), and port. `http://192.168.1.41:18789` ≠ `http://homelab:18789`.
2. If you access from multiple hostnames (LAN IP + mDNS + reverse proxy), add **all** of them comma-separated:
   ```
   http://192.168.1.41:18789,http://openclaw.local:18789,https://openclaw.example.com
   ```
3. Edit the template variable, click **Apply**, then **restart** the container. The bootstrap is idempotent and will merge the new origins on the next start without touching your other config edits.

### `non-loopback Control UI requires gateway.controlUi.allowedOrigins`

The gateway refuses to start because no allowed origins were set. Set the **Allowed Origins** template field as described above, then restart.

### `control ui requires device identity (use HTTPS or localhost secure context)`

Browsers require a secure context (HTTPS or `http://localhost`) to use the Web Crypto API that openclaw uses for device-identity signing. Plain HTTP on a LAN IP/hostname does not qualify.

Two fixes:
- **Use HTTPS** — front the container with a reverse proxy (Traefik, Caddy, NPM) and open `https://your-domain/?token=...`. Then set `OPENCLAW_DISABLE_DEVICE_AUTH=false` in the template for full device-identity protection.
- **Disable device auth (default for this template)** — `OPENCLAW_DISABLE_DEVICE_AUTH=true` (default). Token auth still required. Acceptable for LAN-only / homelab use; not recommended over the open internet.

The template default is `true` because most Unraid users access the Control UI over plain HTTP on the LAN. If your setup already gives you HTTPS, switch to `false`.

### `disconnected (1008): control ui requires HTTPS or localhost`

Make sure you appended the token to the URL:
```
http://YOUR-IP:18789/?token=YOUR_TOKEN
```

If the error persists, verify the config file:
```bash
cat /mnt/user/appdata/openclaw/config/openclaw.json
```

### `No API key found for provider "anthropic"`

You provided a non-Anthropic key but the default model is still `anthropic/claude-sonnet-4-5`. Change `agents.defaults.model.primary` to match your provider — see [Using Non-Anthropic Providers](#using-non-anthropic-providers-openai-gemini-groq-openrouter-xai-zai).

### `Config invalid` / `models.providers.custom.api: Invalid option`

You put a model name (e.g. `gpt-5.5`) in **Custom LLM API Type**. That field is the **protocol adapter** — see the [Custom LLM Router](#custom-llm-router-litellm-vllm-ollama-etc) section for valid values. The model name belongs in **Custom LLM Model ID**.

Fix the template fields, click **Apply**, restart the container.

### `models.providers.custom.models: Invalid input: expected array`

Custom LLM endpoint declared but **Custom LLM Model ID** is empty. Set at least one model id (e.g. `gpt-5.5`).

### Files in the appdata folder are invisible over SMB / NFS

The container runs as root. Without intervention every new file would land as `root:root 0600` and your SMB share user wouldn't see anything.

The bootstrap handles this in two stages on every container start:

1. **One-shot fix** — aligns ownership with the mount root and sets `umask 0002` + `chmod g+s` on directories so new files inherit the group.
2. **Background owner-sync loop** — every `OPENCLAW_PERM_FIX_INTERVAL` seconds (default 5) re-runs `chown --reference` on the mount roots. Catches files openclaw rotates/writes at runtime (e.g. `openclaw.json.bak` after every UI Save).

#### One-time host-side setup

The bootstrap takes its UID/GID cue from the mount-point itself, so set ownership on the host **once** to whatever your SMB/NFS user expects. Find your UID/GID with `id $USER`, then:

```bash
# Replace YOUR_UID:YOUR_GID with your actual values (e.g. 99:100 = nobody:users)
chown -R YOUR_UID:YOUR_GID /mnt/user/appdata/openclaw
chmod -R g+rwX,o+rX /mnt/user/appdata/openclaw
find /mnt/user/appdata/openclaw -type d -exec chmod g+s {} +
```

This is identical to what the bootstrap does at start. Running it manually fixes existing files immediately without waiting for a restart. Restart the container afterwards (or wait `OPENCLAW_PERM_FIX_INTERVAL` seconds) so the runtime loop picks up the new ownership reference.

#### Verify

```bash
ls -la /mnt/user/appdata/openclaw/config/
```

Directories should be `drwxrwsr-x` with your UID/GID (the `s` in group-execute is the setgid bit). Most files `-rw-rw-r--`. Note: **`openclaw.json` stays `-rw-------`** — openclaw deliberately writes it with mode 0600 because it contains the gateway token and provider api keys. Owner reads fine via SMB; other users by design can't.

#### Tuning

- `OPENCLAW_PERM_FIX_INTERVAL` — interval (seconds) for the runtime owner-sync loop. Default 5. Increase to 30+ on slow disks.
- `OPENCLAW_SKIP_PERM_FIX=1` — disable both the one-shot fix and the background loop entirely. Use only if you manage permissions externally.

### Container goes to STOP after the gateway restarts itself

OpenClaw exits the gateway process when you save certain config changes via the Control UI (e.g. switching the default model). Without an explicit Docker restart policy the container stays stopped instead of cycling.

This template sets `--restart=unless-stopped` in `ExtraParams` so docker auto-restarts after any non-manual exit. If you removed that flag or your existing container was created before it was added:

```bash
docker update --restart=unless-stopped OpenClaw
```

Or via Unraid Web UI: **Edit Container** → set **Restart Policy** to `Unless Stopped` → Apply.

If the container still goes to STOP after a save, check the bootstrap exit message:

```bash
docker logs OpenClaw 2>&1 | grep "gateway exited"
```

`rc=0` means a clean exit (config reload) — restart policy should pick it up. `rc=1` or higher means an actual crash; share the surrounding log lines.

### Container won't start / "Missing config" error

Check logs first:
```bash
docker logs OpenClaw 2>&1 | tail -50
```

The bootstrap prints `[bootstrap]` lines for every action. Common fatals:
- `FATAL: OPENCLAW_ALLOWED_ORIGINS is required` — fill in the **Allowed Origins** template field.
- `FATAL: CUSTOM_LLM_API_TYPE='...' is invalid` — see allowed adapter values above.
- `FATAL: CUSTOM_LLM_MODEL_ID is required` — set at least one model id.
- `FATAL: openclaw rejected the config update` — schema validation failed; the offending batch JSON is printed below the error.

To force a fully fresh config (loses any UI edits):
```bash
rm /mnt/user/appdata/openclaw/config/openclaw.json
docker restart OpenClaw
```

## Install Before Community Apps Approval

Not in CA yet? Install via terminal:

**Step 1:** SSH into your Unraid server and run:
```bash
curl -o /boot/config/plugins/dockerMan/templates-user/openclaw.xml \
  https://raw.githubusercontent.com/thebtf/openclaw-unraid/master/openclaw.xml
```

**Step 2:** Refresh the Unraid Docker page

**Step 3:** **Docker** → **Add Container** → select **OpenClaw** from the Template dropdown

**Step 4:** Fill in the required fields (Gateway Token, Allowed Origins, one LLM source) and click **Apply**.

<details>
<summary><strong>Advanced: Manual Docker Run</strong></summary>

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

(Copy the full `PostArgs` value from `openclaw.xml` for the final argument.)

</details>

## Memory backends (QMD, Graphiti, FalkorDB, ...)

Default builtin memory works fine for casual use. For better recall, knowledge graphs, or shared facts across multiple agents, see [`docs/MEMORY-SETUP.md`](docs/MEMORY-SETUP.md) — full setup guide for QMD (one-line upgrade), Graphiti + FalkorDB (graph memory), Cognee, and Mem0.

## Resources

- **Unraid Support Thread:** https://forums.unraid.net/topic/196865-support-openclaw-ai-personal-assistant/
- **OpenClaw Docs:** https://docs.openclaw.ai
- **OpenClaw GitHub:** https://github.com/openclaw/openclaw
- **OpenClaw Discord:** https://discord.gg/clawd
- **Template Repo:** https://github.com/thebtf/openclaw-unraid
- **Memory Setup Guide:** [`docs/MEMORY-SETUP.md`](docs/MEMORY-SETUP.md)

## License

[MIT](LICENSE). OpenClaw itself is MIT — see the [OpenClaw repository](https://github.com/openclaw/openclaw).

## How the bootstrap works

The bootstrap is **idempotent** — it re-runs on every container start and only updates the fields it owns (`gateway.controlUi.allowedOrigins` and `models.providers.custom`). Anything you edit through the Control UI (channels, agents, cron, tools) is preserved across restarts.

It uses the native `openclaw config set --batch-json` CLI for the merge, so schema validation is performed by openclaw itself: invalid `CUSTOM_LLM_API_TYPE`, missing `CUSTOM_LLM_MODEL_ID`, malformed origins — all caught with a clear error before the gateway starts.

### Why base64 in PostArgs?

The Unraid template runner strips `<` and `>` characters from `PostArgs` as a defensive measure. This breaks any inline shell script that uses comparisons (`i<=NF`), redirects (`> file`), or stderr (`>&2`). Base64 alphabet has neither character, so the script survives unmodified.

The actual bootstrap lives at [`scripts/bootstrap.sh`](scripts/bootstrap.sh). On container start the entrypoint runs `/bin/sh -c "echo BASE64 | base64 -d | /bin/sh"`, which decodes and executes it.

### Modifying the bootstrap

If you fork this template and edit `scripts/bootstrap.sh`, regenerate the base64:

```bash
base64 -w0 scripts/bootstrap.sh
```

Replace the long string between `echo ` and ` | base64 -d` in `openclaw.xml` with the new value.

## Credits

- **OpenClaw Team** — Peter Steinberger ([@steipete](https://twitter.com/steipete)) and contributors
- **Original CA template** — [@jdhill777](https://github.com/jdhill777)
- **This fork** — [@thebtf](https://github.com/thebtf)
- **Tested on** — Unraid 7.x

---

**Questions?** Open an issue or join the [OpenClaw Discord](https://discord.gg/clawd).
