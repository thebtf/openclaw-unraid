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
DISABLE_DEVICE_AUTH=$(to_bool "${OPENCLAW_DISABLE_DEVICE_AUTH:-true}")
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

# --- Ensure config file exists; openclaw config set requires it ---
if [ ! -s "$CFG" ]; then
  printf '%s' '{}' > "$CFG"
  chown "$PUID:$PGID" "$CFG" 2>/dev/null || true
  echo "[bootstrap] created empty $CFG"
fi

# Run openclaw CLI as PUID (not root): config path resolves via HOME, the
# rewritten openclaw.json keeps PUID ownership (no re-chown dance), and
# plugin-discovery ownership checks evaluate against the same uid the
# gateway will run as.
run_as_puid() {
  setpriv --reuid="$PUID" --regid="$PGID" --init-groups \
    env HOME=/home/node PATH="$PATH" "$@"
}

# --- MANAGED KEYS (every start, scalars only — idempotent, never destructive) ---
# These are the template-owned gateway/logging fields. Deliberately NO
# agents.list, NO models.providers here: those are seeded once below and
# then owned by the runtime (Control UI / CLI / external config tooling).
# `models.mode` is also a scalar, so set it here (plain set), not in the
# merge batch below — `config set --merge` rightfully rejects scalar merges.
BATCH='['
BATCH="$BATCH{\"path\":\"gateway.mode\",\"value\":\"local\"}"
BATCH="$BATCH,{\"path\":\"gateway.bind\",\"value\":\"lan\"}"
BATCH="$BATCH,{\"path\":\"gateway.controlUi.allowInsecureAuth\",\"value\":true}"
BATCH="$BATCH,{\"path\":\"gateway.controlUi.dangerouslyDisableDeviceAuth\",\"value\":$DISABLE_DEVICE_AUTH}"
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

# --- FIRST-BOOT SEEDING (once, marker-gated, merge-only) ---
# Seeds the custom LLM provider and the main agent from template env on the
# FIRST start only. After that the config file is the single source of
# truth; template env changes to CUSTOM_LLM_* no longer overwrite it.
# To re-seed deliberately: delete .unraid-template-seeded and restart.
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
    SEED_BATCH="[{\"path\":\"models.providers.custom\",\"value\":$CUSTOM_PROVIDER}"
    SEED_BATCH="$SEED_BATCH,{\"path\":\"agents.list\",\"value\":[{\"id\":\"main\",\"model\":\"custom/$PRIMARY_MODEL\"}]}"
    SEED_BATCH="$SEED_BATCH]"

    echo "[bootstrap] first boot: seeding custom LLM provider + main agent (merge)"
    # --merge: merge-by-id on protected arrays (agents.list, provider
    # models). Existing entries survive; ours are added/updated. This is
    # what makes re-seeding after marker deletion safe too.
    if ! run_as_puid node /app/dist/index.js config set --merge --batch-json "$SEED_BATCH"; then
      echo "[bootstrap] FATAL: openclaw rejected the first-boot seed. See errors above." 1>&2
      echo "[bootstrap] batch-json was:" 1>&2
      echo "$SEED_BATCH" 1>&2
      exit 1
    fi
    date -u +"%Y-%m-%dT%H:%M:%SZ" > "$SEED_MARKER"
    chown "$PUID:$PGID" "$SEED_MARKER" 2>/dev/null || true
    echo "[bootstrap] seeded: custom LLM=$BASE_URL ($API_TYPE), models=[$CUSTOM_LLM_MODEL_ID], primary=custom/$PRIMARY_MODEL"
  fi
fi

# --- Drop privileges and exec gateway ---
echo "[bootstrap] dropping privileges to $PUID:$PGID and starting gateway"
exec setpriv --reuid="$PUID" --regid="$PGID" --init-groups \
  env HOME=/home/node PATH="$PATH" \
  node /app/dist/index.js gateway --bind lan
