#!/bin/sh
# OpenClaw Unraid template bootstrap.
# Embedded into openclaw.xml as base64 to bypass Unraid's PostArgs '<' / '>' stripping.
#
# Idempotent: re-runs on every container start, merges managed fields
# (controlUi.allowedOrigins, models.providers.custom) via the native
# `openclaw config set --batch-json` command. Schema validation and merge
# semantics are handled by openclaw itself, not by us.
#
# User edits to other sections (channels, agents, cron, tools) made via
# the Control UI are preserved.

set -e

mkdir -p /root/.openclaw /home/linuxbrew /tmp/openclaw
CFG=/root/.openclaw/openclaw.json

# --- Host-side visibility (generic: SMB on Unraid, NFS, etc.) ---
# Container runs as root, so files written under bind-mounts would default to owner=root,
# group=root, mode 0600 -- invisible/unwritable to the host user.
#
# Generic fix without hardcoding any UID/GID:
#   1. umask 0002 -- new files default to 0664, dirs to 0775
#   2. chmod g+s on dirs -- new files inherit GID from the parent directory (setgid bit)
#   3. chmod -R g+rwX on existing files -- old root-owned files become group-readable/writable
#
# The bootstrap does NOT chown or chgrp -- the host owner/group is whatever you set on
# /mnt/user/appdata/openclaw/* once. Whatever GID you put there is what new files inherit,
# regardless of value. To preserve existing ownership, run on the host one-time:
#   chown -R YOUR_HOST_UID:YOUR_HOST_GID /mnt/user/appdata/openclaw
# (e.g. on Unraid: 99:100 = nobody:users by default; on other hosts use whatever you need.)
#
# Override: set OPENCLAW_SKIP_PERM_FIX=1 if you manage permissions externally and don't want
# the bootstrap touching them.
if [ "${OPENCLAW_SKIP_PERM_FIX:-0}" != "1" ]; then
  umask 0002
  for dir in /root/.openclaw /home/node/clawd /tmp/openclaw /root/.local; do
    [ -d "$dir" ] || continue
    # Align ownership of everything inside the mount with the mount-point itself.
    # That way old root-owned leftovers (created by previous container starts before
    # the perm fix existed) get rewritten to whatever the host put on the parent dir.
    # No hardcoded UID/GID -- chown --reference reads from the live mount root.
    chown -R --reference="$dir" "$dir" 2>/dev/null || true
    chmod -R g+rwX,o+rX "$dir" 2>/dev/null || true
    find "$dir" -type d -exec chmod g+s {} + 2>/dev/null || true
  done
  echo "[bootstrap] applied generic perm fix: chown --reference + umask 0002 + setgid on dirs"
fi

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

# --- Build comma-separated values into JSON arrays ---
# CSV with whitespace and trailing-slash trimming, returns a comma-separated
# list of JSON strings (no surrounding brackets).
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

# CSV of model ids -> JSON array of model objects.
csv_to_model_objects() {
  echo "$1" | awk -F, '{
    out=""
    for (i=1; i<=NF; i++) {
      v=$i
      gsub(/^[ \t]+|[ \t]+$/, "", v)
      if (v != "") {
        obj="{\"id\":\"" v "\",\"name\":\"" v "\",\"contextWindow\":128000,\"maxTokens\":32000}"
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

# Note: openclaw logs always go to /tmp/openclaw/openclaw-YYYY-MM-DD.log -- logging.file
# is currently ignored by the runtime (https://github.com/openclaw/openclaw/issues/61295).
# So we mount /tmp/openclaw directly to a host volume instead of trying to relocate via config.
# Built-in rotation: 100 MB per file, 5 numbered archives kept = ~600 MB cap.
# logging.maxFileBytes is the only documented size knob; logging.maxFiles is NOT in the schema.
LOG_MAX_BYTES="${OPENCLAW_LOG_MAX_FILE_BYTES:-26214400}"
BATCH="$BATCH,{\"path\":\"logging.maxFileBytes\",\"value\":$LOG_MAX_BYTES}"

if [ -n "$CUSTOM_LLM_BASE_URL" ]; then
  BASE_URL=$(echo "$CUSTOM_LLM_BASE_URL" | sed 's:/*$::')
  MODELS_JSON=$(csv_to_model_objects "$CUSTOM_LLM_MODEL_ID")
  CUSTOM_PROVIDER="{\"baseUrl\":\"$BASE_URL\",\"apiKey\":\"\${CUSTOM_LLM_API_KEY}\",\"api\":\"$API_TYPE\",\"models\":[$MODELS_JSON]}"
  BATCH="$BATCH,{\"path\":\"models.mode\",\"value\":\"merge\"}"
  BATCH="$BATCH,{\"path\":\"models.providers.custom\",\"value\":$CUSTOM_PROVIDER}"
fi

BATCH="$BATCH]"

# --- Apply via openclaw native CLI (handles merge + schema validation) ---
echo "[bootstrap] applying config via openclaw config set"
if ! node dist/index.js config set --batch-json "$BATCH"; then
  echo "[bootstrap] FATAL: openclaw rejected the config update. See errors above." 1>&2
  echo "[bootstrap] batch-json was:" 1>&2
  echo "$BATCH" 1>&2
  exit 1
fi

echo "[bootstrap] config applied: origins=[$ORIGINS_JSON], disableDeviceAuth=$DISABLE_DEVICE_AUTH, logMaxBytes=$LOG_MAX_BYTES${CUSTOM_LLM_BASE_URL:+, custom LLM=$BASE_URL ($API_TYPE), models=[$CUSTOM_LLM_MODEL_ID]}"

# Run gateway. We do NOT use `exec` so that we can log the exit reason -- otherwise
# the container disappears with no clue why. Docker's --restart=unless-stopped policy
# (set in the template's ExtraParams) handles the actual restart on exit.
echo "[bootstrap] starting gateway"
node dist/index.js gateway --bind lan
RC=$?
echo "[bootstrap] gateway exited with rc=$RC -- container will be restarted by docker (unless stopped manually)"
exit $RC
