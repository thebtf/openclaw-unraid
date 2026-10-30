#!/usr/bin/env node
/** Advance only supported owned DB schemas; never import sessions or restore rows. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const RECORD = "/usr/local/lib/openclaw-unraid-schema-migration.json";
const ROOT = "/home/node/.openclaw";
const SHARED = `${ROOT}/state/openclaw.sqlite`;
const REQUIRED = ["prepareDoctorDatabasePreflight", "beginDoctorMaintenance", "backupDoctorMigrationDatabases", "completeDoctorMigrationBackups", "prepareOpenClawStateDatabaseSchema", "withAgentDatabaseMaintenanceLease", "migrateOpenClawAgentDatabaseForMaintenance", "preflightOpenClawDatabaseSchemas", "isUninitializedNativeStartupDatabase", "prepareSqliteReadOnlyLocation", "listSessionSqliteMigrationManifestPaths", "readSessionSqliteMigrationManifest", "readMigrationArtifactIdentity", "sameMigrationArtifact"];
class Refusal extends Error { }
const refuse = (code) => { throw new Refusal(code); };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Native subsystem progress is not this helper's one-line status protocol.
// All returned warnings and exceptions still refuse; do not leak raw reports.
const writeStatus = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;

async function regularFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.nlink !== 1 || await fs.realpath(file) !== file) refuse("unsafe-path");
  return stat;
}

async function loadAdapter() {
  await regularFile(RECORD);
  const record = JSON.parse(await fs.readFile(RECORD, "utf8"));
  if (record.version !== 2 || typeof record.openClawVersion !== "string" || !record.openClawVersion.trim() || record.stateVersion !== 20 || record.agentVersion !== 25 || record.packagePath !== "/app/package.json" || !/^[a-f0-9]{64}$/.test(record.packageSha256) || record.adapterPath !== "/app/dist/openclaw-unraid-schema-migration-adapter.mjs" || !Array.isArray(record.modules) || record.modules.length !== 10) refuse("image-contract");
  await regularFile(record.packagePath);
  const packageBytes = await fs.readFile(record.packagePath);
  if (digest(packageBytes) !== record.packageSha256 || JSON.parse(packageBytes).version !== record.openClawVersion) refuse("image-contract");
  for (const entry of [{ path: record.adapterPath, sha256: record.adapterSha256 }, ...record.modules]) {
    if (typeof entry.path !== "string" || path.dirname(entry.path) !== "/app/dist" || !/^[a-f0-9]{64}$/.test(entry.sha256)) refuse("image-contract");
    await regularFile(entry.path);
    if (digest(await fs.readFile(entry.path)) !== entry.sha256) refuse("image-contract");
  }
  const adapter = await import(pathToFileURL(record.adapterPath).href);
  if (REQUIRED.some((name) => typeof adapter[name] !== "function")) refuse("image-contract");
  return adapter;
}

function requireClean(result, phase) {
  if (!result || !Array.isArray(result.changes) || !Array.isArray(result.warnings) || result.warnings.length) refuse(phase);
}

function checkPreflight(result) {
  if (!result || !Array.isArray(result.incompatible) || !Array.isArray(result.indeterminate) || result.incompatible.length || result.indeterminate.length || result.agentRefusals?.length) refuse("schema-preflight");
  const pending = result.pendingMigrations ?? [];
  if (!Array.isArray(pending) || pending.some((row) => row.kind === "state" ? row.path !== SHARED || ![0, 15].includes(row.foundVersion) || row.supportedVersion !== 20 : row.kind !== "agent" || row.foundVersion !== 19 || row.supportedVersion !== 25 || typeof row.agentId !== "string")) refuse("unsupported-schema");
  const prepared = result.agentDatabaseMigrationDiscovery;
  if (result.agentDatabaseRecoveryConfigValid !== true || !prepared || prepared.stateDir !== ROOT) refuse("configuration");
  const discovery = prepared.discovery;
  if (!discovery || !Array.isArray(discovery.targets) || discovery.failures?.length || discovery.warnings?.length || discovery.retainedTargets?.length || discovery.unverifiedTargets?.length || discovery.registryRemovals?.length) refuse("agent-discovery");
  return { pending, targets: discovery.targets };
}

async function inventory(targets) {
  const entries = [];
  const seen = new Set();
  for (const file of [SHARED, ...targets.map((target) => target.path)]) {
    if (typeof file !== "string" || !path.isAbsolute(file) || path.resolve(file) !== file || !file.startsWith(`${ROOT}/`)) refuse("unsupported-agent-path");
    const stat = await regularFile(file);
    const identity = `${stat.dev}:${stat.ino}`;
    if (seen.has(identity)) refuse("aliased-database");
    seen.add(identity);
    entries.push({ path: file, dev: stat.dev, ino: stat.ino });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function assertInventory(entries) {
  for (const entry of entries) {
    const stat = await regularFile(entry.path);
    if (stat.dev !== entry.dev || stat.ino !== entry.ino) refuse("changed-database");
  }
}

async function incompleteDatabaseReceipts(api) {
  const receipts = [];
  for (const file of api.listSessionSqliteMigrationManifestPaths(process.env)) {
    if (path.dirname(file) !== `${ROOT}/session-sqlite-migration-runs`) refuse("backup-manifest-path");
    await regularFile(file);
    const manifest = api.readSessionSqliteMigrationManifest(file);
    if (!manifest) {
      if (path.basename(file).startsWith("startup-migration-")) refuse("backup-manifest");
      continue;
    }
    if (!manifest.completedAt && manifest.targets.some((target) => target.databaseIdentity)) receipts.push({ file, manifest });
  }
  return receipts;
}

async function matchingBackupGroup(api, receipts, entries) {
  const paths = new Set(entries.map((entry) => entry.path));
  const groups = [];
  for (const receipt of receipts) {
    const { file, manifest } = receipt;
    if (!manifest.targets.some((target) => paths.has(target.sqlitePath))) continue;
    if (!/^startup-migration-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(manifest.runId) || path.basename(file) !== `${manifest.runId}.json` || manifest.manifestVersion !== 3 || manifest.failedAt || manifest.failureReports || manifest.restore || manifest.targets.length !== entries.length || new Set(manifest.targets.map((target) => target.sqlitePath)).size !== entries.length) refuse("unmatched-backup-group");
    const snapshots = [];
    for (const target of manifest.targets) {
      const source = entries.find((entry) => entry.path === target.sqlitePath);
      if (!source || target.agentId !== "startup-migration" || target.storePath !== source.path || target.databaseIdentity?.dev !== String(source.dev) || target.databaseIdentity?.ino !== String(source.ino) || target.issues.length || target.validationBeforeArchive === "failed" || target.plannedMoves.length !== 1 || target.completedMoves.length !== 1) refuse("unmatched-backup-group");
      const expectedPath = `${source.path}.pre-startup-migration-${manifest.runId.slice("startup-migration-".length)}.bak`;
      for (const move of [...target.plannedMoves, ...target.completedMoves]) {
        if (move.kind !== "database-backup" || move.sourcePath !== source.path || move.archivePath !== expectedPath || move.artifact?.classification !== "repair-original" || move.artifact.reason !== "pre-startup-migration-backup" || move.artifact.disposal.state !== "retained") refuse("unmatched-backup-group");
        await regularFile(move.archivePath);
        if (!api.sameMigrationArtifact(api.readMigrationArtifactIdentity(move.archivePath), move.artifact.identity)) refuse("changed-backup-artifact");
      }
      snapshots.push({ sourcePath: source.path, path: expectedPath });
    }
    groups.push({ ...receipt, snapshots });
  }
  // The native completion API visits all matching receipts. Refuse ambiguity
  // rather than accidentally certifying a subset or a second backup group.
  if (groups.length > 1) refuse("ambiguous-backup-group");
  return groups[0];
}

function inspectBackup(snapshot, legacyShared) {
  // The native backup is a consolidated, verified file. Immutable reads cannot
  // add WAL/SHM files to either the snapshot or the real databases.
  const database = new DatabaseSync(`${pathToFileURL(snapshot.path).href}?immutable=1`, { readOnly: true });
  try {
    if (!database.prepare("PRAGMA integrity_check").all().every((row) => row.integrity_check === "ok") || database.prepare("PRAGMA foreign_key_check").all().length) refuse("backup-integrity");
    if (!legacyShared || snapshot.sourcePath !== SHARED) return;
    // These retired populated tables have no preservation contract in the
    // audited native automatic branch. Do not discard user/security history.
    for (const name of ["cron_run_logs", "database_verifications", "node_pairing_pending", "node_pairing_paired"]) {
      if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name) && database.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).get()) refuse("retired-data-requires-manual-review");
    }
    if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' LIMIT 1").get()) refuse("custom-state-triggers");
  } finally {
    database.close();
  }
}

async function main() {
  if (process.argv.length !== 2) refuse("arguments");
  if (process.env.HOME !== "/home/node" || process.env.OPENCLAW_STATE_DIR !== ROOT) refuse("runtime-paths");
  await regularFile(process.env.OPENCLAW_CONFIG_PATH);
  const api = await loadAdapter();
  const first = checkPreflight(await api.prepareDoctorDatabasePreflight({ preserveSourceArtifacts: true }));
  const initialReceipts = await incompleteDatabaseReceipts(api);
  if (!first.pending.length && !initialReceipts.length) return "database-schema: no-op";
  if (first.pending.length === 1 && first.pending[0].kind === "state" && first.pending[0].foundVersion === 0 && !first.targets.length) {
    const snapshot = await api.prepareSqliteReadOnlyLocation(SHARED, { preserveSourceArtifacts: true, allowLiveOwner: true });
    let fresh;
    try {
      const database = new DatabaseSync(snapshot.location, { readOnly: true });
      try { fresh = api.isUninitializedNativeStartupDatabase(database); }
      finally { database.close(); }
    } finally {
      if (!await snapshot.cleanupAsync()) refuse("first-use-snapshot-cleanup");
    }
    if (fresh === true) return "database-schema: no-op";
    refuse("unrecognized-first-use-schema");
  }
  if (first.pending.some((row) => row.kind === "state" && row.foundVersion === 0)) refuse("unrecognized-first-use-schema");
  const originalInventory = await inventory(first.targets);
  const initialGroup = await matchingBackupGroup(api, initialReceipts, originalInventory);
  if (!first.pending.length && !initialGroup) return "database-schema: no-op";
  const runtime = { log() { }, error() { }, exit() { refuse("native-exit"); } };
  let owner;
  let phase = "maintenance-ownership";
  let changed = false;
  try {
    owner = await api.beginDoctorMaintenance({ options: { repair: true, nonInteractive: true }, interactiveRepair: false, runtime });
    if (!owner || owner.warnings?.length) refuse("maintenance-ownership");
    await owner.run(async () => {
      phase = "owned-preflight";
      await assertInventory(originalInventory);
      const before = checkPreflight(await api.prepareDoctorDatabasePreflight({ preserveSourceArtifacts: true }));
      const currentInventory = await inventory(before.targets);
      if (JSON.stringify(currentInventory) !== JSON.stringify(originalInventory)) refuse("changed-fleet");
      const previousGroup = await matchingBackupGroup(api, await incompleteDatabaseReceipts(api), originalInventory);
      if (!before.pending.length && !previousGroup) return;
      phase = "verified-backup";
      const paths = originalInventory.map((entry) => entry.path);
      // Always pass the entire selected existing fleet, even on mixed-version
      // crash re-entry. Native group identity includes paths/dev/ino and build.
      // Omitting agentDatabaseTargets disables backup-time session repair.
      const backup = await api.backupDoctorMigrationDatabases({ env: process.env, pendingDatabasePaths: paths, databasePaths: paths, requireSnapshots: true });
      requireClean(backup, "verified-backup");
      if (!Array.isArray(backup.snapshots) || backup.snapshots.length !== paths.length || new Set(backup.snapshots.map((snapshot) => snapshot.sourcePath)).size !== paths.length || paths.some((file) => !backup.snapshots.some((snapshot) => snapshot.sourcePath === file))) refuse("backup-coverage");
      const group = await matchingBackupGroup(api, await incompleteDatabaseReceipts(api), originalInventory);
      if (!group || previousGroup && group.file !== previousGroup.file || backup.snapshots.some((snapshot) => !group.snapshots.some((member) => member.sourcePath === snapshot.sourcePath && member.path === snapshot.path))) refuse("unmatched-backup-group");
      const legacyShared = before.pending.some((row) => row.kind === "state");
      for (const snapshot of backup.snapshots) {
        if (typeof snapshot.path !== "string" || !snapshot.path.startsWith(`${snapshot.sourcePath}.pre-startup-migration-`) || !snapshot.path.endsWith(".bak")) refuse("backup-coverage");
        await regularFile(snapshot.path);
        inspectBackup(snapshot, legacyShared);
      }
      await assertInventory(originalInventory);
      phase = "shared-schema";
      if (legacyShared) requireClean(await api.prepareOpenClawStateDatabaseSchema({ env: process.env }, "automatic"), "shared-schema");
      phase = "agent-schema";
      const pendingAgents = before.pending.filter((row) => row.kind === "agent");
      if (pendingAgents.length) await api.withAgentDatabaseMaintenanceLease({ env: process.env }, async (lease) => {
        for (const target of pendingAgents) {
          if (!before.targets.some((row) => row.path === target.path && row.agentId === target.agentId)) refuse("unselected-agent");
          await assertInventory(originalInventory);
          await api.migrateOpenClawAgentDatabaseForMaintenance({ agentId: target.agentId, pathname: target.path }, lease);
        }
      });
      phase = "whole-fleet-readiness";
      await assertInventory(originalInventory);
      const after = checkPreflight(await api.prepareDoctorDatabasePreflight({ preserveSourceArtifacts: true }));
      if (after.pending.length) refuse("incomplete-schema");
      if (JSON.stringify(await inventory(after.targets)) !== JSON.stringify(originalInventory)) refuse("changed-fleet");
      const ready = await api.preflightOpenClawDatabaseSchemas({ env: process.env, verifyCurrentSchemaShape: true, preserveSourceArtifacts: true, configuredAgentDatabaseTargets: after.targets });
      if (ready.incompatible.length || ready.indeterminate.length || ready.pendingMigrations?.length || ready.agentRefusals?.length) refuse("whole-fleet-readiness");
      api.completeDoctorMigrationBackups(process.env, paths);
      const completed = api.readSessionSqliteMigrationManifest(group.file);
      if (!completed?.completedAt || completed.targets.some((target) => target.validationBeforeArchive !== "passed")) refuse("backup-completion");
      changed = true;
    });
  } catch (error) {
    if (error instanceof Refusal) throw error;
    refuse(phase);
  } finally {
    if (owner) await owner.release();
  }
  return changed ? "database-schema: applied" : "database-schema: no-op";
}

main().then((status) => writeStatus(`${status}\n`)).catch((error) => {
  const code = error instanceof Refusal ? error.message : "native-contract";
  writeStatus(`database-schema: refused code=${code}\n`);
  process.stderr.write("Schema preparation stopped before session import. Preserve the native *.pre-startup-migration-*.bak group; stop other OpenClaw writers and inspect this bounded refusal before retrying. Do not run broad doctor --fix automatically.\n");
  process.exitCode = 1;
});
