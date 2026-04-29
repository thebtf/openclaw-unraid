# Changelog

All notable changes to this Unraid Community Applications template are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Persistent `/root/.local` host mount (`Local Tools Path` → `/mnt/user/appdata/openclaw/local`) for `pip --user` installs and manually-built CLIs; survives container restarts.
- `~/.local/bin` and `~/.cargo/bin` prepended to the template `PATH` so tools installed into the persistent mount are available immediately on next start.
- Configurable context-window and max-output-token limits for custom LLM models via `CUSTOM_LLM_CONTEXT_WINDOW` (default `128000`) and `CUSTOM_LLM_MAX_TOKENS` (default `32000`) — previously hardcoded.

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

[Unreleased]: https://github.com/thebtf/openclaw-unraid/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/thebtf/openclaw-unraid/releases/tag/v1.0.0
