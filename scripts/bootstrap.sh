#!/bin/sh
# OpenClaw Unraid template bootstrap.
# Embedded into openclaw.xml as base64 to bypass Unraid's PostArgs '<' / '>' stripping.
# Generates /root/.openclaw/openclaw.json on first start from env vars, then execs the gateway.

set -e

mkdir -p /root/.openclaw /home/linuxbrew
CFG=/root/.openclaw/openclaw.json

if [ ! -s "$CFG" ]; then
  if [ -z "$OPENCLAW_ALLOWED_ORIGINS" ]; then
    echo "[bootstrap] FATAL: OPENCLAW_ALLOWED_ORIGINS is required (e.g. http://192.168.1.41:18789)." 1>&2
    exit 1
  fi

  # Comma-separated origins -> JSON array of strings.
  # Trim whitespace and trailing slashes from each value.
  ORIGINS_JSON=$(echo "$OPENCLAW_ALLOWED_ORIGINS" | awk -F, '{
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
  }')

  LLM_BLOCK=""
  if [ -n "$CUSTOM_LLM_BASE_URL" ]; then
    API_TYPE="${CUSTOM_LLM_API_TYPE:-openai-completions}"
    BASE_URL=$(echo "$CUSTOM_LLM_BASE_URL" | sed 's:/*$::')
    LLM_BLOCK=",\"models\":{\"mode\":\"merge\",\"providers\":{\"custom\":{\"baseUrl\":\"$BASE_URL\",\"apiKey\":\"\${CUSTOM_LLM_API_KEY}\",\"api\":\"$API_TYPE\"}}}"
  fi

  printf '%s' "{\"gateway\":{\"mode\":\"local\",\"bind\":\"lan\",\"controlUi\":{\"allowInsecureAuth\":true,\"allowedOrigins\":[$ORIGINS_JSON]},\"auth\":{\"mode\":\"token\"}}$LLM_BLOCK}" > "$CFG"
  echo "[bootstrap] wrote $CFG (origins=[$ORIGINS_JSON]${CUSTOM_LLM_BASE_URL:+, custom LLM=$BASE_URL})"
fi

exec node dist/index.js gateway --bind lan
