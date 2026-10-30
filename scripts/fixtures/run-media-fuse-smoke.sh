#!/bin/sh
# Container-only runner; the host wrapper supplies only the synthetic fixtures.
set -eu
fixtures=/opt/openclaw-media-regression
test -c /dev/fuse || { echo 'MEDIA FUSE SMOKE FAIL: /dev/fuse is unavailable' >&2; exit 1; }
for command in bindfs fusermount3 mountpoint unshare setpriv node; do
  command -v "$command" >/dev/null || { echo "MEDIA FUSE SMOKE FAIL: missing $command" >&2; exit 1; }
done
root=$(mktemp -d /tmp/openclaw-media-fuse.XXXXXX)
cleanup() {
  status=$?
  trap - EXIT
  if mountpoint -q "$root/mount"; then
    if ! fusermount3 -u "$root/mount"; then status=1; fi
  fi
  if mountpoint -q "$root/mount"; then
    echo 'MEDIA FUSE SMOKE FAIL: FUSE mount remains' >&2
    exit 1
  fi
  # Refuse cleanup success if any fixture left data behind; never hide residue.
  if ! rmdir "$root/mount" "$root/backing" "$root"; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 711 "$root"
mkdir -m 700 "$root/backing" "$root/mount"
chown 1026:100 "$root/backing"
bindfs -o allow_other,attr_timeout=0,entry_timeout=0,negative_timeout=0 "$root/backing" "$root/mount"
mountpoint -q "$root/mount" || { echo 'MEDIA FUSE SMOKE FAIL: bindfs did not mount' >&2; exit 1; }
run_node() {
  unshare --net setpriv --reuid=1026 --regid=100 --clear-groups node "$@"
}
run_node -e 'const a=require("node:assert/strict"); a.equal(process.getuid(),1026); a.equal(process.getgid(),100);'
sha256sum "$fixtures/media-fuse-handoff-regression.mjs" "$fixtures/media-store-fuse-smoke.mjs" "$fixtures/media-store-native-mode-smoke.mjs"
# The unchanged low-level fixture first calibrates the actual deferred-unlink
# semantics (including .fuse_hidden and link counts). The real-FUSE consumer
# refuses a non-FUSE root, so losing mount capability cannot skip this gate.
run_node "$fixtures/media-fuse-handoff-regression.mjs"
run_node "$fixtures/media-fuse-handoff-regression.mjs" --real-fuse-root "$root/mount"
run_node "$fixtures/media-store-fuse-smoke.mjs" "$root/mount"
run_node "$fixtures/media-store-native-mode-smoke.mjs"
run_node "$fixtures/media-store-native-mode-smoke.mjs" "$root/mount"
echo 'MEDIA FUSE SMOKE: all five suites passed as 1026:100'
