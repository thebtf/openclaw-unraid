#!/usr/bin/env node
/**
 * Run only OpenClaw's retired workspace setup/attestation importer.
 *
 * This helper intentionally does not reconstruct source claims, SQLite writes,
 * receipts, removal, or retry behavior. Those remain inside the exact upstream
 * functions selected at image build. It supplies the safety boundary around
 * that importer: stable no-link snapshots and verified adjacent backups.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import fsConstants from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const RECORD_PATH = "/usr/local/lib/openclaw-unraid-workspace-migration.json";
const ADAPTER_BASENAME = "openclaw-unraid-workspace-migration-adapter.mjs";
const REQUIRED_ADAPTER_EXPORTS = [
 "detectLegacyWorkspaceState",
 "migrateLegacyWorkspaceState",
 "parseSource",
];
const BACKUP_SUFFIX = ".openclaw-2026.8.1-pre-migration.bak";
const CLAIM_SUFFIX = ".doctor-importing";
const SOURCE_MAX_BYTES = {
 setup: 64 * 1024,
 attestation: 2 * 1024,
};
const RUNTIME_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
const RUNTIME_RECORD_MAX_BYTES = 16 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const createdBackupIdentities = new Map();

class WorkspaceMigrationRefused extends Error { }

function refuse() {
 throw new WorkspaceMigrationRefused("workspace migration refused");
}

function isRecord(value) {
 return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAbsoluteNormalizedPath(value) {
 return typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value;
}

function sameFileIdentity(left, right) {
 return (
  left.isFile() === right.isFile() &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs
 );
}
function snapshotsMatch(left, right) {
 return sameFileIdentity(left.fingerprint, right.fingerprint) && buffersEqual(left.bytes, right.bytes);
}



function buffersEqual(left, right) {
 return left.length === right.length && timingSafeEqual(left, right);
}

function noFollowFlag() {
 if (typeof fsConstants.constants.O_NOFOLLOW !== "number") {
  refuse();
 }
 return fsConstants.constants.O_NOFOLLOW;
}

async function assertDirectoryWithoutSymlinks(directoryPath) {
 const resolved = path.resolve(directoryPath);
 if (!path.isAbsolute(directoryPath) || resolved !== directoryPath) {
  refuse();
 }
 let canonical;
 let stat;
 try {
  [canonical, stat] = await Promise.all([fs.realpath(resolved), fs.stat(resolved)]);
 } catch {
  refuse();
 }
 if (canonical !== resolved || !stat.isDirectory()) {
  refuse();
 }
}

async function openStableRegularFile(filePath, maxBytes, readContents = true) {
 const resolved = path.resolve(filePath);
 if (!path.isAbsolute(filePath) || resolved !== filePath) {
  refuse();
 }
 await assertDirectoryWithoutSymlinks(path.dirname(resolved));

 let listed;
 try {
  listed = await fs.lstat(resolved);
 } catch {
  refuse();
 }
 if (!listed.isFile() || listed.nlink !== 1 || !Number.isSafeInteger(listed.size)) {
  refuse();
 }
 if (listed.size < 0 || listed.size > maxBytes) {
  refuse();
 }

 let handle;
 try {
  handle = await fs.open(resolved, fsConstants.constants.O_RDONLY | noFollowFlag());
 } catch {
  refuse();
 }
 try {
  const opened = await handle.stat();
  if (!sameFileIdentity(listed, opened)) {
   refuse();
  }
  let bytes;
  if (readContents) {
   bytes = Buffer.alloc(opened.size);
   let offset = 0;
   while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead <= 0) {
     refuse();
    }
    offset += bytesRead;
   }
  }
  const after = await handle.stat();
  let relisted;
  try {
   relisted = await fs.lstat(resolved);
  } catch {
   refuse();
  }
  if (!sameFileIdentity(opened, after) || !sameFileIdentity(after, relisted)) {
   refuse();
  }
  return readContents ? { bytes, fingerprint: after } : { fingerprint: after };
 } finally {
  await handle.close();
 }
}

async function hashStableRuntimeArtifact(filePath, expectedHash) {
 if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) {
  refuse();
 }
 const snapshot = await openStableRegularFile(filePath, RUNTIME_ARTIFACT_MAX_BYTES);
 const actualHash = createHash("sha256").update(snapshot.bytes).digest("hex");
 if (actualHash !== expectedHash) {
  refuse();
 }
}

async function readRuntimeRecord() {
 let parsed;
 try {
  const record = await openStableRegularFile(RECORD_PATH, RUNTIME_RECORD_MAX_BYTES);
  parsed = JSON.parse(record.bytes.toString("utf8"));
 } catch {
  refuse();
 }
 if (
  !isRecord(parsed) ||
  parsed.version !== 1 ||
  !isAbsoluteNormalizedPath(parsed.adapterPath) ||
  !isAbsoluteNormalizedPath(parsed.sourceModulePath) ||
  !isAbsoluteNormalizedPath(parsed.configModulePath) ||
  parsed.adapterPath !== path.join(path.dirname(parsed.sourceModulePath), ADAPTER_BASENAME) ||
  parsed.adapterPath === parsed.sourceModulePath ||
  !parsed.adapterPath.startsWith("/app/dist/") ||
  !parsed.sourceModulePath.startsWith("/app/dist/") ||
  !parsed.configModulePath.startsWith("/app/dist/")
 ) {
  refuse();
 }
 return parsed;
}

async function loadRuntime(record) {
 await Promise.all([
  hashStableRuntimeArtifact(record.adapterPath, record.adapterSha256),
  hashStableRuntimeArtifact(record.sourceModulePath, record.sourceModuleSha256),
  hashStableRuntimeArtifact(record.configModulePath, record.configModuleSha256),
 ]);

 let adapter;
 let config;
 try {
  [adapter, config] = await Promise.all([
   import(pathToFileURL(record.adapterPath).href),
   import(pathToFileURL(record.configModulePath).href),
  ]);
 } catch {
  refuse();
 }
 const adapterExports = Object.keys(adapter).sort();
 const requiredExports = [...REQUIRED_ADAPTER_EXPORTS].sort();
 if (
  adapterExports.length !== requiredExports.length ||
  adapterExports.some((name, index) => name !== requiredExports[index]) ||
  REQUIRED_ADAPTER_EXPORTS.some((name) => typeof adapter[name] !== "function") ||
  typeof config.loadConfig !== "function"
 ) {
  refuse();
 }
 return { adapter, loadConfig: config.loadConfig };
}

function resolveRuntimePaths() {
 const home = process.env.HOME?.trim();
 const openclawHome = process.env.OPENCLAW_HOME?.trim();
 const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
 const configDir = process.env.OPENCLAW_CONFIG_DIR?.trim();
 const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
 const workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR?.trim();
 const paths = [home, openclawHome, stateDir, configDir, configPath, workspaceDir];
 if (!paths.every(isAbsoluteNormalizedPath)) {
  refuse();
 }
 if (
  home !== openclawHome ||
  configDir !== stateDir ||
  configPath !== path.join(configDir, "openclaw.json")
 ) {
  refuse();
 }
 return { home, stateDir, configDir, configPath, workspaceDir };
}

function sourceKey(source) {
 return `${source.kind}\u0000${source.sourcePath}`;
}

function assertSourceShape(source) {
 if (
  !isRecord(source) ||
  (source.kind !== "setup" && source.kind !== "attestation") ||
  !isAbsoluteNormalizedPath(source.rootDir) ||
  !isAbsoluteNormalizedPath(source.sourcePath) ||
  typeof source.relativePath !== "string" ||
  typeof source.workspaceKey !== "string" ||
  source.workspaceKey.length === 0 ||
  !Number.isSafeInteger(source.priority)
 ) {
  refuse();
 }
 const expectedRelativePath = path.relative(source.rootDir, source.sourcePath);
 if (
  expectedRelativePath !== source.relativePath ||
  !expectedRelativePath ||
  expectedRelativePath === ".." ||
  expectedRelativePath.startsWith(`..${path.sep}`) ||
  path.isAbsolute(expectedRelativePath)
 ) {
  refuse();
 }
}

function assertDetectionShape(detection) {
 if (
  !isRecord(detection) ||
  typeof detection.hasLegacy !== "boolean" ||
  !Array.isArray(detection.sources) ||
  detection.hasLegacy !== (detection.sources.length > 0)
 ) {
  refuse();
 }
 const sourceKeys = new Set();
 const sourcePaths = new Set();
 for (const source of detection.sources) {
  assertSourceShape(source);
  const key = sourceKey(source);
  if (sourceKeys.has(key) || sourcePaths.has(source.sourcePath)) {
   refuse();
  }
  sourceKeys.add(key);
  sourcePaths.add(source.sourcePath);
 }
}

async function inspectActiveSource(source) {
 await assertDirectoryWithoutSymlinks(source.rootDir);
 const candidates = [source.sourcePath, `${source.sourcePath}${CLAIM_SUFFIX}`];
 const snapshots = [];
 for (const candidatePath of candidates) {
  try {
   snapshots.push({
    activePath: candidatePath,
    snapshot: await openStableRegularFile(candidatePath, SOURCE_MAX_BYTES[source.kind]),
   });
  } catch (error) {
   if (error instanceof WorkspaceMigrationRefused) {
    let exists = false;
    try {
     await fs.lstat(candidatePath);
     exists = true;
    } catch {
     // Absence is expected for one side of a source/claim pair.
    }
    if (exists) {
     throw error;
    }
   } else {
    throw error;
   }
  }
 }
 if (snapshots.length !== 1) {
  refuse();
 }
 return { source, ...snapshots[0] };
}

function buildSourceSnapshot(plan) {
 const { bytes, fingerprint } = plan.snapshot;
 if (bytes.length !== fingerprint.size) {
  refuse();
 }
 let raw;
 try {
  raw = utf8Decoder.decode(bytes);
 } catch {
  refuse();
 }
 return {
  sourcePath: plan.activePath,
  dev: fingerprint.dev,
  ino: fingerprint.ino,
  mtimeMs: fingerprint.mtimeMs,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  size: fingerprint.size,
  raw,
 };
}

function assertParsedSourceShape(source, parsed) {
 if (
  !isRecord(parsed) ||
  parsed.kind !== source.kind ||
  !Number.isSafeInteger(parsed.recordCount) ||
  parsed.recordCount < 0 ||
  !isRecord(parsed.value)
 ) {
  refuse();
 }

 if (source.kind === "setup") {
  const allowedKeys = ["bootstrapSeededAt", "setupCompletedAt"];
  if (Object.keys(parsed.value).some((key) => !allowedKeys.includes(key))) {
   refuse();
  }
  for (const key of allowedKeys) {
   if (parsed.value[key] !== undefined && typeof parsed.value[key] !== "string") {
    refuse();
   }
  }
  const expectedCount =
   Number(parsed.value.bootstrapSeededAt !== undefined) +
   Number(parsed.value.setupCompletedAt !== undefined);
  if (parsed.recordCount !== expectedCount) {
   refuse();
  }
  return;
 }

 if (
  Object.keys(parsed.value).some((key) => key !== "attestedAtMs" && key !== "generatedHashes") ||
  !Number.isSafeInteger(parsed.value.attestedAtMs) ||
  parsed.value.attestedAtMs < 0 ||
  !(parsed.value.generatedHashes instanceof Map)
 ) {
  refuse();
 }
 for (const [name, digest] of parsed.value.generatedHashes) {
  if (typeof name !== "string" || typeof digest !== "string") {
   refuse();
  }
 }
 if (parsed.recordCount !== 1 + parsed.value.generatedHashes.size) {
  refuse();
 }
}

function preflightSource(adapter, plan) {
 const snapshot = buildSourceSnapshot(plan);
 let parsed;
 try {
  parsed = adapter.parseSource(plan.source, snapshot);
 } catch {
  refuse();
 }
 assertParsedSourceShape(plan.source, parsed);
}

async function writeAll(handle, bytes) {
 let offset = 0;
 while (offset < bytes.length) {
  const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
  if (bytesWritten <= 0) {
   refuse();
  }
  offset += bytesWritten;
 }
}

async function syncParentDirectory(directoryPath) {
 const directoryFlag = fsConstants.constants.O_DIRECTORY;
 if (typeof directoryFlag !== "number") {
  refuse();
 }
 let handle;
 try {
  handle = await fs.open(
   directoryPath,
   fsConstants.constants.O_RDONLY | directoryFlag | noFollowFlag(),
  );
  await handle.sync();
 } catch (error) {
  if (!(["EINVAL", "ENOTSUP", "ENOSYS"].includes(error?.code))) {
   refuse();
  }
 } finally {
  if (handle) {
   await handle.close();
  }
 }
}

function sameCreatedBackupIdentity(current, created) {
 return (
  current.isFile() &&
  current.nlink === 1 &&
  (!created || (current.dev === created.dev && current.ino === created.ino))
 );
}

async function syncParentDirectoryBestEffort(directoryPath) {
 try {
  await syncParentDirectory(directoryPath);
 } catch {
  // Cleanup must still report refusal when a filesystem cannot sync its directory.
 }
}

async function verifyBackupAbsent(backupPath) {
 try {
  await fs.lstat(backupPath);
 } catch (error) {
  if (error?.code === "ENOENT") {
   return;
  }
 }
 refuse();
}

async function removeCreatedBackup(backupPath, createdIdentity) {
 const parentDirectory = path.dirname(backupPath);
 try {
  await assertDirectoryWithoutSymlinks(parentDirectory);
  let current;
  try {
   current = await fs.lstat(backupPath);
  } catch (error) {
   if (error?.code === "ENOENT") {
    return;
   }
   refuse();
  }
  if (!sameCreatedBackupIdentity(current, createdIdentity)) {
   refuse();
  }
  await fs.unlink(backupPath);
  await verifyBackupAbsent(backupPath);
 } finally {
  await syncParentDirectoryBestEffort(parentDirectory);
 }
}

async function rollbackCreatedBackups(backups) {
 let cleanupFailed = false;
 for (const backup of [...backups].reverse()) {
  try {
   const createdIdentity = createdBackupIdentities.get(backup.backupPath);
   if (!createdIdentity) {
    refuse();
   }
   await removeCreatedBackup(backup.backupPath, createdIdentity);
   createdBackupIdentities.delete(backup.backupPath);
  } catch {
   cleanupFailed = true;
  }
 }
 if (cleanupFailed) {
  refuse();
 }
}

async function closeHandleForCleanup(handle) {
 if (!handle) {
  return;
 }
 try {
  await handle.close();
 } catch {
  // Continue to the path-bound cleanup; the final result remains refusal.
 }
}

async function discardBackupAfterFailedCreation(backupPath, createdIdentity) {
 try {
  await removeCreatedBackup(backupPath, createdIdentity);
 } catch {
  // The caller reports refusal even if the best-effort cleanup could not finish.
 }
 refuse();
}

async function ensureVerifiedBackup(plan) {
 const backupPath = `${plan.activePath}${BACKUP_SUFFIX}`;
 const parentDirectory = path.dirname(backupPath);
 await assertDirectoryWithoutSymlinks(parentDirectory);

 try {
  const existing = await openStableRegularFile(backupPath, SOURCE_MAX_BYTES[plan.source.kind]);
  if (!buffersEqual(existing.bytes, plan.snapshot.bytes)) {
   refuse();
  }
  return { backupPath, created: false };
 } catch (error) {
  if (error instanceof WorkspaceMigrationRefused) {
   let exists = false;
   try {
    await fs.lstat(backupPath);
    exists = true;
   } catch {
    // A missing backup is the only case where this helper may create one.
   }
   if (exists) {
    throw error;
   }
  } else {
   throw error;
  }
 }

 let handle;
 let created = false;
 let createdIdentity;
 try {
  handle = await fs.open(
   backupPath,
   fsConstants.constants.O_WRONLY |
   fsConstants.constants.O_CREAT |
   fsConstants.constants.O_EXCL |
   noFollowFlag(),
   0o600,
  );
  created = true;
  createdIdentity = await handle.stat();
  if (!createdIdentity.isFile() || createdIdentity.nlink !== 1) {
   refuse();
  }
  await writeAll(handle, plan.snapshot.bytes);
  await handle.sync();
 } catch {
  await closeHandleForCleanup(handle);
  if (created && createdIdentity) {
   await discardBackupAfterFailedCreation(backupPath, createdIdentity);
  }
  refuse();
 }

 try {
  await handle.close();
  handle = undefined;
 } catch {
  await discardBackupAfterFailedCreation(backupPath, createdIdentity);
 }

 try {
  await syncParentDirectory(parentDirectory);
  const verified = await openStableRegularFile(backupPath, SOURCE_MAX_BYTES[plan.source.kind]);
  if (!buffersEqual(verified.bytes, plan.snapshot.bytes)) {
   refuse();
  }
 } catch {
  await discardBackupAfterFailedCreation(backupPath, createdIdentity);
 }

 createdBackupIdentities.set(backupPath, createdIdentity);
 return { backupPath, created: true };
}

function hasWarnings(result) {
 return (
  !isRecord(result) ||
  !Array.isArray(result.changes) ||
  !result.changes.every((change) => typeof change === "string") ||
  !Array.isArray(result.warnings) ||
  !result.warnings.every((warning) => typeof warning === "string") ||
  (result.notices !== undefined &&
   (!Array.isArray(result.notices) ||
    !result.notices.every((notice) => typeof notice === "string"))) ||
  result.warnings.length !== 0
 );
}

async function main() {
 if (process.argv.length !== 2) {
  refuse();
 }

 const record = await readRuntimeRecord();
 const { adapter, loadConfig } = await loadRuntime(record);
 const runtimePaths = resolveRuntimePaths();
 await Promise.all([
  assertDirectoryWithoutSymlinks(runtimePaths.home),
  assertDirectoryWithoutSymlinks(runtimePaths.stateDir),
  assertDirectoryWithoutSymlinks(runtimePaths.workspaceDir),
  openStableRegularFile(runtimePaths.configPath, RUNTIME_ARTIFACT_MAX_BYTES, false),
 ]);

 let cfg;
 try {
  cfg = loadConfig({ pin: false, skipPluginValidation: true, skipShellEnvFallback: true });
 } catch {
  refuse();
 }
 if (!isRecord(cfg)) {
  refuse();
 }

 const migrationEnv = Object.freeze({
  HOME: runtimePaths.home,
  OPENCLAW_HOME: runtimePaths.home,
  OPENCLAW_STATE_DIR: runtimePaths.stateDir,
  OPENCLAW_CONFIG_DIR: runtimePaths.configDir,
  OPENCLAW_CONFIG_PATH: runtimePaths.configPath,
  OPENCLAW_WORKSPACE_DIR: runtimePaths.workspaceDir,
 });
 const detectionParameters = {
  cfg,
  stateDir: runtimePaths.stateDir,
  env: migrationEnv,
  homedir: () => runtimePaths.home,
  doctorOnlyStateMigrations: true,
 };
 let detected;
 try {
  detected = adapter.detectLegacyWorkspaceState(detectionParameters);
 } catch {
  refuse();
 }
 assertDetectionShape(detected);
 if (!detected.hasLegacy) {
  let confirmed;
  try {
   confirmed = adapter.detectLegacyWorkspaceState(detectionParameters);
  } catch {
   refuse();
  }
  assertDetectionShape(confirmed);
  if (confirmed.hasLegacy) {
   refuse();
  }
  return "workspace-migration: no-op";
 }

 const plans = [];
 for (const source of detected.sources) {
  plans.push(await inspectActiveSource(source));
 }

 const createdBackups = [];
 try {
  for (const plan of plans) {
   preflightSource(adapter, plan);
  }
  for (const plan of plans) {
   const backup = await ensureVerifiedBackup(plan);
   if (backup.created) {
    createdBackups.push(backup);
   }
  }
  for (const plan of plans) {
   const current = await openStableRegularFile(
    plan.activePath,
    SOURCE_MAX_BYTES[plan.source.kind],
   );
   if (!snapshotsMatch(plan.snapshot, current)) {
    refuse();
   }
  }
 } catch {
  await rollbackCreatedBackups(createdBackups);
  refuse();
 }

 let migrated;
 try {
  migrated = await adapter.migrateLegacyWorkspaceState({
   detected,
   stateDir: runtimePaths.stateDir,
   env: migrationEnv,
  });
 } catch {
  refuse();
 }
 if (hasWarnings(migrated)) {
  refuse();
 }

 let after;
 try {
  after = adapter.detectLegacyWorkspaceState(detectionParameters);
 } catch {
  refuse();
 }
 assertDetectionShape(after);
 if (after.hasLegacy) {
  refuse();
 }
 return "workspace-migration: applied";
}

main()
 .then((status) => {
  process.stdout.write(`${status}\n`);
 })
 .catch(() => {
  process.stdout.write("workspace-migration: refused\n");
  process.exitCode = 1;
 });
