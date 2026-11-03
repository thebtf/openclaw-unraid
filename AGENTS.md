# OpenClaw for Unraid: project contract

## Product boundary

This repository adapts the official `ghcr.io/openclaw/openclaw` image for Unraid. It is a thin packaging and startup layer, not a fork or an effort to improve OpenClaw itself. Upstream application behavior should remain upstream behavior.

Our responsibilities are the Unraid template, persistent paths and environment variables, PUID/PGID and filesystem access, necessary container startup wiring, and safe delivery of upstream image updates. Optional tooling must have an established project requirement; it is not permission to redesign application internals.

Do not patch OpenClaw's private bundles, replace its dependencies, optimize its memory/plugin engines, or edit database rows to make a test pass. If a concrete upstream defect cannot be addressed through supported configuration or host/image setup, establish the defect and present the available upstream/configuration/environment options. Do not silently turn the image into another implementation. Existing compatibility code or experimental work is evidence to assess, not blanket authority to extend it or delete it.

## Following upstream

Before adopting an upstream image change, and periodically while this image follows upstream, inspect the actual release/image changes that can affect this wrapper: base image and architecture, `USER`/entrypoint/command, UID/GID and permissions, persistent paths, configuration/environment contracts, logging, and documented state-upgrade requirements. Record the upstream version/digest, downstream source/build identity and installed image separately; an inherited OCI label is not proof of our source revision.

Use `Dockerfile`, `docker/unraid-entrypoint.sh`, `openclaw.xml`, `docker-compose.yml` and `.github/workflows/build-image.yml` as the maintained implementation owners. Read the affected portions before changing their behavior. Keep version-specific findings, incidents and current results out of this file.

The existing image workflow owns upstream-digest tracking, candidate validation and publication. Investigate a failed update at its first concrete failure. Do not bypass an unsafe update check, but do not invent an expanding test framework or private-API compatibility project either. A new synthetic failure is not automatically the cause of the real Unraid incident.

## Incident diagnosis

Start with the exact failed user operation, installed image identity, timestamp and error. Establish the operation/call and boundary that fail before selecting a repair. Separate wrapper defects, upstream behavior, configuration/data problems and host-specific resource/filesystem constraints.

Check relevant evidence, not a random matrix of builds: effective PUID/PGID, actual mounts and permissions, storage/filesystem behavior, available resources and the limits used by the failing process. Free RAM, swap usage, a filesystem percentage or a configured limit alone does not prove exhaustion. Preserve data and compare vanilla behavior at the same relevant boundary when that comparison can decide the cause.

Prefer supported image/application settings and host-configuration proposals to application-code changes. Explain why any proposed cleanup or limit increase addresses the observed failure; examples of possible remedies are not permission to execute them. Reuse the shortest existing check or bounded reproducer that measures the affected behavior. A repeated failure under an unchanged approach requires a discriminating source check or a different evidence-based approach, not another speculative build.

Keep native upgrade/data compatibility separate from optional optimization. When existing persisted state needs an upgrade, use the supported upstream migration route and verified preservation/backup requirements; do not remove compatibility safeguards or force schema versions merely to restore startup.

## Unraid storage and production

Use Unraid's logical user-share model by default. Pinning `/mnt/user/...` to `/mnt/diskN/...` is an operator-selected temporary diagnostic/recovery workaround, not the product's final design or proof of user-share compatibility. Do not copy or move data between these two views as if they were independent datasets.

Tests, candidate images and synthetic containers belong on this workstation's local Docker Desktop (`desktop-linux`), never on production Unleashed. Keep each test resource tied to its actual consumer and finish only our spent resources; do not clean unrelated containers, images or data.

On production Unleashed, operations are read-only except for the user's standing permission to restart the existing container or invoke the official update mechanism if Watchtower stalls. Do not write configuration, templates, queues or databases; pull/run arbitrary images; create or manually replace containers; or replay user messages. Do not write to Engram/Plane hosted there as a workaround for this boundary.

Production delivery is a verified release of our `:latest` tag followed by Watchtower or the explicitly permitted official update route. Commit, build success, Docker health or one readiness response alone does not establish that the affected bot/file/memory operation works. Do not claim a release or original-file recovery without the corresponding evidence.

## Directive provenance

The product boundary and upstream/incident method above were explicitly restated by the repository owner on 2026-11-03 after several days of work drifted into downstream OpenClaw patches and maintenance of synthetic tests. The local-Docker and production-effect boundaries were explicitly set earlier in the same incident. Preserve this distinction when investigating future upstream updates.
