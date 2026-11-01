#!/bin/sh
# Usage: DOCKER_CONTEXT=desktop-linux sh scripts/test-plugin-fuse-image.sh LOCAL_IMAGE
# Exit 1: qualified readiness regression; exit 2: fixture/infrastructure/cleanup error.
# Linux CI uses its default local socket. Never point this at Unraid.
set -eu
if [ "$#" -ne 1 ]; then
  echo 'usage: test-plugin-fuse-image.sh LOCAL_IMAGE' >&2
  exit 2
fi
fixtures=$(CDPATH= cd -- "$(dirname -- "$0")/fixtures" && pwd)
requested_host=${DOCKER_HOST:-}
requested_context=${DOCKER_CONTEXT:-}
container=
cleanup() {
  status=$?
  trap - EXIT
  if [ -n "$container" ]; then
    # Only the exact object created here, including its anonymous volumes.
    if ! docker_local rm -f -v "$container" >/dev/null; then status=2; fi
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
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' docker "$@"
)
docker_local() {
  # Every daemon operation, including cleanup, uses the one validated endpoint.
  docker_clean --host "$endpoint" "$@"
}
infra() { echo "PLUGIN FUSE INFRA ERROR: $*" >&2; exit 2; }
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
image_id=$(docker_local image inspect --format '{{.Id}}' "$1") || infra 'image must already exist locally; no pull is allowed'
printf '%s\n' "$image_id" | LC_ALL=C grep -Eq '^sha256:[a-f0-9]{64}$' || infra 'invalid image identity'
for fixture in run-plugin-fuse-smoke.sh plugin-fuse-readiness-regression.mjs; do
  test -r "$fixtures/$fixture" || infra "missing fixture $fixture"
done
# No host paths, home, checkout, credentials, ports or Docker socket are mounted.
# Keep the image HEALTHCHECK unchanged; this test's oracle is actual /readyz.
container=$(docker_local create --pull never --user 0:0 \
  --network bridge --device /dev/fuse --cap-add SYS_ADMIN \
  --security-opt apparmor=unconfined --entrypoint tini \
  "$image_id" -s -- sleep infinity) || infra 'cannot create local FUSE container'
docker_local start "$container" >/dev/null || infra 'cannot start fixture container'
docker_local exec "$container" mkdir -m 755 /opt/openclaw-plugin-regression || infra 'cannot create fixture destination'
for fixture in run-plugin-fuse-smoke.sh plugin-fuse-readiness-regression.mjs; do
  docker_local exec -i "$container" sh -ceu 'cat > "$1"; chmod 644 "$1"' \
    sh "/opt/openclaw-plugin-regression/$fixture" < "$fixtures/$fixture" || infra "cannot copy $fixture"
done
# Network is used only for disposable OS prerequisites, never for test traffic.
docker_local exec "$container" sh -ceu '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends bindfs fuse3
' || infra 'cannot install disposable FUSE prerequisites'
docker_local network disconnect bridge "$container" || infra 'cannot remove external networking'
printf 'PLUGIN FUSE IMAGE: %s\n' "$image_id"
status=0
docker_local exec "$container" sh /opt/openclaw-plugin-regression/run-plugin-fuse-smoke.sh || status=$?
case "$status" in
  0) echo 'PLUGIN FUSE IMAGE SMOKE OK' ;;
  1|2) exit "$status" ;;
  *) infra "fixture exec failed with status $status" ;;
esac
