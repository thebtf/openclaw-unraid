#!/bin/sh
# Usage: DOCKER_CONTEXT=desktop-linux sh scripts/test-media-fuse-image.sh IMAGE
# Linux CI uses the default local Docker context. Never point this at Unraid.
set -eu
if [ "$#" -ne 1 ]; then
  echo 'usage: test-media-fuse-image.sh LOCAL_IMAGE' >&2
  exit 2
fi
fixtures=$(CDPATH= cd -- "$(dirname -- "$0")/fixtures" && pwd)
context=${DOCKER_CONTEXT:-default}
docker_local() {
  # Preserve Linux container paths when Git Bash launches the Windows Docker CLI.
  # These overrides apply only to this Docker process, never the caller's shell.
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' docker --context "$context" "$@"
}
endpoint=$(docker_local context inspect "$context" --format '{{.Endpoints.docker.Host}}')
case "$endpoint" in
  unix://*|npipe://*) ;;
  *) echo 'MEDIA FUSE SMOKE FAIL: a local Docker socket context is required' >&2; exit 1 ;;
esac
image_id=$(docker_local image inspect --format '{{.Id}}' "$1")
printf '%s\n' "$image_id" | LC_ALL=C grep -Eq '^sha256:[a-f0-9]{64}$' || {
  echo 'MEDIA FUSE SMOKE FAIL: invalid local image identity' >&2
  exit 1
}
container=
cleanup() {
  status=$?
  trap - EXIT
  if [ -n "$container" ]; then
    # Only this invocation's exact container and its anonymous volumes.
    if ! docker_local rm -f -v "$container" >/dev/null; then status=1; fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# No checkout/home/socket mounts, host environment forwarding or registry auth.
# Missing /dev/fuse or mount capability is a failure, never a simulated PASS.
container=$(docker_local create --pull never --user 0:0 --no-healthcheck \
  --network bridge --device /dev/fuse --cap-add SYS_ADMIN \
  --security-opt apparmor=unconfined --entrypoint /bin/sh \
  "$image_id" -c 'exec sleep infinity')
docker_local start "$container" >/dev/null
docker_local exec "$container" mkdir -m 755 /opt/openclaw-media-regression
for fixture in run-media-fuse-smoke.sh media-fuse-handoff-regression.mjs media-store-fuse-smoke.mjs media-store-native-mode-smoke.mjs; do
  # Stream only these public synthetic test sources, never the whole checkout.
  docker_local exec -i "$container" sh -ceu 'cat > "$1"; chmod 644 "$1"' \
    sh "/opt/openclaw-media-regression/$fixture" < "$fixtures/$fixture"
done
# Tools are disposable container additions; /app and its dependency stay intact.
# This is the only networked preparation; tests run after disconnection as well
# as inside fresh network namespaces. No production entrypoint or healthcheck runs.
docker_local exec "$container" sh -ceu '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends bindfs fuse3
'
docker_local network disconnect bridge "$container"
printf 'MEDIA FUSE SMOKE IMAGE: %s\n' "$image_id"
docker_local exec "$container" sh /opt/openclaw-media-regression/run-media-fuse-smoke.sh
echo 'MEDIA FUSE IMAGE SMOKE OK'
