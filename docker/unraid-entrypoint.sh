#!/bin/sh
# OpenClaw Unraid entrypoint (derived image).
#
# v2.0.0 replacement for the v1.x base64-in-PostArgs bootstrap. Same
# operational model, two structural fixes:
#
#   1. TRANSPORT: lives in the image (reviewable, versioned with the image)
#      instead of a base64 blob in the Unraid template. No --entrypoint or
#      --user overrides in the template anymore.
#   2. CONFIG OWNERSHIP SPLIT: permissions run every start (cheap,
#      idempotent); LLM/agent config seeding runs ONCE on first boot
#      (marker file) and always with `config set --merge`, so config
#      changes made later via Control UI / CLI / external tooling are
#      never clobbered. v1.x re-seeded agents.list on every start, which
#      hard-fails once extra agents exist ("Refusing to replace
#      agents.list") and restart-loops the container.
#
# Phases:
#   PHASE 1 (root):  usermod/groupmod node to PUID/PGID, one-shot chown of
#                    writable bind-mounts when ownership doesn't match,
#                    stale-lock cleanup.
#   PHASE 2 (PUID):  managed gateway/logging keys every start; first-boot
#                    LLM provider + agent seeding behind a marker. Runs
#                    under PUID via setpriv so openclaw.json never becomes
#                    root-owned and plugin ownership checks see the same
#                    uid the gateway runs as.
#   PHASE 3 (PUID):  exec gateway via setpriv.
#
# Ownership is set ONCE at startup, then holds naturally: the gateway runs
# as PUID:PGID and every file it creates inherits that ownership. No
# background loops, no recursive chown on a cron tick.

set -eu

# --- PUID/PGID resolution (LinuxServer.io convention) ---
# Defaults: 99/100 = nobody/users on Unraid. Override via template fields.
PUID="${PUID:-99}"
PGID="${PGID:-100}"

case "$PUID" in
  ''|*[!0-9]*) echo "[bootstrap] FATAL: PUID='$PUID' must be numeric." 1>&2; exit 1 ;;
esac
case "$PGID" in
  ''|*[!0-9]*) echo "[bootstrap] FATAL: PGID='$PGID' must be numeric." 1>&2; exit 1 ;;
esac

# Persisted-config migration defaults to the narrow, version-scoped automatic path.
# `check` was published before `auto` became the safe default, so existing
# container settings retain it as a deprecated compatibility alias.
CONFIG_MIGRATION_MODE="${OPENCLAW_CONFIG_MIGRATION:-auto}"
case "$CONFIG_MIGRATION_MODE" in
  auto|dry-run|apply-v2026.8.1)
    ;;
  check)
    echo "[bootstrap] WARNING: OPENCLAW_CONFIG_MIGRATION=check is deprecated and now behaves as auto. Use dry-run for a no-write, no-backup inspection." 1>&2
    CONFIG_MIGRATION_MODE=auto
    ;;
  *)
    echo "[bootstrap] FATAL: OPENCLAW_CONFIG_MIGRATION='$CONFIG_MIGRATION_MODE' is invalid. Expected auto, dry-run, or apply-v2026.8.1; check is a deprecated compatibility alias for auto." 1>&2
    exit 1
    ;;
esac

# Everything below assumes we start as root (image sets USER root; the
# template must NOT pass --user). Fail loud if someone overrode it.
if [ "$(id -u)" != "0" ]; then
  echo "[bootstrap] FATAL: entrypoint must start as root (got uid $(id -u)). Remove any --user override from the container settings; privileges are dropped to PUID:PGID internally." 1>&2
  exit 1
fi

# --- Re-map the in-image `node` user to host UID/GID ---
# `-o` (--non-unique) allows collisions with existing system users/groups
# (e.g. GID 100 = `users` already exists on Debian). linuxserver.io does
# the same.
CURRENT_UID=$(id -u node 2>/dev/null || echo 1000)
CURRENT_GID=$(id -g node 2>/dev/null || echo 1000)

UID_CHANGED=0
GID_CHANGED=0
if [ "$CURRENT_UID" != "$PUID" ]; then
  if usermod -u "$PUID" -o node 2>/dev/null; then
    UID_CHANGED=1
  else
    echo "[bootstrap] WARN: usermod failed to set node UID=$PUID; falling back to setpriv with raw UID." 1>&2
  fi
fi
if [ "$CURRENT_GID" != "$PGID" ]; then
  if groupmod -g "$PGID" -o node 2>/dev/null; then
    GID_CHANGED=1
  else
    echo "[bootstrap] WARN: groupmod failed to set node GID=$PGID; falling back to setpriv with raw GID." 1>&2
  fi
fi

# After a UID/GID remap, image files owned by the OLD ids (/app,
# /app/node_modules, /home/node) become orphaned and the gateway crashes
# on runtime-deps install or auth. Re-align them once per remap.
#
# OPENCLAW_SKIP_SYSTEM_PATH_REMAP=1 skips the sweep (fast Apply cycles on
# an already-aligned overlay). WARNING: if Unraid recreates the container
# the overlay is fresh (/app back to UID 1000) — unset the skip once.
if [ "${OPENCLAW_SKIP_SYSTEM_PATH_REMAP:-0}" = "1" ]; then
  echo "[bootstrap] OPENCLAW_SKIP_SYSTEM_PATH_REMAP=1, skipping /home/node and /app chown sweep"
else
  SYSTEM_PATHS="/home/node /app"
  if [ "$UID_CHANGED" = "1" ]; then
    for sys_dir in $SYSTEM_PATHS; do
      [ -d "$sys_dir" ] || continue
      if find "$sys_dir" -uid "$CURRENT_UID" -print -quit 2>/dev/null | grep -q .; then
        echo "[bootstrap] re-aligning system path ownership: $sys_dir (uid $CURRENT_UID -> $PUID)"
        find "$sys_dir" -uid "$CURRENT_UID" -exec chown -h "$PUID" {} + 2>/dev/null || true
      fi
    done
  fi
  if [ "$GID_CHANGED" = "1" ]; then
    for sys_dir in $SYSTEM_PATHS; do
      [ -d "$sys_dir" ] || continue
      if find "$sys_dir" -gid "$CURRENT_GID" -print -quit 2>/dev/null | grep -q .; then
        echo "[bootstrap] re-aligning system path group: $sys_dir (gid $CURRENT_GID -> $PGID)"
        find "$sys_dir" -gid "$CURRENT_GID" -exec chgrp -h "$PGID" {} + 2>/dev/null || true
      fi
    done
  fi
fi

# --- Ensure required directories exist ---
# Paths follow upstream image conventions: gateway runs as `node`, HOME is
# /home/node, config at $HOME/.openclaw.
mkdir -p /home/node/.openclaw /home/node/.openclaw/workspace /home/node/.local /tmp/openclaw

CFG=/home/node/.openclaw/openclaw.json
SEED_MARKER=/home/node/.openclaw/.unraid-template-seeded

# --- One-shot ownership alignment (only when mismatch detected) ---
# DEEP_PERM_DIRS: small openclaw-managed trees, recursive scan (catches
# root-owned leftovers from old template versions).
# SHALLOW_PERM_DIRS: potentially huge (workspace, logs, pip installs) —
# check only the mount root; the gateway runs as PUID and keeps the rest
# consistent. Recursive find on a 100k-file tree is the chown-loop death
# spiral v1.1.1 already escaped.
DEEP_PERM_DIRS="/home/node/.openclaw"
SHALLOW_PERM_DIRS="/home/node/.openclaw/workspace /home/node/.local /tmp/openclaw /home/linuxbrew /projects"

if [ "${OPENCLAW_SKIP_OWNERSHIP_INIT:-0}" != "1" ]; then
  for dir in $DEEP_PERM_DIRS; do
    [ -d "$dir" ] || continue
    if find "$dir" \( -not -uid "$PUID" -o -not -gid "$PGID" \) -print -quit 2>/dev/null | grep -q .; then
      echo "[bootstrap] deep-aligning ownership: $dir (some entries != $PUID:$PGID)"
      chown -R "$PUID:$PGID" "$dir" 2>/dev/null || {
        echo "[bootstrap] WARN: chown -R failed on $dir; gateway may have permission issues." 1>&2
      }
    fi
  done
  for dir in $SHALLOW_PERM_DIRS; do
    [ -d "$dir" ] || continue
    DIR_UID=$(stat -c '%u' "$dir" 2>/dev/null || echo 0)
    DIR_GID=$(stat -c '%g' "$dir" 2>/dev/null || echo 0)
    if [ "$DIR_UID" != "$PUID" ] || [ "$DIR_GID" != "$PGID" ]; then
      echo "[bootstrap] aligning ownership (root-only): $dir ($DIR_UID:$DIR_GID -> $PUID:$PGID)"
      chown -R "$PUID:$PGID" "$dir" 2>/dev/null || {
        echo "[bootstrap] WARN: chown -R failed on $dir; gateway may have permission issues." 1>&2
      }
    fi
  done
  echo "[bootstrap] ownership init done (PUID=$PUID, PGID=$PGID)"
else
  echo "[bootstrap] OPENCLAW_SKIP_OWNERSHIP_INIT=1, skipping ownership init"
fi
# --- Log target contract (every start) ---
# `/tmp/openclaw` can be bind-mounted or can retain a stale file whose owner
# differs from the directory. Repair both explicitly before any PUID CLI or
# gateway process can open the configured log. Never replace a non-regular
# path: that is an unsafe mount/configuration error, not an ownership issue.
LOG_DIR=/tmp/openclaw
LOG_FILE=$LOG_DIR/openclaw.log
if [ -L "$LOG_DIR" ] || [ ! -d "$LOG_DIR" ]; then
  echo "[bootstrap] FATAL: $LOG_DIR must be a real directory." 1>&2
  exit 1
fi
if [ -L "$LOG_FILE" ] || { [ -e "$LOG_FILE" ] && [ ! -f "$LOG_FILE" ]; }; then
  echo "[bootstrap] FATAL: $LOG_FILE must be a regular file." 1>&2
  exit 1
fi
if [ ! -e "$LOG_FILE" ]; then
  : > "$LOG_FILE"
fi
if ! chown "$PUID:$PGID" "$LOG_DIR" "$LOG_FILE" || ! chmod 0700 "$LOG_DIR" || ! chmod 0600 "$LOG_FILE"; then
  echo "[bootstrap] FATAL: could not prepare $LOG_FILE for PUID=$PUID PGID=$PGID." 1>&2
  exit 1
fi
echo "[bootstrap] log target ready ($PUID:$PGID, dir=0700, file=0600)"


# --- Clean up stale plugin-runtime-deps locks ---
# A crashed container can leave the bundled-deps mirror lock behind; the
# next start waits 5 minutes and dies with SECRETS_RELOADER_DEGRADED,
# looping. owner.json carries the holder PID — if it's not alive in our
# namespace, the lock is stale. Safe: single container, no other gateway.
LOCKS_GLOB=/home/node/.openclaw/plugin-runtime-deps/*/.openclaw-runtime-mirror.lock
for lock_dir in $LOCKS_GLOB; do
  [ -d "$lock_dir" ] || continue
  owner_file="$lock_dir/owner.json"
  if [ ! -f "$owner_file" ]; then
    echo "[bootstrap] removing lock without owner.json: $lock_dir"
    rm -rf "$lock_dir" 2>/dev/null || true
    continue
  fi
  owner_pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$owner_file" | head -1)
  if [ -z "$owner_pid" ] || [ ! -d "/proc/$owner_pid" ]; then
    echo "[bootstrap] removing stale lock (owner pid=$owner_pid not alive): $lock_dir"
    rm -rf "$lock_dir" 2>/dev/null || true
  fi
done

# --- Validate required env ---
if [ -z "${OPENCLAW_ALLOWED_ORIGINS:-}" ]; then
  echo "[bootstrap] FATAL: OPENCLAW_ALLOWED_ORIGINS is required (e.g. http://192.168.1.41:18789)." 1>&2
  exit 1
fi

if [ -n "${CUSTOM_LLM_BASE_URL:-}" ]; then
  API_TYPE="${CUSTOM_LLM_API_TYPE:-openai-completions}"
  case "$API_TYPE" in
    openai-completions|openai-responses|openai-codex-responses|anthropic-messages|google-generative-ai|github-copilot|bedrock-converse-stream|ollama|azure-openai-responses)
      ;;
    *)
      echo "[bootstrap] FATAL: CUSTOM_LLM_API_TYPE='$API_TYPE' is invalid. Expected one of: openai-completions, openai-responses, openai-codex-responses, anthropic-messages, google-generative-ai, github-copilot, bedrock-converse-stream, ollama, azure-openai-responses." 1>&2
      echo "[bootstrap] HINT: this field selects the protocol ADAPTER, not the model name. Put the model name in CUSTOM_LLM_MODEL_ID instead." 1>&2
      exit 1
      ;;
  esac
  if [ -z "${CUSTOM_LLM_MODEL_ID:-}" ]; then
    echo "[bootstrap] FATAL: CUSTOM_LLM_MODEL_ID is required when CUSTOM_LLM_BASE_URL is set (e.g. gpt-5.5, llama-3.1-70b). Comma-separated for multiple." 1>&2
    exit 1
  fi
fi

to_bool() {
  case "$1" in
    1|true|TRUE|True|yes|YES|Yes|on|ON|On) echo "true" ;;
    *) echo "false" ;;
  esac
}
CUSTOM_LLM_REASONING=$(to_bool "${CUSTOM_LLM_REASONING:-true}")

# --- CSV -> JSON helpers ---
csv_to_json_strings() {
  echo "$1" | awk -F, '{
    out=""
    for (i=1; i<=NF; i++) {
      v=$i
      gsub(/^[ \t]+|[ \t]+$/, "", v)
      sub(/\/+$/, "", v)
      if (v != "") {
        out = out (out ? "," : "") "\"" v "\""
      }
    }
    print out
  }'
}

csv_to_model_objects() {
  CTX="${CUSTOM_LLM_CONTEXT_WINDOW:-128000}"
  MAX="${CUSTOM_LLM_MAX_TOKENS:-32000}"
  REA="$CUSTOM_LLM_REASONING"
  echo "$1" | awk -F, -v ctx="$CTX" -v maxtok="$MAX" -v rea="$REA" '{
    out=""
    for (i=1; i<=NF; i++) {
      v=$i
      gsub(/^[ \t]+|[ \t]+$/, "", v)
      if (v != "") {
        obj="{\"id\":\"" v "\",\"name\":\"" v "\",\"contextWindow\":" ctx ",\"maxTokens\":" maxtok ",\"reasoning\":" rea "}"
        out = out (out ? "," : "") obj
      }
    }
    print out
  }'
}

ORIGINS_JSON=$(csv_to_json_strings "$OPENCLAW_ALLOWED_ORIGINS")

# Run OpenClaw CLI helpers as PUID (not root): config/state paths resolve via
# the same HOME the gateway uses and every migration artifact stays PUID-owned.
run_as_puid_with_home() {
  home=$1
  shift
  setpriv --reuid="$PUID" --regid="$PGID" --init-groups \
    env HOME="$home" OPENCLAW_HOME="$home" OPENCLAW_STATE_DIR="$home/.openclaw" \
    OPENCLAW_CONFIG_PATH="$home/.openclaw/openclaw.json" OPENCLAW_CONFIG_DIR="$home/.openclaw" \
    OPENCLAW_WORKSPACE_DIR="$home/.openclaw/workspace" PATH="$PATH" "$@"
}

run_as_puid() {
  run_as_puid_with_home /home/node "$@"
}

# --- EXEC APPROVALS LEGACY STATE (PUID, before every config write) ---
# The exact image-pinned upstream importer owns SQLite, receipts, exclusive
# claims, and source retirement. This boundary creates a private verified
# backup first and never prints approval data or raw upstream reports.
# Config dry-run is globally inspection-only, so it must not invoke this
# state-writing migration before the later config planning/refusal path.
if [ "$CONFIG_MIGRATION_MODE" = "dry-run" ]; then
  echo "[bootstrap] exec-approvals-migration: skipped (config dry-run)"
else
  if ! EXEC_APPROVALS_MIGRATION_RESULT=$(run_as_puid node /usr/local/bin/migrate-openclaw-exec-approvals.mjs); then
    case "$EXEC_APPROVALS_MIGRATION_RESULT" in
      'exec-approvals-migration: refused code='[a-z0-9-]*)
        echo "[bootstrap] $EXEC_APPROVALS_MIGRATION_RESULT" 1>&2
        ;;
      *)
        echo "[bootstrap] exec-approvals-migration: refused code=entrypoint-status" 1>&2
        ;;
    esac
    echo "[bootstrap] FATAL: exec approvals migration refused; legacy approval state was left for recovery. Refusing managed writes." 1>&2
    exit 1
  fi
  case "$EXEC_APPROVALS_MIGRATION_RESULT" in
    'exec-approvals-migration: no-op'|'exec-approvals-migration: applied')
      echo "[bootstrap] $EXEC_APPROVALS_MIGRATION_RESULT"
      ;;
    *)
      echo "[bootstrap] exec-approvals-migration: refused code=entrypoint-status" 1>&2
      echo "[bootstrap] FATAL: exec approvals migration returned an invalid status. Refusing managed writes." 1>&2
      exit 1
      ;;
  esac
fi

# --- Ensure config file exists; openclaw config set requires it ---
CONFIG_EXISTED=0
if [ -L "$CFG" ] || [ -s "$CFG" ]; then
  CONFIG_EXISTED=1
else
  if [ "$CONFIG_MIGRATION_MODE" = "dry-run" ]; then
    echo "[bootstrap] FATAL: no existing OpenClaw config needs migration; workspace migration was not run because OPENCLAW_CONFIG_MIGRATION=dry-run is inspection-only. No config, workspace, backup, or SQLite state was created." 1>&2
    exit 1
  fi
  printf '%s' '{}' > "$CFG"
  chown "$PUID:$PGID" "$CFG" 2>/dev/null || true
  echo "[bootstrap] created empty $CFG"
fi

CONFIG_RECOVERY_ATTEMPTED=0
MIGRATION_BACKUP_PATH=
MIGRATION_CANDIDATE_DIR=

# The candidate root stays root-owned and unreadable. Its group-search bit
# lets the PUID process reach its own 0700 HOME without exposing contents.
cleanup_migration_candidate() {
  if [ -n "$MIGRATION_CANDIDATE_DIR" ]; then
    rm -rf "$MIGRATION_CANDIDATE_DIR" || return 1
    if [ -e "$MIGRATION_CANDIDATE_DIR" ]; then
      return 1
    fi
    MIGRATION_CANDIDATE_DIR=
  fi
}

# Explicit cleanup below is required before real apply; this catches any
# ordinary exit path that interrupts candidate preparation.
trap 'cleanup_migration_candidate' 0

candidate_preflight_failed() {
  message=$1
  if ! cleanup_migration_candidate; then
    echo "[bootstrap] FATAL: temporary migration candidate cleanup failed. The real config was left byte-identical and no migration backup was created. Refusing managed writes." 1>&2
  else
    echo "[bootstrap] FATAL: $message The real config was left byte-identical and no migration backup was created. Preserve openclaw.json and recover it manually; do not run broad doctor --fix as an automatic upgrade step. Refusing managed writes." 1>&2
  fi
  return 1
}

exec_gateway() {
  echo "[bootstrap] dropping privileges to $PUID:$PGID and starting gateway"
  exec setpriv --reuid="$PUID" --regid="$PGID" --init-groups \
    env HOME=/home/node PATH="$PATH" \
    node /app/dist/index.js gateway --bind lan --auth token
}

# Native validation is authoritative. The migrator only handles the exact
# v2026.8.1 legacy and partial shapes it can plan without reading values.
plan_supported_migration() {
  if ! MIGRATION_PLAN=$(run_as_puid python3 /usr/local/bin/migrate-openclaw-2-config.py --config "$CFG"); then
    echo "[bootstrap] FATAL: existing OpenClaw config is invalid and is not a supported v2026.8.1 migration shape. It was left byte-identical and no migration backup was created. Preserve openclaw.json and recover it manually; do not run broad doctor --fix as an automatic upgrade step. Refusing managed writes." 1>&2
    return 1
  fi

  printf '%s\n' "$MIGRATION_PLAN"
  if printf '%s\n' "$MIGRATION_PLAN" | grep -Fqx 'already migrated'; then
    echo "[bootstrap] FATAL: existing OpenClaw config is invalid but the v2026.8.1 migrator reports already migrated. It was left byte-identical and no migration backup was created because this invalid configuration is unsupported. Preserve openclaw.json and recover it manually. Refusing managed writes." 1>&2
    return 1
  fi
  if ! printf '%s\n' "$MIGRATION_PLAN" | grep -Fqx 'dry run: planned changed paths'; then
    echo "[bootstrap] FATAL: narrow OpenClaw v2026.8.1 migration did not produce a supported plan. It was left byte-identical and no migration backup was created. Preserve openclaw.json and recover it manually. Refusing managed writes." 1>&2
    return 1
  fi
}

# Apply and validate only a private copy first. Its backup and all candidate
# artifacts are removed before the real config is eligible for backup/apply.
preflight_supported_migration() {
  if ! MIGRATION_CANDIDATE_DIR=$(mktemp -d /tmp/openclaw-migration.XXXXXX); then
    echo "[bootstrap] FATAL: could not create a private temporary migration candidate. The real config was left byte-identical and no migration backup was created. Refusing managed writes." 1>&2
    return 1
  fi

  MIGRATION_CANDIDATE_HOME="$MIGRATION_CANDIDATE_DIR/home/node"
  MIGRATION_CANDIDATE_CFG="$MIGRATION_CANDIDATE_HOME/.openclaw/openclaw.json"
  if ! chown "0:$PGID" "$MIGRATION_CANDIDATE_DIR" || \
     ! chmod 0710 "$MIGRATION_CANDIDATE_DIR" || \
     ! mkdir -p "$MIGRATION_CANDIDATE_HOME/.openclaw/workspace" || \
     ! cp "$CFG" "$MIGRATION_CANDIDATE_CFG" || \
     ! cmp -s "$CFG" "$MIGRATION_CANDIDATE_CFG" || \
     ! chown -R "$PUID:$PGID" "$MIGRATION_CANDIDATE_HOME" || \
     ! chmod 0700 "$MIGRATION_CANDIDATE_HOME" "$MIGRATION_CANDIDATE_HOME/.openclaw"; then
    candidate_preflight_failed "could not prepare a private byte-identical migration candidate."
    return 1
  fi

  if ! CANDIDATE_MIGRATION_RESULT=$(run_as_puid_with_home "$MIGRATION_CANDIDATE_HOME" python3 /usr/local/bin/migrate-openclaw-2-config.py --config "$MIGRATION_CANDIDATE_CFG" --apply 2>&1); then
    candidate_preflight_failed "existing OpenClaw config is invalid and is not a supported v2026.8.1 migration shape."
    return 1
  fi
  if printf '%s\n' "$CANDIDATE_MIGRATION_RESULT" | grep -Fqx 'already migrated'; then
    candidate_preflight_failed "existing OpenClaw config is invalid but the v2026.8.1 migrator reports already migrated because this invalid configuration is unsupported."
    return 1
  fi
  if ! printf '%s\n' "$CANDIDATE_MIGRATION_RESULT" | grep -Fqx 'applied migration'; then
    candidate_preflight_failed "narrow OpenClaw v2026.8.1 candidate migration did not confirm an applied migration."
    return 1
  fi
  # Validate the private candidate config while retaining the persisted plugin
  # registry and state that native validation may need to resolve entries.
  if ! run_as_puid env OPENCLAW_CONFIG_PATH="$MIGRATION_CANDIDATE_CFG" node /app/dist/index.js config validate >/dev/null 2>&1; then
    candidate_preflight_failed "candidate migration failed native OpenClaw validation."
    return 1
  fi
  if ! cleanup_migration_candidate; then
    echo "[bootstrap] FATAL: temporary migration candidate cleanup failed. The real config was left byte-identical and no migration backup was created. Refusing managed writes." 1>&2
    return 1
  fi
  unset CANDIDATE_MIGRATION_RESULT
  echo "[bootstrap] candidate migration passed native OpenClaw validation"
}

apply_supported_migration() {
  if ! MIGRATION_RESULT=$(run_as_puid python3 /usr/local/bin/migrate-openclaw-2-config.py --config "$CFG" --apply); then
    echo "[bootstrap] FATAL: supported OpenClaw v2026.8.1 migration could not complete atomically. Inspect the migrator output and any printed backup path, then recover manually. Refusing managed writes." 1>&2
    exit 1
  fi

  printf '%s\n' "$MIGRATION_RESULT"
  if ! printf '%s\n' "$MIGRATION_RESULT" | grep -Fqx 'applied migration'; then
    echo "[bootstrap] FATAL: narrow OpenClaw v2026.8.1 migration did not confirm an applied migration. Refusing managed writes." 1>&2
    exit 1
  fi
  MIGRATION_BACKUP_PATH=$(printf '%s\n' "$MIGRATION_RESULT" | sed -n 's/^backup: //p' | sed -n '1p')
  if [ -z "$MIGRATION_BACKUP_PATH" ]; then
    echo "[bootstrap] FATAL: narrow OpenClaw v2026.8.1 migration did not report its backup path. Refusing managed writes." 1>&2
    exit 1
  fi
}

if [ "$CONFIG_EXISTED" = "1" ]; then
  if ! run_as_puid node /app/dist/index.js config validate >/dev/null 2>&1; then
    echo "[bootstrap] existing config needs OpenClaw v2026.8.1 migration"
    case "$CONFIG_MIGRATION_MODE" in
      dry-run)
        echo "[bootstrap] running narrow OpenClaw v2026.8.1 migration dry-run"
        if ! plan_supported_migration; then
          exit 1
        fi
        echo "[bootstrap] FATAL: existing OpenClaw config needs a supported v2026.8.1 migration. OPENCLAW_CONFIG_MIGRATION=dry-run is inspection-only; it left the config byte-identical and created no backup. Restart with OPENCLAW_CONFIG_MIGRATION=auto (the default) to apply it, or use OPENCLAW_CONFIG_MIGRATION=apply-v2026.8.1 as an advanced explicit apply. Refusing managed writes." 1>&2
        exit 1
        ;;
      auto)
        if ! preflight_supported_migration; then
          exit 1
        fi
        echo "[bootstrap] auto-applying supported backup-first OpenClaw v2026.8.1 migration"
        ;;
      apply-v2026.8.1)
        if ! preflight_supported_migration; then
          exit 1
        fi
        echo "[bootstrap] applying narrow backup-first migration for OpenClaw v2026.8.1"
        ;;
    esac

    apply_supported_migration
    CONFIG_RECOVERY_ATTEMPTED=1
  elif [ "$CONFIG_MIGRATION_MODE" = "apply-v2026.8.1" ]; then
    echo "[bootstrap] WARNING: OPENCLAW_CONFIG_MIGRATION=apply-v2026.8.1 is no longer needed for this valid existing config. Return it to auto before the next image update." 1>&2
  fi
fi

if [ "$CONFIG_MIGRATION_MODE" = "dry-run" ]; then
  echo "[bootstrap] FATAL: existing OpenClaw config needs no migration; workspace migration was not run because OPENCLAW_CONFIG_MIGRATION=dry-run is inspection-only. Refusing managed writes." 1>&2
  exit 1
fi

# --- LEGACY DEFAULT-AGENT ROLES (PUID, upstream materializer only) ---
# A multi-agent field roster that lost its implicit main owner is repaired by
# the exact image-pinned materializer before workspace/session or managed-key
# writes. The helper validates a private candidate through native config
# validation before atomically publishing it.
if ! DEFAULT_AGENT_ROLES_RESULT=$(run_as_puid node /usr/local/bin/materialize-legacy-default-agent-roles.mjs); then
  case "$DEFAULT_AGENT_ROLES_RESULT" in
    'default-agent-roles: refused code='[a-z0-9-]*)
      echo "[bootstrap] $DEFAULT_AGENT_ROLES_RESULT" 1>&2
      ;;
    *)
      echo "[bootstrap] default-agent-roles: refused code=entrypoint-status" 1>&2
      ;;
  esac
  echo "[bootstrap] FATAL: default-agent role materialization refused. Refusing managed writes." 1>&2
  exit 1
fi
case "$DEFAULT_AGENT_ROLES_RESULT" in
  'default-agent-roles: applied'|'default-agent-roles: already-materialized')
    echo "[bootstrap] $DEFAULT_AGENT_ROLES_RESULT"
    ;;
  *)
    echo "[bootstrap] default-agent-roles: refused code=entrypoint-status" 1>&2
    echo "[bootstrap] FATAL: default-agent role materialization returned an invalid status. Refusing managed writes." 1>&2
    exit 1
    ;;
esac
# Migration and validation commands may create the shared SQLite state after
# the initial ownership sweep. Re-align only this small managed directory
# before the next PUID command; persisted workspaces and session trees remain
# outside this bounded repair.
STATE_DIR=/home/node/.openclaw/state
if [ -d "$STATE_DIR" ] && find "$STATE_DIR" \( -not -uid "$PUID" -o -not -gid "$PGID" \) -print -quit 2>/dev/null | grep -q .; then
  echo "[bootstrap] aligning newly created shared state ownership: $STATE_DIR"
  chown -R "$PUID:$PGID" "$STATE_DIR" || {
    echo "[bootstrap] FATAL: could not align newly created shared state ownership. Refusing managed writes." 1>&2
    exit 1
  }
fi


# --- WORKSPACE LEGACY STATE (PUID, upstream importer only) ---
# Use the real config only after the exact config migration path has completed.
# The workspace helper calls the build-pinned upstream detect/migrate pair; it
# never runs broad Doctor migration orchestration or writes managed keys.
if ! run_as_puid node /app/dist/index.js config validate >/dev/null 2>&1; then
  echo "[bootstrap] FATAL: OpenClaw config failed native validation before workspace migration. Refusing managed writes." 1>&2
  exit 1
fi

if ! WORKSPACE_MIGRATION_RESULT=$(run_as_puid node /usr/local/bin/migrate-openclaw-legacy-workspaces.mjs); then
  echo "[bootstrap] workspace-migration: refused" 1>&2
  echo "[bootstrap] FATAL: workspace migration refused; legacy workspace sources were left for manual recovery. Refusing managed writes." 1>&2
  exit 1
fi
case "$WORKSPACE_MIGRATION_RESULT" in
  'workspace-migration: no-op'|'workspace-migration: applied')
    echo "[bootstrap] $WORKSPACE_MIGRATION_RESULT"
    ;;
  *)
    echo "[bootstrap] workspace-migration: refused" 1>&2
    echo "[bootstrap] FATAL: workspace migration returned an invalid status. Refusing managed writes." 1>&2
    exit 1
    ;;
esac

# --- SESSION LEGACY STATE (PUID, focused upstream importer only) ---
# Doctor owns SQLite schema migration, durable writes, validation, manifests,
# and archive publication. The helper keeps its raw JSON report out of logs.
if ! SESSION_MIGRATION_RESULT=$(run_as_puid node /usr/local/bin/migrate-openclaw-legacy-sessions.mjs); then
  case "$SESSION_MIGRATION_RESULT" in
    'session-migration: failed code='*' status='*)
      echo "[bootstrap] $SESSION_MIGRATION_RESULT" 1>&2
      ;;
    *)
      echo "[bootstrap] session-migration: failed code=entrypoint-status status=unknown" 1>&2
      ;;
  esac
  exit 1
fi
case "$SESSION_MIGRATION_RESULT" in
  'session-migration: no-op'|'session-migration: applied targets='*)
    echo "[bootstrap] $SESSION_MIGRATION_RESULT"
    ;;
  *)
    echo "session-migration: failed code=entrypoint-status status=0" 1>&2
    exit 1
    ;;
esac

# --- MANAGED KEYS (every start, scalars only — idempotent, never destructive) ---
# These are the template-owned gateway/logging fields. Deliberately NO
# agents.list, NO models.providers here: those are seeded once below and
# then owned by the runtime (Control UI / CLI / external config tooling).
# `models.mode` is also a scalar, so set it here (plain set), not in the
# merge batch below — `config set --merge` rightfully rejects scalar merges.
BATCH='['
BATCH="$BATCH{\"path\":\"gateway.mode\",\"value\":\"local\"}"
BATCH="$BATCH,{\"path\":\"gateway.bind\",\"value\":\"lan\"}"
BATCH="$BATCH,{\"path\":\"gateway.controlUi.allowedOrigins\",\"value\":[$ORIGINS_JSON]}"
BATCH="$BATCH,{\"path\":\"gateway.auth.mode\",\"value\":\"token\"}"
if [ -n "${CUSTOM_LLM_BASE_URL:-}" ]; then
  BATCH="$BATCH,{\"path\":\"models.mode\",\"value\":\"merge\"}"
fi
LOG_MAX_BYTES="${OPENCLAW_LOG_MAX_FILE_BYTES:-104857600}"
BATCH="$BATCH,{\"path\":\"logging.maxFileBytes\",\"value\":$LOG_MAX_BYTES}"
BATCH="$BATCH,{\"path\":\"logging.file\",\"value\":\"/tmp/openclaw/openclaw.log\"}"
BATCH="$BATCH]"

echo "[bootstrap] applying managed gateway/logging keys"
if ! run_as_puid node /app/dist/index.js config set --batch-json "$BATCH"; then
  echo "[bootstrap] FATAL: openclaw rejected the managed-keys update. See errors above." 1>&2
  exit 1
fi

if [ "$CONFIG_RECOVERY_ATTEMPTED" = "1" ]; then
  if ! run_as_puid node /app/dist/index.js config validate >/dev/null 2>&1; then
    echo "[bootstrap] FATAL: OpenClaw config remains invalid after narrow migration and managed-key update. Restore from: $MIGRATION_BACKUP_PATH. Refusing startup." 1>&2
    exit 1
  fi
fi

# --- FIRST-BOOT SEEDING (once, marker-gated, collection-preserving) ---
# Seeds the custom LLM provider and the main agent from template env on the
# FIRST start only. After that the config file is the single source of
# truth; template env changes to CUSTOM_LLM_* no longer overwrite it.
# Deliberately deleting the marker refreshes provider baseUrl, apiKey, and
# api from template env while preserving existing agent entries and model IDs.
if [ -n "${CUSTOM_LLM_BASE_URL:-}" ]; then
  if [ -f "$SEED_MARKER" ]; then
    echo "[bootstrap] LLM/agent config already seeded ($(cat "$SEED_MARKER" 2>/dev/null || echo unknown)); config file is source of truth. Delete $SEED_MARKER to re-seed."
  else
    BASE_URL=$(echo "$CUSTOM_LLM_BASE_URL" | sed 's:/*$::')
    MODELS_JSON=$(csv_to_model_objects "$CUSTOM_LLM_MODEL_ID")
    CUSTOM_PROVIDER="{\"baseUrl\":\"$BASE_URL\",\"apiKey\":\"\${CUSTOM_LLM_API_KEY}\",\"api\":\"$API_TYPE\",\"models\":[$MODELS_JSON]}"
    PRIMARY_MODEL=$(echo "$CUSTOM_LLM_MODEL_ID" | awk -F, '{
      v=$1; gsub(/^[ \t]+|[ \t]+$/, "", v); print v
    }')

    # A missing provider can be created as one complete object. Existing
    # providers must retain their model IDs, so merge only models and write
    # provider scalar leaves separately.
    if run_as_puid node -e 'try { const fs = require("fs"); const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.exit(config.models?.providers?.custom ? 0 : 1); } catch (error) { console.error(error.message); process.exit(2); }' "$CFG"; then
      MODELS_BATCH="[{\"path\":\"models.providers.custom.models\",\"value\":[$MODELS_JSON]}]"
      PROVIDER_SCALARS_BATCH="[{\"path\":\"models.providers.custom.baseUrl\",\"value\":\"$BASE_URL\"},{\"path\":\"models.providers.custom.apiKey\",\"value\":\"\${CUSTOM_LLM_API_KEY}\"},{\"path\":\"models.providers.custom.api\",\"value\":\"$API_TYPE\"}]"

      echo "[bootstrap] first boot: merging custom LLM models and updating provider settings"
      if ! run_as_puid node /app/dist/index.js config set --merge --batch-json "$MODELS_BATCH" || \
         ! run_as_puid node /app/dist/index.js config set --batch-json "$PROVIDER_SCALARS_BATCH"; then
        echo "[bootstrap] FATAL: openclaw rejected the custom-provider seed. See errors above." 1>&2
        exit 1
      fi
    else
      provider_status=$?
      case "$provider_status" in
        1)
          PROVIDER_BATCH="[{\"path\":\"models.providers.custom\",\"value\":$CUSTOM_PROVIDER}]"
          echo "[bootstrap] first boot: creating custom LLM provider"
          if ! run_as_puid node /app/dist/index.js config set --batch-json "$PROVIDER_BATCH"; then
            echo "[bootstrap] FATAL: openclaw rejected the custom-provider seed. See errors above." 1>&2
            exit 1
          fi
          ;;
        *)
          echo "[bootstrap] FATAL: could not read or parse $CFG while inspecting the existing custom provider." 1>&2
          exit 1
          ;;
      esac
    fi


    AGENT_BATCH="[{\"path\":\"agents.entries.main.model\",\"value\":\"custom/$PRIMARY_MODEL\"}]"
    echo "[bootstrap] first boot: setting main agent model"
    if ! run_as_puid node /app/dist/index.js config set --batch-json "$AGENT_BATCH"; then
      echo "[bootstrap] FATAL: openclaw rejected the main-agent seed. See errors above." 1>&2
      exit 1
    fi
    date -u +"%Y-%m-%dT%H:%M:%SZ" > "$SEED_MARKER"
    chown "$PUID:$PGID" "$SEED_MARKER" 2>/dev/null || true
    echo "[bootstrap] seeded: custom LLM=$BASE_URL ($API_TYPE), models=[$CUSTOM_LLM_MODEL_ID], primary=custom/$PRIMARY_MODEL"
  fi
fi

# --- Drop privileges and exec gateway ---
exec_gateway
