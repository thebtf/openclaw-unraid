#!/bin/sh
# Update an installed OpenClaw container on Unraid to the latest (or specified) version.
#
# Refreshes both the upstream template (used by Add Container) and the stored
# `my-<Name>.xml` (used by Edit Container), preserving all user-filled values
# via merge-template.py.
#
# Usage:
#
#   # One-liner, auto-detect the container name:
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/thebtf/openclaw-unraid/master/scripts/update-on-unraid.sh)"
#
#   # Specific tag (env var):
#   OPENCLAW_TAG=v1.1.8 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/thebtf/openclaw-unraid/master/scripts/update-on-unraid.sh)"
#
#   # Specific container name (env var, overrides auto-detect):
#   OPENCLAW_NAME=MyOpenClaw /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/thebtf/openclaw-unraid/master/scripts/update-on-unraid.sh)"
#
# Then in Unraid Web UI: Docker -> <Name> -> Edit Container -> set any new fields
# the script reports (e.g. PUID/PGID after a major upgrade) -> Apply.

set -eu

TAG="${OPENCLAW_TAG:-master}"
NAME="${OPENCLAW_NAME:-}"

TEMPLATES_DIR=/boot/config/plugins/dockerMan/templates-user
RAW=https://raw.githubusercontent.com/thebtf/openclaw-unraid

UPSTREAM="$TEMPLATES_DIR/openclaw.xml"
SCRIPT=/tmp/openclaw-merge-template.py

if [ ! -d "$TEMPLATES_DIR" ]; then
  echo "FATAL: $TEMPLATES_DIR does not exist. Are you running this on an Unraid host?" 1>&2
  exit 1
fi

# --- Auto-detect installed container name if not provided ---
#
# We look for markers that are UNIQUE to thebtf/openclaw-unraid templates, not
# anything else built on the openclaw upstream image. Two independent fingerprints:
#   1. <Support>https://forums.unraid.net/topic/196865-...     (our forum thread)
#   2. <Icon>https://raw.githubusercontent.com/thebtf/openclaw-unraid/...  (our icon)
# Either one matching is enough; both lower false-positive risk vs other forks.
if [ -z "$NAME" ]; then
  MATCHES=$(grep -l -E 'forums\.unraid\.net/topic/196865-|raw\.githubusercontent\.com/thebtf/openclaw-unraid' \
    "$TEMPLATES_DIR"/my-*.xml 2>/dev/null || true)
  COUNT=$(printf '%s\n' "$MATCHES" | grep -c . || true)

  if [ "$COUNT" = "0" ]; then
    NAME=""  # leave empty -> first-install path below
  elif [ "$COUNT" = "1" ]; then
    base=$(basename "$MATCHES" .xml)
    NAME="${base#my-}"
    echo ">>> Auto-detected thebtf/openclaw-unraid container: $NAME"
  else
    echo "FATAL: multiple thebtf/openclaw-unraid containers found in $TEMPLATES_DIR:" 1>&2
    echo "$MATCHES" 1>&2
    echo "" 1>&2
    echo "Set OPENCLAW_NAME to the one you want to update, e.g.:" 1>&2
    echo "  OPENCLAW_NAME=MyOpenClaw /bin/bash -c \"\$(curl -fsSL $RAW/$TAG/scripts/update-on-unraid.sh)\"" 1>&2
    exit 1
  fi
fi

STORED=""
[ -n "$NAME" ] && STORED="$TEMPLATES_DIR/my-${NAME}.xml"

echo ">>> Fetching upstream template (tag=$TAG)..."
curl -fsSL "$RAW/$TAG/openclaw.xml" -o "$UPSTREAM"

echo ">>> Fetching merge-template.py..."
curl -fsSL "$RAW/$TAG/scripts/merge-template.py" -o "$SCRIPT"

if [ -n "$STORED" ] && [ -f "$STORED" ]; then
  echo ">>> Merging upstream into stored copy ($STORED)..."
  python3 "$SCRIPT" --stored "$STORED" --upstream "$UPSTREAM" --output "$STORED"
  echo ""
  echo "OK: stored template merged."
  echo "Open Unraid Web UI -> Docker -> $NAME -> Edit Container -> set any new fields shown above -> Apply."
else
  echo ""
  echo "OK: upstream template refreshed at $UPSTREAM."
  echo "No stored copy found -- container hasn't been added."
  echo "Add Container from the Unraid template dropdown to install OpenClaw for the first time."
fi
