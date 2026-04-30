# OpenClaw for Unraid

**Languages:** [English](./README.md) · [Русский](./README.ru.md) · [中文](./README.zh.md)

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
   - **LLM source** — one of: a built-in provider API key (Anthropic, OpenAI, etc.) **or** a Custom LLM endpoint — see [Custom LLM Router](#custom-llm-router-litellm-vllm-ollama-etc) for the full set of fields
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

> **Note:** `contextWindow` and `maxTokens` in the generated config come from the **Custom LLM Context Window** and **Custom LLM Max Tokens** template fields (defaults: `128000` / `32000`). Adjust those template fields to match your model — e.g., `gpt-4o`: 128000 / 16384; `claude-3-opus`: 200000 / 4096; `gpt-5.5`: 1050000 / 128000.

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
| Logs Path | Path | No | `/mnt/user/appdata/openclaw/logs` | Gateway log files. Bootstrap pins `logging.file=/tmp/openclaw/openclaw.log` to keep them on the host volume regardless of OpenClaw's instance namespacing (`/tmp/openclaw-0/` since 2026.4). |
| **Required** |
| PUID | Variable | Yes | `99` | Host user ID the gateway runs under. `99` = `nobody` on Unraid. Find yours: `id $USER` on Unraid console. |
| PGID | Variable | Yes | `100` | Host group ID. `100` = `users` on Unraid. |
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
| Log Max File Bytes | Variable | No | `104857600` | 100 MB per log file before rotation (matches OpenClaw upstream default). Archive count is hardcoded to 5 by openclaw. |
| Skip Ownership Init | Variable | No | `0` | Set `1` to skip the one-shot ownership alignment at container start. Bootstrap normally aligns mount ownership to PUID:PGID once, then exec's the gateway under those IDs (no loops). Disable only if you manage ownership externally. |
| Custom LLM Reasoning | Variable | No | `true` | Whether the custom LLM model(s) support reasoning/thinking blocks. Default `true` for modern models (gpt-5.5, o1, claude-opus-4.7). Set `false` for non-reasoning models. |
| PATH | Variable | No | (auto-set) | System PATH — includes `~/.local/bin`, `~/.cargo/bin`, Homebrew, Bun. See `openclaw.xml` `<Default>` for the full value. |
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

### Permissions (PUID/PGID)

The gateway runs under `PUID:PGID` (defaults `99:100` = `nobody:users` on Unraid). Files in your appdata mounts are owned by these IDs, so SMB/NFS clients see them with the right ownership automatically — no `chown` loops, no permission-fix daemons. The bootstrap aligns mount ownership to `PUID:PGID` once at container start (only when there's a mismatch), then `setpriv`'s the gateway down to those IDs.

To use a different user, set PUID/PGID to your host user's ID:
```bash
id $USER
# uid=1026(myname) gid=100(users) groups=...
```
Set `PUID=1026` and `PGID=100` in the template, Apply, and restart.

If you upgraded from v1.1.0 or earlier (which ran the gateway as root and had a `chown -R --reference` background loop), the legacy loop is removed. Existing files keep their current ownership; the bootstrap will detect mismatch and align them once on first start.

### Logs

The bootstrap pins `logging.file=/tmp/openclaw/openclaw.log` so logs land on the host volume reliably. (OpenClaw 2026.4 namespaces by gateway instance — default path is `/tmp/openclaw-0/`, not `/tmp/openclaw/`. We pin it back to our mount.)

Built-in rotation: when the active log hits `Log Max File Bytes` (default 100 MB, matches upstream), openclaw renames it to `openclaw.1.log` etc. 5 numbered archives are kept (count is hardcoded in openclaw). Total disk cap ≈ `6 * Log Max File Bytes` = ~600 MB at defaults.

To tail live:
```bash
tail -f /mnt/user/appdata/openclaw/logs/openclaw.log
```

For verbose debugging:
```bash
docker exec -e OPENCLAW_LOG_LEVEL=debug -e OPENCLAW_GATEWAY_STARTUP_TRACE=1 OpenClaw \
  sh -c 'cd /app && node dist/index.js gateway --bind lan 2>&1 | head -200'
```

Diagnostic CLI inside the container:
```bash
docker exec OpenClaw sh -c 'cd /app && node dist/index.js doctor'           # health check
docker exec OpenClaw sh -c 'cd /app && node dist/index.js doctor --fix'     # auto-repair
docker exec OpenClaw sh -c 'cd /app && node dist/index.js config validate'  # schema check
docker exec OpenClaw sh -c 'cd /app && node dist/index.js gateway stability --bundle latest --json'  # last crash snapshot
```

To purge:
```bash
rm /mnt/user/appdata/openclaw/logs/openclaw*.log
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

**When the template itself has changed** (new env vars, updated PostArgs, restructured ExtraParams):

```bash
python3 scripts/merge-template.py \
    --stored /boot/config/plugins/dockerMan/templates-user/my-OpenClaw.xml \
    --upstream /boot/config/plugins/dockerMan/templates-user/openclaw.xml \
    --output /boot/config/plugins/dockerMan/templates-user/my-OpenClaw.xml
```

The script overlays user-filled values from the stored template onto the upstream xml, writes a `.bak` of the original, and prints any new fields you should review in the Unraid Edit Container UI. Run this before clicking **Edit Container** so your tokens, API keys, and paths survive the upgrade while you pick up new template-level fields.

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

Set `PUID`/`PGID` in the template to match your host user. The bootstrap then aligns mount ownership to those IDs once at start and exec's the gateway under them. New files are owned `PUID:PGID` from the start — no chown loops, no SMB/NFS visibility issues.

Find your UID/GID:
```bash
id $USER
# uid=1026(myname) gid=100(users) groups=100(users),...
```

Set `PUID=1026`, `PGID=100` in the template, Apply, restart container.

#### Migration from v1.1.0 or earlier

Older versions ran the gateway as `root` and used a background `chown -R --reference` loop to nudge file ownership every 5 seconds. On installations with large workspaces (>100k files) the recursive chown blocked the Node event loop for tens of seconds, causing session-write-lock stalls and Telegram polling timeouts.

v1.1.1+ removes the loop entirely. On first start under v1.1.1+:
- Bootstrap detects mount-point ownership mismatch.
- Runs ONE recursive chown to align with `PUID:PGID`.
- Exec's the gateway under those IDs.
- All future files inherit the right ownership naturally.

#### Verify

```bash
docker exec OpenClaw id
# uid=1026(node) gid=100(users) groups=100(users)
ls -la /mnt/user/appdata/openclaw/config/
```

Files should be `1026:100`. **`openclaw.json` stays mode `-rw-------`** — openclaw writes it 0600 by design (gateway token + provider keys). Owner (you) reads it fine via SMB; other users by design can't.

#### Override

- `OPENCLAW_SKIP_OWNERSHIP_INIT=1` — skip the one-shot ownership alignment. Use if you manage ownership externally (e.g. Unraid User Scripts).

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

### Restarting the gateway inside the container

`openclaw gateway restart` (the upstream CLI) does **not** work inside this image. It assumes a host install with a systemd-user unit (`systemctl --user`); inside the container there is no systemd, so the CLI errors out with:

```
systemctl not available; systemd user services are required on Linux.
```

This is an upstream limitation tracked under [openclaw/openclaw#72224](https://github.com/openclaw/openclaw/issues/72224) ("fix gateway restart outside systemd"). Until that lands in a release, use one of the alternatives below.

#### Three ways to restart, in order of how disruptive they are

**1. Hot in-process restart via SIGUSR1** (fastest, no container downtime, picks up `openclaw.json` changes):

```bash
docker exec OpenClaw sh -c 'kill -USR1 $(pidof openclaw-gateway)'
```

This is the same path the gateway uses internally for hot-reload after a config save. Channels, plugins and skills re-initialize; existing requests in flight may drop. Documented as a first-class restart trigger in [`docs/cli/gateway.md`](https://github.com/openclaw/openclaw/blob/main/docs/cli/gateway.md) (`commands.restart: true` is the default, so authorization is on).

**2. Container restart** (guaranteed clean state, ~10-15s downtime):

- Unraid Web UI: **Docker** → click the OpenClaw icon → **Restart**, or
- ```bash
  docker restart OpenClaw
  ```

Use this when the gateway is wedged, after upgrading the image, or if SIGUSR1 didn't pick up your change.

**3. Full bootstrap re-run** (only if the config file itself is broken):

```bash
rm /mnt/user/appdata/openclaw/config/openclaw.json
docker restart OpenClaw
```

This drops UI-side edits — the bootstrap re-seeds everything from template env vars on next start. Use this as a last resort.

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
