# OpenClaw for Unraid: product and update contract

## Product acceptance and ownership

This project packages the official `ghcr.io/openclaw/openclaw` application for Unraid. It is not an independent implementation of OpenClaw. Upstream owns application behavior, features, plugin APIs and database formats; this repository owns their integration with Unraid.

Primary acceptance: select **Install** in Unraid, supply the required template paths, identity/access settings and initial provider credentials/model selection, then use OpenClaw without manual shell repair or application patches. Keep the template's required/conditional settings and documentation consistent with what startup actually requires. A new pool, disk-path substitution or disabled upstream feature is not an assumed installation prerequisite.

Updates must retain supported existing configuration, credentials, sessions, workspaces and files, retain the configured execution identity, and expose the behavior of the selected upstream release. A successful fresh install does not prove a persisted-state upgrade, and an incident involving old/custom plugins does not prove the fresh-install defaults are broken.

### Owned product differences

| Surface | Intended downstream responsibility | Maintained source |
| --- | --- | --- |
| Installation | Unraid template, required/conditional variables, ports and persistent mount mappings; Compose provides the corresponding non-Unraid launch configuration | `openclaw.xml`, `docker-compose.yml`, `README.md` and its translations |
| Identity and access | Root-only initialization needed for PUID/PGID, bounded ownership preparation, then Gateway and CLI execution as that identity | `Dockerfile`, `docker/unraid-entrypoint.sh` |
| Runtime paths | Consistent home/state/config/workspace paths, persistent optional tooling paths and writable logging, without overriding unrelated user choices | `Dockerfile`, template, entrypoint |
| Initial configuration | Valid first-use Gateway/provider wiring from template inputs; existing user configuration remains authoritative except explicitly documented wrapper-managed fields and necessary upgrades | entrypoint and configuration migration scripts |
| State compatibility | Supported native upgrade operations with preservation/backup checks, not custom row restoration or forced schema markers | `scripts/migrate-*`, their build adapters and entrypoint callers |
| Updates | Resolve upstream image identity, validate the derived artifact, publish the tested image under the selected tag, then let the deployment consumer update it | `.github/workflows/build-image.yml`; Watchtower is external |

The entrypoint currently manages `gateway.mode`, `gateway.bind`, `gateway.controlUi.allowedOrigins`, `gateway.auth.mode`, `logging.file` and `logging.maxFileBytes` on each start; `models.mode=merge` is conditional on custom-provider configuration. Custom-provider/main-agent seeding is first-use/marker-gated, not a promise that later template environment edits overwrite existing provider/model choices. Reconcile this list with the entrypoint whenever changing config ownership.

Optional bundled tools such as `mcporter` are packaging additions, not permission to redesign application behavior. Changes to the table, template requirements or wrapper-managed config fields must be documented together with the affected implementation.

### Existing deviations are not vanilla guarantees

The desired boundary above and the existing implementation are not identical. `Dockerfile` currently invokes media/FUSE and memory-KNN build adapters in addition to configuration/state compatibility adapters. The media adapter can upgrade `@openclaw/fs-safe` and transform the private handoff and guarded media caller; the memory adapter can alter upstream search behavior when its source contract matches. Native-export/schema adapters also depend on private upstream interfaces even when they invoke upstream migration functions rather than replace them. These are concrete compatibility liabilities, not evidence that all upstream images need patches.

For an existing deviation, inspect its build record and actual installed bytes before calling it active in a published image. Do not infer deployed behavior from current source, an old experiment, an inherited OCI revision label or an upstream version alone. Generated `openclaw-unraid-*.json` records, when present, describe the image's adaptations; they do not by themselves prove runtime correctness.

Do not silently expand these deviations, introduce new private-bundle/dependency/algorithm patches, or edit database rows to satisfy a test. Equally, do not delete a shipped compatibility path merely to make the source look vanilla: identify its consumers and persisted-state requirements, determine whether upstream now supplies the behavior, and validate preservation before an accepted cutover. If supported configuration/packaging cannot resolve a proven upstream fault, present the concrete defect and supported alternatives; changing the product boundary requires an explicit owner decision.

## What update automation actually does

The workflow is the executable source of truth, not this prose:

- Scheduled digest checks run nominally at `05:23` and `17:23` UTC; GitHub scheduling is not an exact delivery deadline. Relevant pushes to `master` and manual dispatch also trigger it. Documentation-only changes do not necessarily match the push path filter.
- Default selection follows upstream `:latest`. Resolve the selected tag to one immutable digest and use that same base for the build and its evidence. On schedule, a changed or unreadable recorded base digest causes a build; an unchanged digest skips it. Push/manual runs build their selected input.
- Build a local candidate, capture its image ID, run the configured checks, and push that tested ID without rebuilding it. Failure retains the previous published tag. `validation_only=true` does not publish. A pinned upstream-tag build publishes that tag, not automatically our `:latest`.
- Watchtower watches the already-published downstream tag. It does not build images, review changelogs, repair failed CI or adopt an upstream release that our workflow has not published. Template-source changes are not proof that an existing Unraid container/template was updated.
- Current CI checks include first startup/identity/health, media/FUSE, plugin readiness, persisted configuration/workspace/session/approval/default-role and historical-state upgrades, plus the memory path. Their current commands and inputs live in the workflow and existing `scripts/test-*.sh` / fixture owners. Apply relevant checks to affected behavior; do not run image suites for a prose-only change.

**Automation limit:** digest tracking and executable checks exist; automated semantic analysis of OpenClaw's changelog and automatic corrective engineering do not. The review protocol below is an agent/maintainer procedure, not an already-enforced GitHub Actions step. Do not claim that a scheduled build automatically completed that review. If per-publication semantic review is required, its workflow enforcement is a separate implementation decision, not something an AGENTS edit supplies.

## Upstream-change review and correction protocol

Apply this protocol when investigating an upstream digest/release change, preparing a wrapper/template update, or periodically reviewing accumulated upstream changes. A periodic review uses the last evidenced assessment as its baseline; it must not repeatedly re-audit unchanged inputs.

1. **Identify the change.** Record the prior and proposed upstream versions/digests, downstream source commit, candidate/published image identity and installed container identity separately. For a same-version digest refresh, inspect image/base/dependency/build changes; version strings alone cannot explain it.
2. **Read the relevant upstream change record.** Cover intervening releases since the assessed baseline, not just the newest release heading. Use official release notes/changelog and the exact tagged source or image metadata needed to resolve an affected contract. Unversioned current documentation is not proof of an older image's behavior.
3. **Map changes to our surfaces.** Check base architecture/runtime, `USER`/entrypoint/command, UID/GID and permissions, home/state/workspace/log paths, ports/origins/auth, environment/config fields, native migration requirements, plugin packaging/API compatibility, and whether upstream supersedes an existing downstream deviation. Inspect only contracts the change can affect.
4. **Disposition each material change.** Record one of: no wrapper impact with a reason; template/default/documentation correction; startup/permission/path correction; supported native state upgrade; operator configuration proposal; or a proven upstream defect outside packaging. For an existing downstream deviation, record retain/adapt/remove/propose with its consumer and preservation reason. Do not turn an unknown into a patch or silently skip it.
5. **Use the smallest relevant proof.** Check the affected Install or upgrade path with the existing owner. Verify PUID/PGID and permissions, persistence/restart and user-config preservation where affected; exercise the changed public/user entry where required. Use vanilla comparison only when it discriminates the concrete fault. Keep configured publication gates intact; if a gate tests obsolete private wiring rather than a real contract, prove that distinction before changing it. Do not grow a replacement upstream test suite or repeat random builds.
6. **Close or retain the exact gap.** Record source change, correction, observed result and remaining risk. Failed required checks hold publication, not unrelated read-only diagnosis. A green no-change schedule, successful build, healthy container or single readiness response proves only that fact; it is not a successful changed-upstream rollout or every bot/file/memory operation.
7. **Verify delivery separately.** After a permitted release, verify the published tag/digest and the installed image after the normal update consumer acts. Classify the outcome precisely: no change needed, candidate failed, validated but unpublished, published but not installed, installed with relevant proof, or a remaining specific gap. Preserve the last known working release when the candidate fails.

Keep the assessment and live status in the existing task/incident evidence, currently `.agent/runs/openclaw-restart-readiness/investigation.md`, not as volatile versions or success claims in this file. Each assessment needs source identities, affected behavior, disposition, actual checks/results, delivery state and the next unresolved question; no new report framework is required.

Managed plugins stored in persistent state do not automatically follow a rebuilt base image. Check their installed versions and declared host compatibility separately; do not blindly install npm `latest` into an older core. Age alone proves neither incompatibility nor the cause of a stall.

## Concrete incident protocol

Before proposing a repair, establish whether a user operation is failing **now**. Preserve the exact operation, time, error and installed image. Separate a clean required-settings installation, an upgrade with persisted state/plugins, an upstream defect, a wrapper defect and a host constraint. No current fault means no speculative repair; unresolved update compatibility is a separate task.

Trace the failed operation to the actual boundary. Use relevant evidence for effective PUID/PGID, mounts/permissions, filesystem behavior and the failing process's resources/limits. Storage usage, swap, a configured ceiling, a synthetic failure or a historical correlation alone is not proof of exhaustion or production causality. First explain why a proposed setting, cleanup, limit increase or storage change addresses the observed failure; then propose it with preservation and rollback conditions. Examples of possible remedies are not authority to execute them. After an unchanged approach fails repeatedly, resolve the missing causal fact instead of trying another speculative variation.

Use supported native state-upgrade routes and preservation/backup requirements. Do not force schema versions, restore arbitrary rows, disable required safety checks or treat elective memory/plugin optimization as migration compatibility.

## Unraid storage, tests and production effects

Use Unraid's logical user-share model by default. `/mnt/diskN` pinning is an operator-selected diagnostic/recovery workaround, not final user-share compatibility. Do not copy/move between user-share and disk-share aliases as independent datasets. A pool/exclusive share is an option only after its necessity and host prerequisites are established, not a default demand for new hardware.

Tests and candidate images run on this workstation's local Docker Desktop (`desktop-linux`), never production Unleashed. Reuse existing inputs and checks; preserve useful evidence and finish only our spent resources, not unrelated images/containers/data.

Production Unleashed is read-only except for the standing permission to restart the existing container or invoke the official update mechanism if Watchtower stalls. No direct configuration/template/queue/database writes, arbitrary image pulls/runs, container creation/manual replacement, message replay or writes to hosted Engram/Plane. Production delivery uses a verified downstream `:latest` release and Watchtower/the permitted official update route. A source commit or manual tag is not deployment proof.

## Provenance

The repository owner restated this thin-wrapper, Install-and-use and concrete-diagnosis boundary on 2026-11-03 after work drifted into OpenClaw patches and synthetic-test maintenance, then requested an explicit upstream/changelog/product-behavior protocol. Earlier local-Docker and production-effect restrictions remain in force. Existing source deviations are recorded above to expose the gap, not to redefine the accepted product silently.
