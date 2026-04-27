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

exec node dist/index.js gateway --bind lan
