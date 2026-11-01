#!/bin/sh
# Container-only runner. Missing real FUSE is an error, never a skipped RED.
set -eu
fixtures=/opt/openclaw-plugin-regression
root=
fixture_status=
cleanup() {
  status=$?
  trap - EXIT
  # A shell/setup failure must not look like the intended readiness failure.
  if [ -z "$fixture_status" ]; then status=2; fi
  if [ -n "$root" ]; then
    if mountpoint -q "$root/fuse"; then
      if ! fusermount3 -u "$root/fuse"; then status=2; fi
    fi
    if mountpoint -q "$root/fuse"; then
      echo 'PLUGIN FUSE INFRA ERROR: FUSE mount remains; refusing mounted-tree cleanup' >&2
      exit 2
    fi
    # Only this invocation's generated trees, after all Gateway processes close.
    if ! rm -rf -- "$root/normal" "$root/backing"; then status=2; fi
    if ! rmdir "$root/fuse" "$root"; then status=2; fi
    if test -e "$root"; then status=2; fi
  fi
  if [ "$status" -eq 2 ]; then echo 'PLUGIN FUSE INFRA ERROR: setup, fixture or cleanup failed' >&2; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
for command in bindfs fusermount3 mountpoint setpriv node timeout; do
  command -v "$command" >/dev/null || { echo "PLUGIN FUSE INFRA ERROR: missing $command" >&2; exit 2; }
done
test -c /dev/fuse || { echo 'PLUGIN FUSE INFRA ERROR: /dev/fuse unavailable' >&2; exit 2; }
root=$(mktemp -d /tmp/openclaw-plugin-fuse.XXXXXX)
chmod 711 "$root"
mkdir -m 700 "$root/normal" "$root/backing" "$root/fuse"
chown 1026:100 "$root/normal" "$root/backing"
bindfs -o allow_other,attr_timeout=0,entry_timeout=0,negative_timeout=0 "$root/backing" "$root/fuse"
mountpoint -q "$root/fuse" || { echo 'PLUGIN FUSE INFRA ERROR: bindfs did not mount' >&2; exit 2; }
bindfs --version
# The independent watchdog is not the readiness oracle. Its expiry is exit 2.
# The Node observer remains outside the Gateway's event loop and process group.
# Includes up to 90 s registration-only observation after a missed readiness
# deadline, plus orderly shutdown of each scenario; never extends readiness.
fixture_status=0
timeout --signal=TERM --kill-after=10s 600s \
  setpriv --reuid=1026 --regid=100 --clear-groups \
  node "$fixtures/plugin-fuse-readiness-regression.mjs" "$root/normal" "$root/fuse" || fixture_status=$?
case "$fixture_status" in
  0|1|2) ;;
  *) echo "PLUGIN FUSE INFRA ERROR: observer exited $fixture_status" >&2; fixture_status=2 ;;
esac
exit "$fixture_status"
