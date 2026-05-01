#!/bin/sh
# OpenClaw Unraid template bootstrap.
# Embedded into openclaw.xml as base64 to bypass Unraid's PostArgs '<' / '>' stripping.
#
# Two-phase model:
#   PHASE 1 (root): usermod/groupmod node to PUID/PGID, one-shot chown of writable
#                   bind-mounts ONLY when ownership doesn't match, then `openclaw
#                   config set --batch-json` to apply managed config fields.
#   PHASE 2 (PUID): exec gateway via `setpriv --reuid --regid --init-groups`.
#
# Mount targets follow upstream image conventions: gateway runs as `node` user
# whose HOME is /home/node. Config lives at $HOME/.openclaw (= /home/node/.openclaw),
# matching the openclaw image expectation. No HOME hacks, no /root mount targets.
#
# No background loops, no recursive chown on a cron tick. Ownership is set ONCE
# at startup, then enforced naturally because the gateway runs as PUID:PGID and
# every file it creates inherits that ownership.
#
# User edits to non-managed sections (channels, agents, cron, tools) made via
# the Control UI are preserved across restarts (idempotent merge).

set -e

# --- PUID/PGID resolution (LinuxServer.io convention) ---
# Defaults: 99/100 = nobody/users on Unraid. Override via template fields.
PUID="${PUID:-99}"
PGID="${PGID:-100}"

# Validate numeric
case "$PUID" in
  ''|*[!0-9]*) echo "[bootstrap] FATAL: PUID='$PUID' must be numeric." 1>&2; exit 1 ;;
esac
case "$PGID" in
  ''|*[!0-9]*) echo "[bootstrap] FATAL: PGID='$PGID' must be numeric." 1>&2; exit 1 ;;
esac

# --- Re-map the in-image `node` user to host UID/GID ---
# `-o` (--non-unique) lets us use a UID/GID that may collide with another
# system user/group (e.g. GID 100 = `users` group already exists on Debian).
# This is the same approach used by linuxserver.io images.
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

# When the node user's UID/GID is remapped, files in the image that were owned
# by the OLD UID/GID (typically /app, /app/node_modules, /home/node) become
# orphaned. The remapped node user can no longer read/write them, so the
# gateway crashes during runtime-deps install or auth phase.
#
# Chown those paths to the new UID/GID. This is the same pattern linuxserver.io
# images use in their s6-overlay init scripts. Runs ONLY when remap actually
# happened (UID_CHANGED=1 or GID_CHANGED=1) -- subsequent starts skip this.
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

# --- Ensure required directories exist ---
# All paths under /home/node/* match upstream image conventions. The gateway runs
# as `node` user whose HOME is /home/node (per /etc/passwd from the image build).
mkdir -p /home/node/.openclaw /home/node/clawd /home/node/.local /tmp/openclaw

CFG=/home/node/.openclaw/openclaw.json

# --- One-shot ownership alignment (only when mismatch detected) ---
# Runs ONCE at container start. The gateway is then exec'd under PUID:PGID,
# so every file it creates is naturally owned PUID:PGID -- no loop needed.
#
# Override: set OPENCLAW_SKIP_OWNERSHIP_INIT=1 to skip this step entirely
# (useful if you manage ownership externally, e.g. via Unraid User Scripts).
# Two tiers of perm dirs:
#   DEEP_PERM_DIRS — small, openclaw-managed, must be fully consistent. Recursive
#     scan: chown -R if ANY file inside has wrong owner. Catches files left over
#     from previous template versions (e.g. devices/paired.json owned by root
#     because v1.1.0-1.1.3 wrote it as root before we switched to PUID/PGID).
#     /home/node/.openclaw is small (a few MB), recursive scan is fast.
#   SHALLOW_PERM_DIRS — potentially large (workspace, log archive, local pip
#     installs). Recursive find on a 100k-file tree is the chown-loop death
#     spiral we already escaped. Only check the mount root: if it matches PUID,
#     trust that the gateway (which runs as PUID) wrote everything correctly.
DEEP_PERM_DIRS="/home/node/.openclaw"
SHALLOW_PERM_DIRS="/home/node/clawd /home/node/.local /tmp/openclaw /home/linuxbrew /projects"

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
# OpenClaw uses a filesystem lock to serialize bundled-deps mirroring across
# parallel gateway processes. Lock dir contains owner.json with the holder PID.
# When a previous container crash leaves the lock behind, the next start waits
# 5 minutes for the lock and then exits with SECRETS_RELOADER_DEGRADED, looping.
#
# Detect stale locks: owner.json says pid=N, but no such process is alive in
# our pid namespace -> nuke the lock dir. Safe because we run inside a single
# container, no other gateway can hold a live lock here.
LOCKS_GLOB=/home/node/.openclaw/plugin-runtime-deps/*/.openclaw-runtime-mirror.lock
for lock_dir in $LOCKS_GLOB; do
  [ -d "$lock_dir" ] || continue
  owner_file="$lock_dir/owner.json"
  if [ ! -f "$owner_file" ]; then
    echo "[bootstrap] removing lock without owner.json: $lock_dir"
    rm -rf "$lock_dir" 2>/dev/null || true
    continue
  fi
  # Extract pid (sed beats jq dependency: owner.json is small and stable)
  owner_pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$owner_file" | head -1)
  if [ -z "$owner_pid" ] || [ ! -d "/proc/$owner_pid" ]; then
    echo "[bootstrap] removing stale lock (owner pid=$owner_pid not alive): $lock_dir"
    rm -rf "$lock_dir" 2>/dev/null || true
  fi
done

# --- Validate required env ---
if [ -z "$OPENCLAW_ALLOWED_ORIGINS" ]; then
  echo "[bootstrap] FATAL: OPENCLAW_ALLOWED_ORIGINS is required (e.g. http://192.168.1.41:18789)." 1>&2
  exit 1
fi

if [ -n "$CUSTOM_LLM_BASE_URL" ]; then
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
  if [ -z "$CUSTOM_LLM_MODEL_ID" ]; then
    echo "[bootstrap] FATAL: CUSTOM_LLM_MODEL_ID is required when CUSTOM_LLM_BASE_URL is set (e.g. gpt-5.5, llama-3.1-70b, claude-3-opus). Comma-separated for multiple." 1>&2
    exit 1
  fi
fi

# Normalize boolean env (true/1/yes -> true, anything else -> false)
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

# CSV of model ids -> JSON array of model objects, including reasoning flag.
# Context window and max output tokens come from env so users can match their
# actual model parameters.
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

# --- Build batch-json for `openclaw config set` ---
BATCH='['
BATCH="$BATCH{\"path\":\"gateway.mode\",\"value\":\"local\"}"
BATCH="$BATCH,{\"path\":\"gateway.bind\",\"value\":\"lan\"}"
BATCH="$BATCH,{\"path\":\"gateway.controlUi.allowInsecureAuth\",\"value\":true}"
BATCH="$BATCH,{\"path\":\"gateway.controlUi.dangerouslyDisableDeviceAuth\",\"value\":$DISABLE_DEVICE_AUTH}"
BATCH="$BATCH,{\"path\":\"gateway.controlUi.allowedOrigins\",\"value\":[$ORIGINS_JSON]}"
BATCH="$BATCH,{\"path\":\"gateway.auth.mode\",\"value\":\"token\"}"

# Logging: openclaw 2026.4 namespaces by gateway instance ("/tmp/openclaw-0/" not
# "/tmp/openclaw/"), so we pin logging.file explicitly to a stable path inside
# our mounted /tmp/openclaw to keep logs on the host volume. logging.file works
# again as of openclaw 2026.4+ (issue #61295 closed).
LOG_MAX_BYTES="${OPENCLAW_LOG_MAX_FILE_BYTES:-104857600}"
BATCH="$BATCH,{\"path\":\"logging.maxFileBytes\",\"value\":$LOG_MAX_BYTES}"
BATCH="$BATCH,{\"path\":\"logging.file\",\"value\":\"/tmp/openclaw/openclaw.log\"}"

if [ -n "$CUSTOM_LLM_BASE_URL" ]; then
  BASE_URL=$(echo "$CUSTOM_LLM_BASE_URL" | sed 's:/*$::')
  MODELS_JSON=$(csv_to_model_objects "$CUSTOM_LLM_MODEL_ID")
  CUSTOM_PROVIDER="{\"baseUrl\":\"$BASE_URL\",\"apiKey\":\"\${CUSTOM_LLM_API_KEY}\",\"api\":\"$API_TYPE\",\"models\":[$MODELS_JSON]}"
  BATCH="$BATCH,{\"path\":\"models.mode\",\"value\":\"merge\"}"
  BATCH="$BATCH,{\"path\":\"models.providers.custom\",\"value\":$CUSTOM_PROVIDER}"

  # Pin agent primary model to the first custom model so plugin auto-enable
  # doesn't silently swap primary to a different namespace (e.g. openai/gpt-5.5
  # when the openai-image plugin auto-enables and creates models.providers.openai
  # with the same model id but default contextWindow=200000 from the openai
  # namespace, ignoring our custom provider's contextWindow=1050000).
  PRIMARY_MODEL=$(echo "$CUSTOM_LLM_MODEL_ID" | awk -F, '{
    v=$1; gsub(/^[ \t]+|[ \t]+$/, "", v); print v
  }')
  BATCH="$BATCH,{\"path\":\"agents.list\",\"value\":[{\"id\":\"main\",\"model\":\"custom/$PRIMARY_MODEL\"}]}"
fi

BATCH="$BATCH]"

# --- Apply via openclaw native CLI (handles merge + schema validation) ---
echo "[bootstrap] applying config via openclaw config set"
# `openclaw config set` resolves the config path via `os.userInfo().homedir`
# under the EUID it's running as. We're root here, so it would target
# /root/.openclaw/openclaw.json -- but our mount is /home/node/.openclaw.
# Pass HOME=/home/node explicitly so config set writes to the right place.
if ! HOME=/home/node node dist/index.js config set --batch-json "$BATCH"; then
  echo "[bootstrap] FATAL: openclaw rejected the config update. See errors above." 1>&2
  echo "[bootstrap] batch-json was:" 1>&2
  echo "$BATCH" 1>&2
  exit 1
fi

# Re-chown openclaw.json after config set rewrites it (atomic-write pattern
# replaces inode; fresh inode inherits root because we're still root here).
chown "$PUID:$PGID" "$CFG" 2>/dev/null || true

echo "[bootstrap] config applied: origins=[$ORIGINS_JSON], disableDeviceAuth=$DISABLE_DEVICE_AUTH, logMaxBytes=$LOG_MAX_BYTES${CUSTOM_LLM_BASE_URL:+, custom LLM=$BASE_URL ($API_TYPE), models=[$CUSTOM_LLM_MODEL_ID], reasoning=$CUSTOM_LLM_REASONING, primary=custom/$PRIMARY_MODEL}"

# --- Drop privileges and exec gateway ---
# `setpriv --init-groups` reads supplementary groups for the new UID from /etc/group.
# HOME is left to /etc/passwd default for `node` (= /home/node), matching where
# the Config Path mount lands. No HOME override needed.
echo "[bootstrap] dropping privileges to $PUID:$PGID and starting gateway"
exec setpriv --reuid="$PUID" --regid="$PGID" --init-groups \
  env HOME=/home/node PATH="$PATH" \
  node dist/index.js gateway --bind lan
