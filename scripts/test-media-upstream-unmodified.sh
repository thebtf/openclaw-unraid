#!/bin/sh
# Usage: DOCKER_CONTEXT=desktop-linux sh scripts/test-media-upstream-unmodified.sh
# Classifier regression only: never use this historical image as a candidate.
# Keep all six real media FUSE suites on the actual candidate image.
set -eu
if [ "$#" -ne 0 ]; then
  echo 'usage: test-media-upstream-unmodified.sh' >&2
  exit 2
fi
scripts=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Audited official 2026.10.9 OCI index; select its linux/amd64 image locally.
# No tag/input override: future upstream candidates are not this fixture source.
audited_image=ghcr.io/openclaw/openclaw@sha256:1a2a3ce113e435039dbeac5ae261759bb4759908563d91c81059e896b38c5d98
requested_host=${DOCKER_HOST:-}
requested_context=${DOCKER_CONTEXT:-}
container=
cleanup() {
  status=$?
  trap - EXIT
  trap '' HUP INT TERM
  if [ -n "$container" ]; then
    # Remove only this invocation's exact container; keep all images and volumes.
    if ! docker_local rm -f "$container" >/dev/null; then
      echo 'MEDIA CLASSIFICATION INFRA ERROR: cannot remove fixture container' >&2
      status=2
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
docker_clean() (
  # Preserve context configuration, but never inherit competing daemon routes/TLS.
  unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH BASH_ENV ENV
  # Preserve Linux container paths under Windows Git Bash, for this process only.
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' docker "$@"
)
docker_local() {
  # Every daemon operation, including pull and cleanup, uses the validated socket.
  docker_clean --host "$endpoint" "$@"
}
infra() { echo "MEDIA CLASSIFICATION INFRA ERROR: $*" >&2; exit 2; }
command -v docker >/dev/null || infra 'missing Docker CLI'
if [ -n "$requested_host" ] && [ -n "$requested_context" ]; then
  infra 'ambiguous Docker routing: set only one of DOCKER_HOST or DOCKER_CONTEXT'
fi
if [ -n "$requested_host" ]; then
  endpoint=$requested_host
else
  context=$requested_context
  if [ -z "$context" ]; then
    context=$(docker_clean context show) || infra 'cannot resolve current Docker context'
  fi
  test -n "$context" || infra 'empty Docker context'
  endpoint=$(docker_clean --context "$context" context inspect "$context" --format '{{.Endpoints.docker.Host}}') || infra 'cannot inspect Docker context'
fi
# Reject authorities, remote named pipes, encoded aliases and URI suffixes.
case "$endpoint" in
  *[[:cntrl:]]*|*\\*|*'%'*|*'?'*|*'#'*) infra 'invalid local Docker endpoint URI' ;;
esac
case "$endpoint" in
  unix:///?*)
    socket_path=${endpoint#unix://}
    case "$socket_path" in //*) infra 'Unix socket must have an absolute local path without an authority' ;; esac
    ;;
  npipe:////./pipe/?*)
    pipe_name=${endpoint#npipe:////./pipe/}
    case "$pipe_name" in */*|.|..) infra 'a single local named-pipe name is required' ;; esac
    ;;
  *) infra 'only an absolute local Unix socket or npipe:////./pipe/<name> is allowed' ;;
esac
for source in build-openclaw-media-fuse-adapter.mjs fixtures/media-upstream-unmodified-regression.mjs; do
  test -r "$scripts/$source" || infra "missing source $source"
done
# Pull only the immutable public source, and only when it is not already local.
if ! image_id=$(docker_local image inspect --format '{{.Id}}' "$audited_image" 2>/dev/null); then
  docker_local pull --platform linux/amd64 "$audited_image" >/dev/null || infra 'cannot pull audited upstream manifest'
  image_id=$(docker_local image inspect --format '{{.Id}}' "$audited_image") || infra 'cannot inspect audited upstream image'
fi
# Docker image stores can report different .Id forms for this same OCI source.
# Use the inspected local identity, never a hardcoded manifest-as-config digest.
printf '%s\n' "$image_id" | LC_ALL=C grep -Eq '^sha256:[a-f0-9]{64}$' || infra 'invalid audited upstream local image identity'
platform=$(docker_local image inspect --format '{{.Os}}/{{.Architecture}}' "$audited_image") || infra 'cannot inspect audited upstream platform'
[ "$platform" = linux/amd64 ] || infra 'audited upstream source must be linux/amd64'
# No checkout/home/socket mounts, host environment, credentials or network.
# The original /app sources remain untouched; the fixture uses private /tmp copies.
container=$(docker_local create --platform linux/amd64 --pull never --user 0:0 \
  --network none --no-healthcheck --entrypoint /bin/sh \
  "$image_id" -c 'exec sleep infinity') || infra 'cannot create local classification container'
container_image=$(docker_local container inspect --format '{{.Image}}' "$container") || infra 'cannot inspect classification container image'
[ "$container_image" = "$image_id" ] || infra 'classification container image identity mismatch'
docker_local start "$container" >/dev/null || infra 'cannot start classification container'
docker_local exec "$container" mkdir -p -m 755 /opt/openclaw-media-regression/scripts/fixtures || infra 'cannot create fixture destination'
for source in build-openclaw-media-fuse-adapter.mjs fixtures/media-upstream-unmodified-regression.mjs; do
  # Stream only these two sources, preserving their relative scripts paths.
  docker_local exec -i "$container" sh -ceu 'cat > "$1"; chmod 644 "$1"' \
    sh "/opt/openclaw-media-regression/scripts/$source" < "$scripts/$source" || infra "cannot copy $source"
done
printf 'MEDIA CLASSIFICATION UPSTREAM: %s (%s)\n' "$audited_image" "$image_id"
docker_local exec "$container" node /opt/openclaw-media-regression/scripts/fixtures/media-upstream-unmodified-regression.mjs
