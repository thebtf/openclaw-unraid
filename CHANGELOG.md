# Changelog

All notable changes to this Unraid Community Applications template are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.3] — 2026-04-30

Hotfix for v1.1.2 — gateway under PUID still couldn't find config.

### Fixed

- **Bootstrap now also sets node user's HOME to `/root` in `/etc/passwd` (`usermod -d /root node`) and `chmod 0755 /root`.** Reason: our `Config Path` mount target is `/root/.openclaw`, but Node.js `os.userInfo().homedir` reads from `/etc/passwd` and ignores `process.env.HOME`. After `usermod -u $PUID -o node`, the remapped node user still has `homedir=/home/node` in passwd. OpenClaw under that user resolves `~/.openclaw` to `/home/node/.openclaw`, finds it empty, and exits with `Missing config. Run openclaw setup or set gateway.mode=local`. Container then restart-loops. Fix updates both passwd entry and `/root` traverse permissions so `os.userInfo()` and `process.env.HOME` agree, and node:PUID can read/write `/root/.openclaw`.

## [1.1.2] — 2026-04-30

Hotfix for v1.1.1 — gateway crash-loop after `usermod` UID remap.

### Fixed

- **Bootstrap re-aligns image-owned filesystem entries after `usermod -u $PUID -o node` and `groupmod -g $PGID -o node`.** When the in-image `node` user is remapped from UID 1000 to a different UID (e.g. 1026), files in `/app`, `/app/node_modules`, and `/home/node` that the image build wrote as `node:node` (1000:1000) become orphaned — owned by literal UID 1000 with no matching user. The remapped node user (1026) can no longer read/write them, so the gateway crashes during runtime-deps install or auth phase, and Docker restart-loops the container.

  v1.1.2 fix: after `usermod`/`groupmod`, the bootstrap walks `/home/node` and `/app` with `find -uid <old>` / `find -gid <old>` and `chown -h` / `chgrp -h` to the new IDs. Same pattern linuxserver.io images use in s6-overlay init scripts. Runs ONLY when remap actually happened (UID_CHANGED=1 / GID_CHANGED=1) — subsequent starts are zero-cost.

### Documentation

- README — added `### Adding custom env vars / secrets` section explaining the OpenClaw `${VAR}` substitution priority (`process.env` → `env.vars` fallback → `env.shellEnv` for bare-metal). Tells users to put new secrets in Unraid template Variable fields, not the openclaw.json `env.vars` block. Lists all places `${VAR}` works (provider apiKey, channel tokens, MCP headers, plugin configs).

## [1.1.1] — 2026-04-30

Theme: replace the `chown -R --reference` background loop with PUID/PGID + `setpriv`. Pin `agents.list` and `logging.file` so plugin auto-enable and instance namespacing don't silently override our config.

### BREAKING (operational, not config)

- `OPENCLAW_PERM_FIX_INTERVAL` env var is removed (no more runtime owner-sync loop).
- `OPENCLAW_SKIP_PERM_FIX` env var is renamed to `OPENCLAW_SKIP_OWNERSHIP_INIT` (semantic shift: "skip the one-shot init", not "skip the loop").
- `Log Max File Bytes` default raised from `26214400` (25 MB) to `104857600` (100 MB) to match OpenClaw upstream default.

If you set the old env vars manually in your Unraid template, update them. The legacy field names are gone; the template provides the new ones via the standard upgrade path (Apply → re-add).

### Added

- `PUID` and `PGID` template fields (`Display="always"`, `Required="true"`, defaults `99/100` = `nobody:users` on Unraid). The bootstrap re-maps the in-image `node` user to `PUID:PGID` via `usermod -u -o` / `groupmod -g -o`, aligns mount-point ownership once if needed, then `setpriv --reuid --regid --init-groups` exec's the gateway under those IDs.
- `Custom LLM Reasoning` template field (`Display="advanced"`, default `true`). Adds `reasoning: true` to `models.providers.custom.models[*].reasoning` so OpenClaw surfaces reasoning/thinking blocks for modern models (gpt-5.5, o1, claude-opus-4.7).
- Bootstrap pins `agents.list = [{"id":"main","model":"custom/<first-model-id>"}]` whenever `Custom LLM Base URL` is set, so the gateway primary stays on `custom/<id>` and isn't silently swapped to `openai/<id>` by plugin auto-enable (e.g. when `openai-image` plugin auto-creates `models.providers.openai`).
- Bootstrap pins `logging.file = "/tmp/openclaw/openclaw.log"` so logs land on the host volume regardless of OpenClaw 2026.4's instance namespacing (`/tmp/openclaw-0/` default since 2026.4).
- Diagnostic CLI examples in README: `openclaw doctor`, `openclaw config validate`, `openclaw gateway stability --bundle latest --json`, `OPENCLAW_GATEWAY_STARTUP_TRACE=1` for phase-timing on startup.

### Removed

- Background owner-sync loop (`chown -R --reference` every 5 seconds). On installations with growing workspaces (>100k files / multi-GB trees) the recursive chown blocked the Node event loop for 30-140 seconds per tick, causing session-write-lock stalls, Telegram polling timeouts, and gateway thrashing.
- `OPENCLAW_PERM_FIX_INTERVAL` env var (no longer applicable — no loop).
- Reference to [openclaw issue #61295](https://github.com/openclaw/openclaw/issues/61295) (`logging.file` ignored). The issue is closed in 2026.4+; `logging.file` works again. Bootstrap now uses it explicitly.

### Fixed

- File ownership now flows naturally from `PUID:PGID` instead of being chased by a timer. Every file the gateway writes is created with the right ownership from inception (because the gateway runs as `PUID:PGID`).
- `openclaw.json` is re-chowned to `PUID:PGID` after every `config set` (atomic-write pattern replaces the inode, otherwise fresh inode would inherit root because the bootstrap is still root at that point).
- Logs are now reliably written to `/tmp/openclaw/openclaw.log` on the host volume. Previously the file logger sometimes wrote to `/tmp/openclaw-0/` (gateway-instance namespace) which wasn't mounted out.
- Agent `primary` model no longer flips to `openai/<id>` when an OpenAI-namespace plugin auto-enables. Bootstrap pins `agents.list[0].model` to `custom/<first-model-id>` whenever a custom LLM is configured.

### Documentation

- README permissions section rewritten around PUID/PGID. Migration guidance for users coming from v1.1.0 (legacy `chown -R` loop is removed; first start under v1.1.1+ runs ONE recursive chown if ownership doesn't already match).
- README Logs section: removed reference to issue #61295, added diagnostic CLI examples, mentioned `OPENCLAW_LOG_LEVEL=debug` and `OPENCLAW_GATEWAY_STARTUP_TRACE=1`.
- Template Overview rewritten: SMB/NFS commands replaced with USER/GROUP (PUID/PGID) section explaining how to find host UID/GID and what the bootstrap does on first start.

## [1.1.0] — 2026-04-29

Theme: host-side visibility, persistent local tools, configurable LLM context limits, and full localization (Russian + Simplified Chinese).

### Added

- Persistent `/root/.local` host mount (`Local Tools Path` → `/mnt/user/appdata/openclaw/local`) for `pip --user` installs and manually-built CLIs; survives container restarts.
- `~/.local/bin` and `~/.cargo/bin` prepended to the template `PATH` so tools installed into the persistent mount are available immediately on next start.
- Configurable context-window and max-output-token limits for custom LLM models via `CUSTOM_LLM_CONTEXT_WINDOW` (default `128000`) and `CUSTOM_LLM_MAX_TOKENS` (default `32000`) — previously hardcoded.
- Russian translation: `README.ru.md` + `docs/MEMORY-SETUP.ru.md`.
- Simplified Chinese translation: `README.zh.md` + `docs/MEMORY-SETUP.zh.md`.
- Language switcher row at the top of every doc linking the three locales.

### Changed

- `CUSTOM_LLM_CONTEXT_WINDOW` and `CUSTOM_LLM_MAX_TOKENS` are surfaced in the Unraid template form alongside the rest of the Custom LLM fields, so they can be set at install time without editing Raw JSON post-install.

### Fixed

- Generic SMB/NFS host-side visibility: bootstrap applies `setgid` + `umask 0002` and resolves owner UID/GID from the appdata mount root via `chown --reference`, with no hardcoded UID/GID. Files created by OpenClaw inherit the host owner the first time you set it externally.
- Background owner-sync loop runs `chown --reference` every `OPENCLAW_PERM_FIX_INTERVAL` seconds (default `5`) so freshly-rotated session, canvas, and config-backup files stay accessible to SMB clients between container restarts.
- Container restart policy pinned to `--restart=unless-stopped` in `ExtraParams`, so the gateway cycles after a Control-UI-triggered self-restart instead of staying down.

### Tooling

- Added `scripts/merge-template.py`: in-place upgrade tool that overlays user-filled values from a stored `my-OpenClaw.xml` onto a newer upstream `openclaw.xml`, writes a `.bak` of the original, and lists new fields. Lets users pick up template-level changes without re-creating the container.

### Documentation

- Added "Restarting the gateway inside the container" guide with three options ranked by disruption: hot in-process restart via `SIGUSR1` through `docker exec`, full container restart, and full bootstrap re-run. Documents the upstream limitation tracked in [openclaw/openclaw#72224](https://github.com/openclaw/openclaw/issues/72224) (`openclaw gateway restart` requires `systemctl --user`, absent in the container image).
- Added `docs/MEMORY-SETUP.md`: end-to-end guide for OpenClaw memory backends on Unraid (Builtin, QMD, Graphiti+FalkorDB, Cognee, Mem0) with pros/cons, setup, costs, and a Quirks section listing five known OpenClaw bugs hit during template development.
- Added one-time `chown` commands and verification steps to README for users whose SMB shares showed permission errors; added the equivalent SMB/NFS visibility commands inline in the Unraid template `Overview` so they are visible without leaving the Add Container page.
- Added `Container goes to STOP after the gateway restarts itself` troubleshooting entry covering the `--restart=unless-stopped` policy and how to apply it to existing containers via `docker update`.
- Added this `CHANGELOG.md` (Keep a Changelog 1.1.0).
- README freshness pass: documented `merge-template.py` in the Updating section, added the missing `Perm Fix Interval` row to the Settings Reference table, expanded PATH description, noted that `contextWindow`/`maxTokens` come from the new template fields.

## [1.0.0] — 2026-04-28

Initial public release of the Unraid CA template for OpenClaw, verified on Unraid 7.x with OpenClaw 2026.4.

### Added

- Unraid CA template (`openclaw.xml`) with pre-configured paths for config, workspace, projects, Homebrew, and log volumes.
- Idempotent bootstrap script embedded as base64 in `PostArgs` to bypass Unraid's `<`/`>` sanitization; applies all managed config fields via `openclaw config set --batch-json` on every container start, preserving Control UI edits.
- `OPENCLAW_ALLOWED_ORIGINS` env-var support (required by OpenClaw 2026.2+); bootstrap fails fast with a clear error if omitted.
- `OPENCLAW_DISABLE_DEVICE_AUTH` toggle (default `true`) for LAN/plain-HTTP use without a secure context.
- Custom-LLM endpoint quartet: `CUSTOM_LLM_BASE_URL`, `CUSTOM_LLM_API_KEY`, `CUSTOM_LLM_API_TYPE`, `CUSTOM_LLM_MODEL_ID` wired into the bootstrap with full schema validation.
- API-key fields for built-in providers: Anthropic, OpenAI, OpenRouter, Gemini, Groq, xAI, Z.AI, plus a GitHub Copilot subscription token.
- Log volume mounted at `/tmp/openclaw` with configurable rotation via `OPENCLAW_LOG_MAX_FILE_BYTES`; works around [openclaw/openclaw#61295](https://github.com/openclaw/openclaw/issues/61295) (`logging.file` ignored by runtime).
- `docker-compose.yml` as a standalone alternative to the CA template.

### Documentation

- README with Quick Start, full Template Settings Reference table, Custom LLM Router walkthrough (LiteLLM / vLLM / Ollama / your own router), Configuration reference, Updating section, Troubleshooting, and pre-CA manual install instructions.

[Unreleased]: https://github.com/thebtf/openclaw-unraid/compare/v1.1.3...HEAD
[1.1.3]: https://github.com/thebtf/openclaw-unraid/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/thebtf/openclaw-unraid/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/thebtf/openclaw-unraid/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/thebtf/openclaw-unraid/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/thebtf/openclaw-unraid/releases/tag/v1.0.0
