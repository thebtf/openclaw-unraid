# openclaw-unraid derived image.
#
# WHY A DERIVED IMAGE (v2.0.0): the v1.x template shipped its bootstrap as a
# 20 KB base64 blob inside <PostArgs> and overrode the vanilla image with
# `--user root --entrypoint /bin/sh`. That worked, but the script was
# unreviewable, unversioned relative to the image, and its per-start config
# seeding fought with runtime config ownership (see CHANGELOG v2.0.0).
# This image bakes the same logic as a proper, reviewable entrypoint script.
#
# The upstream image stays untouched underneath: node:24-bookworm-slim,
# tini as PID 1, gateway code in /app. We only add the Unraid adaptation
# layer: PUID/PGID remap + one-shot chown + first-boot config seeding,
# then drop privileges to PUID:PGID and exec the gateway (linuxserver.io
# init-as-root -> run-as-user model).
#
# Build args:
#   OPENCLAW_TAG - upstream tag to derive from (default: latest)

ARG OPENCLAW_TAG=latest
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_TAG}

# Canonical OpenClaw runtime contract. These paths are image-owned rather
# than template inputs, so upstream CLI and gateway processes resolve the
# same home, state, configuration, and workspace locations.
ENV HOME=/home/node \
  OPENCLAW_HOME=/home/node \
  OPENCLAW_STATE_DIR=/home/node/.openclaw \
  OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
  OPENCLAW_CONFIG_DIR=/home/node/.openclaw \
  OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace

# The entrypoint needs root for usermod/groupmod/chown at startup.
# Privileges are dropped to PUID:PGID via setpriv before the gateway starts;
# usermod (passwd) and setpriv (util-linux) are already present in the
# upstream bookworm base — no extra packages.
USER root

COPY docker/unraid-entrypoint.sh /usr/local/bin/unraid-entrypoint.sh
RUN chmod 755 /usr/local/bin/unraid-entrypoint.sh

# mcporter: MCP-client CLI consumed by the bundled `mcporter` skill
# (/app/skills/mcporter requires the `mcporter` bin). Baked into the image so
# per-agent MCP servers (config/mcporter.json in each workspace) survive
# container recreation — a runtime `npm i -g` lands in the overlay and is lost
# on every image update.
RUN npm install -g mcporter && mcporter --version

# Keep upstream tini as PID 1; our script replaces only the CMD layer.
ENTRYPOINT ["tini", "-s", "--", "/usr/local/bin/unraid-entrypoint.sh"]
CMD []

LABEL org.opencontainers.image.title="OpenClaw for Unraid" \
  org.opencontainers.image.source="https://github.com/thebtf/openclaw-unraid" \
  org.opencontainers.image.description="OpenClaw gateway with Unraid PUID/PGID support and first-boot config seeding" \
  org.opencontainers.image.base.name="ghcr.io/openclaw/openclaw"
