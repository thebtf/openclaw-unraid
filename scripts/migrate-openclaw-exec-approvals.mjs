#!/usr/bin/env node
/**
 * Safely invoke OpenClaw's build-pinned retired exec-approvals importer.
 * The upstream importer owns SQLite writes, receipts, exclusive claims, and
 * source removal. This helper supplies only the local backup and fail-closed
 * boundary without ever logging persisted approval contents.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fsConstants from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const RECORD_PATH = "/usr/local/lib/openclaw-unraid-exec-approvals-migration.json";
const ADAPTER_BASENAME = "openclaw-unraid-exec-approvals-migration-adapter.mjs";
const REQUIRED_ADAPTER_EXPORTS = ["detectLegacyExecApprovals", "migrateLegacyExecApprovals"];
const SOURCE_BASENAME = "exec-approvals.json";
const CLAIM_SUFFIX = ".doctor-importing";
const BACKUP_SUFFIX = ".openclaw-2026.8.2-pre-migration.bak";
const SOURCE_MAX_BYTES = 4 * 1024 * 1024;
const RUNTIME_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
const RUNTIME_RECORD_MAX_BYTES = 16 * 1024;
const SUCCESS_CHANGES = new Set([
 "Imported legacy exec approvals into shared SQLite state.",
 "Replaced an invalid SQLite exec approvals row with validated legacy state.",
 "Preserved byte-identical canonical SQLite exec approvals.",
 "Completed cleanup for previously imported legacy exec approvals.",
]);
const SUCCESS_NOTICE = "Removed retired exec approvals JSON after recording its migration decision.";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

class ExecApprovalsMigrationRefused extends Error {
 constructor(code) {
  super("exec approvals migration refused");
  this.code = code;
 }
}

function refuse(code) {
 throw new ExecApprovalsMigrationRefused(code);
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

function noFollowFlag(code) {
 if (typeof fsConstants.constants.O_NOFOLLOW !== "number") {
  refuse(code);
 }
 return fsConstants.constants.O_NOFOLLOW;
}

async function assertDirectoryWithoutSymlinks(directoryPath, code) {
 const resolved = path.resolve(directoryPath);
 if (!path.isAbsolute(directoryPath) || resolved !== directoryPath) {
  refuse(code);
 }
 let canonical;
 let stat;
 try {
  [canonical, stat] = await Promise.all([fs.realpath(resolved), fs.stat(resolved)]);
 } catch {
  refuse(code);
 }
 if (canonical !== resolved || !stat.isDirectory()) {
  refuse(code);
 }
}

async function openStableRegularFile(filePath, maxBytes, code) {
 const resolved = path.resolve(filePath);
 if (!path.isAbsolute(filePath) || resolved !== filePath) {
  refuse(code);
 }
 await assertDirectoryWithoutSymlinks(path.dirname(resolved), code);

 let listed;
 try {
  listed = await fs.lstat(resolved);
 } catch {
  refuse(code);
 }
 if (!listed.isFile() || listed.nlink !== 1 || !Number.isSafeInteger(listed.size)) {
  refuse(code);
 }
 if (listed.size < 0 || listed.size > maxBytes) {
  refuse(code);
 }

 let handle;
 try {
  handle = await fs.open(resolved, fsConstants.constants.O_RDONLY | noFollowFlag(code));
 } catch {
  refuse(code);
 }
 try {
  const opened = await handle.stat();
  if (!sameFileIdentity(listed, opened)) {
   refuse(code);
  }
  const bytes = Buffer.alloc(opened.size);
  let offset = 0;
  while (offset < bytes.length) {
   const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
   if (bytesRead <= 0) {
    refuse(code);
   }
   offset += bytesRead;
  }
  const after = await handle.stat();
  let relisted;
  try {
   relisted = await fs.lstat(resolved);
  } catch {
   refuse(code);
  }
  if (!sameFileIdentity(opened, after) || !sameFileIdentity(after, relisted)) {
   refuse(code);
  }
  return { bytes, fingerprint: after };
 } finally {
  await handle.close();
 }
}

async function maybeOpenStableRegularFile(filePath, maxBytes, code) {
 try {
  await fs.lstat(filePath);
 } catch (error) {
  if (error?.code === "ENOENT") {
   return undefined;
  }
  refuse(code);
 }
 return await openStableRegularFile(filePath, maxBytes, code);
}

async function hashStableRuntimeArtifact(filePath, expectedHash) {
 if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) {
  refuse("record");
 }
 const snapshot = await openStableRegularFile(filePath, RUNTIME_ARTIFACT_MAX_BYTES, "runtime");
 if (createHash("sha256").update(snapshot.bytes).digest("hex") !== expectedHash) {
  refuse("runtime");
 }
}

async function readRuntimeRecord() {
 let parsed;
 try {
  const record = await openStableRegularFile(RECORD_PATH, RUNTIME_RECORD_MAX_BYTES, "record");
  parsed = JSON.parse(utf8Decoder.decode(record.bytes));
 } catch (error) {
  if (error instanceof ExecApprovalsMigrationRefused) {
   throw error;
  }
  refuse("record");
 }
 if (
  !isRecord(parsed) ||
  Object.keys(parsed).sort().join("\u0000") !==
  "adapterPath\u0000adapterSha256\u0000sourceModulePath\u0000sourceModuleSha256\u0000version" ||
  parsed.version !== 1 ||
  !isAbsoluteNormalizedPath(parsed.adapterPath) ||
  !isAbsoluteNormalizedPath(parsed.sourceModulePath) ||
  parsed.adapterPath !== path.join(path.dirname(parsed.sourceModulePath), ADAPTER_BASENAME) ||
  parsed.adapterPath === parsed.sourceModulePath ||
  !parsed.adapterPath.startsWith("/app/dist/") ||
  !parsed.sourceModulePath.startsWith("/app/dist/")
 ) {
  refuse("record");
 }
 return parsed;
}

async function loadRuntime(record) {
 await Promise.all([
  hashStableRuntimeArtifact(record.adapterPath, record.adapterSha256),
  hashStableRuntimeArtifact(record.sourceModulePath, record.sourceModuleSha256),
 ]);

 let adapter;
 try {
  adapter = await import(pathToFileURL(record.adapterPath).href);
 } catch {
  refuse("runtime");
 }
 const adapterExports = Object.keys(adapter).sort();
 const requiredExports = [...REQUIRED_ADAPTER_EXPORTS].sort();
 if (
  adapterExports.length !== requiredExports.length ||
  adapterExports.some((name, index) => name !== requiredExports[index]) ||
  REQUIRED_ADAPTER_EXPORTS.some((name) => typeof adapter[name] !== "function")
 ) {
  refuse("runtime");
 }
 return adapter;
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
  refuse("paths");
 }
 if (
  home !== "/home/node" ||
  openclawHome !== home ||
  stateDir !== path.join(home, ".openclaw") ||
  configDir !== stateDir ||
  configPath !== path.join(configDir, "openclaw.json") ||
  workspaceDir !== path.join(stateDir, "workspace")
 ) {
  refuse("paths");
 }
 return { home, stateDir, configDir, configPath, workspaceDir };
}

function assertDetectionShape(detected, stateDir) {
 if (
  !isRecord(detected) ||
  Object.keys(detected).sort().join("\u0000") !== "hasLegacy\u0000sourcePath" ||
  typeof detected.hasLegacy !== "boolean" ||
  detected.sourcePath !== path.join(stateDir, SOURCE_BASENAME)
 ) {
  refuse("detection");
 }
}

async function inspectActiveSource(sourcePath) {
 const candidates = [sourcePath, `${sourcePath}${CLAIM_SUFFIX}`];
 const snapshots = [];
 for (const candidatePath of candidates) {
  const snapshot = await maybeOpenStableRegularFile(candidatePath, SOURCE_MAX_BYTES, "source");
  if (snapshot) {
   snapshots.push({ activePath: candidatePath, snapshot });
  }
 }
 if (snapshots.length !== 1) {
  refuse("source");
 }
 return snapshots[0];
}

function assertPrivatePuidOwned(fingerprint) {
 const uid = process.getuid?.();
 const gid = process.getgid?.();
 if (
  !Number.isSafeInteger(uid) ||
  !Number.isSafeInteger(gid) ||
  fingerprint.uid !== uid ||
  fingerprint.gid !== gid ||
  (fingerprint.mode & 0o077) !== 0
 ) {
  refuse("backup");
 }
}

async function writeAll(handle, bytes) {
 let offset = 0;
 while (offset < bytes.length) {
  const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
  if (bytesWritten <= 0) {
   refuse("backup");
  }
  offset += bytesWritten;
 }
}

async function syncParentDirectory(directoryPath) {
 const directoryFlag = fsConstants.constants.O_DIRECTORY;
 if (typeof directoryFlag !== "number") {
  refuse("backup");
 }
 let handle;
 try {
  handle = await fs.open(
   directoryPath,
   fsConstants.constants.O_RDONLY | directoryFlag | noFollowFlag("backup"),
  );
  await handle.sync();
 } catch (error) {
  if (!(["EINVAL", "ENOTSUP", "ENOSYS"].includes(error?.code))) {
   refuse("backup");
  }
 } finally {
  if (handle) {
   await handle.close();
  }
 }
}

function hasAttemptOwnedFileIdentity(current, identity, allowedLinks) {
 return (
  Boolean(identity) &&
  current.isFile() &&
  current.dev === identity.dev &&
  current.ino === identity.ino &&
  allowedLinks.includes(current.nlink)
 );
}

async function removeAttemptOwnedFile(filePath, identity, allowedLinks) {
 const parentDirectory = path.dirname(filePath);
 await assertDirectoryWithoutSymlinks(parentDirectory, "backup");
 let current;
 try {
  current = await fs.lstat(filePath);
 } catch (error) {
  if (error?.code === "ENOENT") {
   return;
  }
  refuse("backup");
 }
 if (!hasAttemptOwnedFileIdentity(current, identity, allowedLinks)) {
  refuse("backup");
 }
 await fs.unlink(filePath);
}

async function cleanupStaging(stagingPath, identity) {
 try {
  await removeAttemptOwnedFile(stagingPath, identity, [1, 2]);
 } catch {
  refuse("backup");
 }
}

function createStagingPath(backupPath) {
 return path.join(path.dirname(backupPath), `.${path.basename(backupPath)}.stage-${randomUUID()}`);
}

async function readVerifiedExistingBackup(backupPath, sourceBytes) {
 const backup = await openStableRegularFile(backupPath, SOURCE_MAX_BYTES, "backup");
 assertPrivatePuidOwned(backup.fingerprint);
 if (!buffersEqual(backup.bytes, sourceBytes)) {
  refuse("backup");
 }
 return backup;
}

async function ensureVerifiedBackup(plan) {
 const backupPath = `${path.join(path.dirname(plan.activePath), SOURCE_BASENAME)}${BACKUP_SUFFIX}`;
 const parentDirectory = path.dirname(backupPath);
 await assertDirectoryWithoutSymlinks(parentDirectory, "backup");

 try {
  await readVerifiedExistingBackup(backupPath, plan.snapshot.bytes);
  return { backupPath, created: false };
 } catch (error) {
  if (!(error instanceof ExecApprovalsMigrationRefused)) {
   throw error;
  }
  let exists = false;
  try {
   await fs.lstat(backupPath);
   exists = true;
  } catch {
   // The only acceptable failure above is a missing final backup.
  }
  if (exists) {
   throw error;
  }
 }

 const stagingPath = createStagingPath(backupPath);
 let stagingHandle;
 let stagingIdentity;
 let backupPublished = false;
 try {
  stagingHandle = await fs.open(
   stagingPath,
   fsConstants.constants.O_WRONLY |
   fsConstants.constants.O_CREAT |
   fsConstants.constants.O_EXCL |
   noFollowFlag("backup"),
   0o600,
  );
  stagingIdentity = await stagingHandle.stat();
  if (!stagingIdentity.isFile() || stagingIdentity.nlink !== 1) {
   refuse("backup");
  }
  assertPrivatePuidOwned(stagingIdentity);
  await writeAll(stagingHandle, plan.snapshot.bytes);
  const writtenIdentity = await stagingHandle.stat();
  if (!hasAttemptOwnedFileIdentity(writtenIdentity, stagingIdentity, [1])) {
   refuse("backup");
  }
  await stagingHandle.sync();
  await stagingHandle.close();
  stagingHandle = undefined;

  const staged = await openStableRegularFile(stagingPath, SOURCE_MAX_BYTES, "backup");
  if (
   !hasAttemptOwnedFileIdentity(staged.fingerprint, stagingIdentity, [1]) ||
   !buffersEqual(staged.bytes, plan.snapshot.bytes)
  ) {
   refuse("backup");
  }
  assertPrivatePuidOwned(staged.fingerprint);

  await assertDirectoryWithoutSymlinks(parentDirectory, "backup");
  try {
   await fs.link(stagingPath, backupPath);
   backupPublished = true;
  } catch (error) {
   if (error?.code !== "EEXIST") {
    throw error;
   }
   await cleanupStaging(stagingPath, stagingIdentity);
   await readVerifiedExistingBackup(backupPath, plan.snapshot.bytes);
   return { backupPath, created: false };
  }
  const linkedFinal = await fs.lstat(backupPath);
  const linkedStaging = await fs.lstat(stagingPath);
  if (
   !hasAttemptOwnedFileIdentity(linkedFinal, stagingIdentity, [2]) ||
   !hasAttemptOwnedFileIdentity(linkedStaging, stagingIdentity, [2])
  ) {
   refuse("backup");
  }
  await fs.unlink(stagingPath);
  await syncParentDirectory(parentDirectory);

  const final = await readVerifiedExistingBackup(backupPath, plan.snapshot.bytes);
  if (!hasAttemptOwnedFileIdentity(final.fingerprint, stagingIdentity, [1])) {
   refuse("backup");
  }
  return { backupPath, created: true };
 } catch (error) {
  if (stagingHandle) {
   try {
    await stagingHandle.close();
   } catch {
    // The identity check below is still authoritative for cleanup.
   }
  }
  if (stagingIdentity) {
   if (backupPublished) {
    await removeAttemptOwnedFile(backupPath, stagingIdentity, [1, 2]);
   }
   await cleanupStaging(stagingPath, stagingIdentity);
  }
  if (error instanceof ExecApprovalsMigrationRefused) {
   throw error;
  }
  refuse("backup");
 }
}

function assertMigrationResult(result) {
 // Upstream may coalesce or repeat known report entries depending on which
 // recovery path converged. Treat the report as advisory: accept only known
 // success messages and no warnings, then prove the authoritative filesystem
 // and detection postconditions below. Exact key/count equality made a safe,
 // completed import fail nondeterministically.
 if (
  !isRecord(result) ||
  !Array.isArray(result.changes) ||
  !Array.isArray(result.warnings) ||
  !Array.isArray(result.notices) ||
  result.warnings.length !== 0 ||
  !result.changes.every((change) => typeof change === "string" && SUCCESS_CHANGES.has(change)) ||
  !result.notices.every((notice) => notice === SUCCESS_NOTICE)
 ) {
  refuse("result");
 }
}

async function assertAbsent(filePath) {
 try {
  await fs.lstat(filePath);
 } catch (error) {
  if (error?.code === "ENOENT") {
   return;
  }
  refuse("convergence");
 }
 refuse("convergence");
}

async function main() {
 if (process.argv.length !== 2) {
  refuse("arguments");
 }

 const runtimePaths = resolveRuntimePaths();
 await assertDirectoryWithoutSymlinks(runtimePaths.stateDir, "paths");
 const adapter = await loadRuntime(await readRuntimeRecord());
 const migrationEnv = Object.freeze({
  ...process.env,
  HOME: runtimePaths.home,
  OPENCLAW_HOME: runtimePaths.home,
  OPENCLAW_STATE_DIR: runtimePaths.stateDir,
  OPENCLAW_CONFIG_DIR: runtimePaths.configDir,
  OPENCLAW_CONFIG_PATH: runtimePaths.configPath,
  OPENCLAW_WORKSPACE_DIR: runtimePaths.workspaceDir,
 });
 const detectionParameters = {
  stateDir: runtimePaths.stateDir,
  doctorOnlyStateMigrations: true,
 };

 let detected;
 try {
  detected = adapter.detectLegacyExecApprovals(detectionParameters);
 } catch {
  refuse("detection");
 }
 assertDetectionShape(detected, runtimePaths.stateDir);
 if (!detected.hasLegacy) {
  let confirmed;
  try {
   confirmed = adapter.detectLegacyExecApprovals(detectionParameters);
  } catch {
   refuse("detection");
  }
  assertDetectionShape(confirmed, runtimePaths.stateDir);
  if (confirmed.hasLegacy) {
   refuse("convergence");
  }
  return "exec-approvals-migration: no-op";
 }

 const plan = await inspectActiveSource(detected.sourcePath);
 const backup = await ensureVerifiedBackup(plan);
 const current = await openStableRegularFile(plan.activePath, SOURCE_MAX_BYTES, "source");
 if (!snapshotsMatch(plan.snapshot, current)) {
  refuse("source");
 }
 await readVerifiedExistingBackup(backup.backupPath, plan.snapshot.bytes);

 let migrated;
 try {
  migrated = await adapter.migrateLegacyExecApprovals({
   detected,
   stateDir: runtimePaths.stateDir,
   env: migrationEnv,
  });
 } catch {
  refuse("migration");
 }
 assertMigrationResult(migrated);

 let after;
 try {
  after = adapter.detectLegacyExecApprovals(detectionParameters);
 } catch {
  refuse("convergence");
 }
 assertDetectionShape(after, runtimePaths.stateDir);
 if (after.hasLegacy) {
  refuse("convergence");
 }
 await Promise.all([
  assertAbsent(detected.sourcePath),
  assertAbsent(`${detected.sourcePath}${CLAIM_SUFFIX}`),
  readVerifiedExistingBackup(backup.backupPath, plan.snapshot.bytes),
 ]);
 return "exec-approvals-migration: applied";
}

main()
 .then((status) => {
  process.stdout.write(`${status}\n`);
 })
 .catch((error) => {
  const code = error instanceof ExecApprovalsMigrationRefused ? error.code : "internal";
  process.stdout.write(`exec-approvals-migration: refused code=${code}\n`);
  process.exitCode = 1;
 });
