#!/usr/bin/env node
/**
 * Materialize the upstream legacy implicit-main roles for a field-shaped
 * multi-agent roster. The exact compiled OpenClaw function owns the mapping;
 * this helper pins its build artifact, guards the eligible input shape, and
 * publishes a natively validated config atomically without logging its data.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fsConstants from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, TextDecoder } from "node:util";

const RECORD_PATH = "/usr/local/lib/openclaw-unraid-default-agent-roles.json";
const ADAPTER_BASENAME = "openclaw-unraid-default-agent-roles-adapter.mjs";
const REQUIRED_ADAPTER_EXPORT = "materializeLegacyDefaultAgentRoles";
const RUNTIME_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
const RUNTIME_RECORD_MAX_BYTES = 16 * 1024;
const CONFIG_MAX_BYTES = 32 * 1024 * 1024;
const VALIDATION_TIMEOUT_MS = 30_000;
const ROLE_DEFAULT_KEYS = new Set(["heartbeat", "systemAgent", "authInheritance", "sessionStore"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

class DefaultAgentRolesRefused extends Error {
 constructor(code) {
  super("default-agent roles migration refused");
  this.code = code;
 }
}

function refuse(code) {
 throw new DefaultAgentRolesRefused(code);
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
  if (error instanceof DefaultAgentRolesRefused) {
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
 const exports = Object.keys(adapter).sort();
 if (exports.length !== 1 || exports[0] !== REQUIRED_ADAPTER_EXPORT || typeof adapter[REQUIRED_ADAPTER_EXPORT] !== "function") {
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

function isAgentId(value) {
 return typeof value === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

function classifyLegacyRoster(config) {
 if (!Object.hasOwn(config, "agents") || config.agents === undefined) {
  return { applicable: false };
 }
 if (!isRecord(config.agents)) {
  refuse("roster");
 }
 if (!Object.hasOwn(config.agents, "entries") || config.agents.entries === undefined) {
  return { applicable: false };
 }
 if (!isRecord(config.agents.entries)) {
  refuse("roster");
 }

 const entries = config.agents.entries;
 const ids = Object.keys(entries);
 if (ids.length < 2) {
  return { applicable: false };
 }
 if (!ids.includes("main")) {
  refuse("roster");
 }
 for (const id of ids) {
  if (!isAgentId(id) || !isRecord(entries[id])) {
   refuse("roster");
  }
 }
 const explicitDefaults = ids.filter((id) => entries[id].default === true);
 if (explicitDefaults.length > 0) {
  if (explicitDefaults.length === 1 && explicitDefaults[0] === "main") {
   return { applicable: false };
  }
  refuse("roster");
 }
 return { applicable: true, entries, ids };
}

function validateFieldConfig(config, roster) {
 if (config.bindings !== undefined && !Array.isArray(config.bindings)) {
  refuse("config");
 }
 if (config.agents.defaults !== undefined && !isRecord(config.agents.defaults)) {
  refuse("config");
 }
 if (config.talk !== undefined && !isRecord(config.talk)) {
  refuse("config");
 }
 if (config.channels !== undefined && !isRecord(config.channels)) {
  refuse("config");
 }
 for (const binding of config.bindings ?? []) {
  if (!isRecord(binding)) {
   refuse("config");
  }
  if (binding.type === "acp") {
   continue;
  }
  if (!isAgentId(binding.agentId) || !Object.hasOwn(roster.entries, binding.agentId) || !isRecord(binding.match)) {
   refuse("config");
  }
  if (binding.match.channel !== undefined && (typeof binding.match.channel !== "string" || binding.match.channel.trim().length === 0)) {
   refuse("config");
  }
  if (binding.match.accountId !== undefined && (typeof binding.match.accountId !== "string" || binding.match.accountId.trim().length === 0)) {
   refuse("config");
  }
 }
}

function pathKey(pathParts) {
 return pathParts.join("\u0000");
}

function assertInsertedPaths(insertedPaths) {
 if (!Array.isArray(insertedPaths)) {
  refuse("result");
 }
 const allowed = new Set([
  pathKey(["agents", "entries", "main", "workspace"]),
  pathKey(["bindings"]),
  ...[...ROLE_DEFAULT_KEYS].map((key) => pathKey(["agents", "defaults", key, "agentId"])),
  pathKey(["talk", "agentId"]),
 ]);
 const seen = new Set();
 for (const insertedPath of insertedPaths) {
  if (!Array.isArray(insertedPath) || insertedPath.length === 0 || !insertedPath.every((part) => typeof part === "string" && part.length > 0)) {
   refuse("result");
  }
  const key = pathKey(insertedPath);
  if (!allowed.has(key) || seen.has(key)) {
   refuse("result");
  }
  seen.add(key);
 }
 return seen;
}

function assertMaterializationResult(result) {
 if (
  !isRecord(result) ||
  Object.keys(result).sort().join("\u0000") !== "config\u0000insertedPaths" ||
  !isRecord(result.config)
 ) {
  refuse("result");
 }
 return { config: result.config, inserted: assertInsertedPaths(result.insertedPaths) };
}

function assertMainEntry(beforeEntry, afterEntry, inserted, workspaceDir) {
 if (!isRecord(afterEntry)) {
  refuse("result");
 }
 for (const key of Object.keys(beforeEntry)) {
  if (key !== "workspace" && !isDeepStrictEqual(beforeEntry[key], afterEntry[key])) {
   refuse("result");
  }
 }
 for (const key of Object.keys(afterEntry)) {
  if (!Object.hasOwn(beforeEntry, key) && key !== "workspace") {
   refuse("result");
  }
 }

 const workspacePath = pathKey(["agents", "entries", "main", "workspace"]);
 if (inserted.has(workspacePath)) {
  const prior = beforeEntry.workspace;
  if (prior !== undefined && !(typeof prior === "string" && prior.trim().length === 0)) {
   refuse("result");
  }
  if (afterEntry.workspace !== workspaceDir) {
   refuse("result");
  }
 } else if (!isDeepStrictEqual(beforeEntry.workspace, afterEntry.workspace)) {
  refuse("result");
 }
}

function assertDefaultTarget(beforeValue, afterValue, inserted, key) {
 const insertedPath = pathKey(["agents", "defaults", key, "agentId"]);
 if (!inserted.has(insertedPath)) {
  if (!isDeepStrictEqual(beforeValue, afterValue)) {
   refuse("result");
  }
  return;
 }
 if (!isRecord(afterValue) || afterValue.agentId !== "main") {
  refuse("result");
 }
 if (beforeValue !== undefined && !isRecord(beforeValue)) {
  refuse("result");
 }
 for (const property of Object.keys(beforeValue ?? {})) {
  if (property !== "agentId" && !isDeepStrictEqual(beforeValue[property], afterValue[property])) {
   refuse("result");
  }
 }
 for (const property of Object.keys(afterValue)) {
  if (!(property in (beforeValue ?? {})) && property !== "agentId") {
   refuse("result");
  }
 }
}

function isTelegramWildcard(binding) {
 if (!isRecord(binding) || !isRecord(binding.match)) {
  return false;
 }
 return binding.match.channel === "telegram" && binding.match.accountId === "*";
}

function assertBindings(before, after, inserted) {
 const beforeBindings = before ?? [];
 if (!Array.isArray(after) || after.length < beforeBindings.length) {
  refuse("result");
 }
 for (let index = 0; index < beforeBindings.length; index += 1) {
  if (!isDeepStrictEqual(beforeBindings[index], after[index])) {
   refuse("result");
  }
 }
 const appended = after.slice(beforeBindings.length);
 const bindingsInserted = inserted.has(pathKey(["bindings"]));
 if ((appended.length > 0) !== bindingsInserted) {
  refuse("result");
 }
 const channels = new Set();
 for (const binding of appended) {
  if (
   !isRecord(binding) ||
   Object.keys(binding).sort().join("\u0000") !== "agentId\u0000match" ||
   binding.agentId !== "main" ||
   !isRecord(binding.match) ||
   Object.keys(binding.match).sort().join("\u0000") !== "accountId\u0000channel" ||
   binding.match.accountId !== "*" ||
   typeof binding.match.channel !== "string" ||
   binding.match.channel.trim() !== binding.match.channel ||
   binding.match.channel.length === 0 ||
   channels.has(binding.match.channel)
  ) {
   refuse("result");
  }
  channels.add(binding.match.channel);
 }
 if (!beforeBindings.some(isTelegramWildcard) && !channels.has("telegram")) {
  refuse("result");
 }
}

function assertTalk(before, after, inserted) {
 const insertedPath = pathKey(["talk", "agentId"]);
 if (before === undefined) {
  if (!inserted.has(insertedPath) || !isRecord(after) || after.agentId !== "main" || Object.keys(after).length !== 1) {
   refuse("result");
  }
  return;
 }
 if (!isRecord(after)) {
  refuse("result");
 }
 if (!inserted.has(insertedPath)) {
  if (!isDeepStrictEqual(before, after)) {
   refuse("result");
  }
  return;
 }
 if (Object.hasOwn(before, "agentId") || after.agentId !== "main") {
  refuse("result");
 }
 for (const key of Object.keys(before)) {
  if (!isDeepStrictEqual(before[key], after[key])) {
   refuse("result");
  }
 }
 for (const key of Object.keys(after)) {
  if (!Object.hasOwn(before, key) && key !== "agentId") {
   refuse("result");
  }
 }
}

function assertMaterializedConfig(before, after, inserted, workspaceDir) {
 const allowedRootChanges = new Set(["agents", "bindings", "talk"]);
 for (const key of Object.keys(before)) {
  if (!allowedRootChanges.has(key) && !isDeepStrictEqual(before[key], after[key])) {
   refuse("result");
  }
 }
 for (const key of Object.keys(after)) {
  if (!Object.hasOwn(before, key) && !allowedRootChanges.has(key)) {
   refuse("result");
  }
 }
 if (!isRecord(after.agents) || !isRecord(after.agents.entries)) {
  refuse("result");
 }

 const beforeAgents = before.agents;
 const afterAgents = after.agents;
 for (const key of Object.keys(beforeAgents)) {
  if (key !== "entries" && key !== "defaults" && !isDeepStrictEqual(beforeAgents[key], afterAgents[key])) {
   refuse("result");
  }
 }
 for (const key of Object.keys(afterAgents)) {
  if (!Object.hasOwn(beforeAgents, key) && key !== "entries" && key !== "defaults") {
   refuse("result");
  }
 }

 const beforeEntries = beforeAgents.entries;
 const afterEntries = afterAgents.entries;
 if (!isRecord(beforeEntries) || Object.keys(beforeEntries).length !== Object.keys(afterEntries).length) {
  refuse("result");
 }
 for (const key of Object.keys(beforeEntries)) {
  if (!Object.hasOwn(afterEntries, key)) {
   refuse("result");
  }
  if (key === "main") {
   assertMainEntry(beforeEntries.main, afterEntries.main, inserted, workspaceDir);
  } else if (!isDeepStrictEqual(beforeEntries[key], afterEntries[key])) {
   refuse("result");
  }
 }

 const beforeDefaults = beforeAgents.defaults;
 const afterDefaults = afterAgents.defaults;
 if (beforeDefaults !== undefined && !isRecord(beforeDefaults)) {
  refuse("result");
 }
 if (afterDefaults !== undefined && !isRecord(afterDefaults)) {
  refuse("result");
 }
 const defaultsBefore = beforeDefaults ?? {};
 const defaultsAfter = afterDefaults ?? {};
 for (const key of Object.keys(defaultsBefore)) {
  if (ROLE_DEFAULT_KEYS.has(key)) {
   assertDefaultTarget(defaultsBefore[key], defaultsAfter[key], inserted, key);
  } else if (!isDeepStrictEqual(defaultsBefore[key], defaultsAfter[key])) {
   refuse("result");
  }
 }
 for (const key of Object.keys(defaultsAfter)) {
  if (!Object.hasOwn(defaultsBefore, key)) {
   if (!ROLE_DEFAULT_KEYS.has(key)) {
    refuse("result");
   }
   assertDefaultTarget(undefined, defaultsAfter[key], inserted, key);
  }
 }

 assertBindings(before.bindings, after.bindings, inserted);
 assertTalk(before.talk, after.talk, inserted);
}

function serializeConfig(config) {
 let serialized;
 let reparsed;
 try {
  serialized = `${JSON.stringify(config, null, 2)}\n`;
  reparsed = JSON.parse(serialized);
 } catch {
  refuse("result");
 }
 if (!isDeepStrictEqual(reparsed, config)) {
  refuse("result");
 }
 return Buffer.from(serialized, "utf8");
}

async function writeAll(handle, bytes) {
 let offset = 0;
 while (offset < bytes.length) {
  const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
  if (bytesWritten <= 0) {
   refuse("publish");
  }
  offset += bytesWritten;
 }
}

async function syncParentDirectory(directoryPath) {
 const directoryFlag = fsConstants.constants.O_DIRECTORY;
 if (typeof directoryFlag !== "number") {
  refuse("publish");
 }
 let handle;
 try {
  handle = await fs.open(
   directoryPath,
   fsConstants.constants.O_RDONLY | directoryFlag | noFollowFlag("publish"),
  );
  await handle.sync();
 } catch (error) {
  if (!(["EINVAL", "ENOTSUP", "ENOSYS"].includes(error?.code))) {
   refuse("publish");
  }
 } finally {
  if (handle) {
   await handle.close();
  }
 }
}

function hasAttemptOwnedFileIdentity(current, identity) {
 return (
  Boolean(identity) &&
  current.isFile() &&
  current.dev === identity.dev &&
  current.ino === identity.ino &&
  current.nlink === 1
 );
}

async function removeCandidate(candidatePath, identity) {
 try {
  await assertDirectoryWithoutSymlinks(path.dirname(candidatePath), "publish");
  const current = await fs.lstat(candidatePath);
  if (!hasAttemptOwnedFileIdentity(current, identity)) {
   refuse("publish");
  }
  await fs.unlink(candidatePath);
  await syncParentDirectory(path.dirname(candidatePath));
 } catch (error) {
  if (error instanceof DefaultAgentRolesRefused) {
   throw error;
  }
  refuse("publish");
 }
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
  refuse("publish");
 }
}

async function createCandidate(configPath, bytes) {
 const candidatePath = path.join(
  path.dirname(configPath),
  `.${path.basename(configPath)}.legacy-default-agent-roles-${randomUUID()}`,
 );
 let handle;
 let identity;
 try {
  handle = await fs.open(
   candidatePath,
   fsConstants.constants.O_WRONLY |
   fsConstants.constants.O_CREAT |
   fsConstants.constants.O_EXCL |
   noFollowFlag("publish"),
   0o600,
  );
  identity = await handle.stat();
  if (!hasAttemptOwnedFileIdentity(identity, identity)) {
   refuse("publish");
  }
  assertPrivatePuidOwned(identity);
  await writeAll(handle, bytes);
  const writtenIdentity = await handle.stat();
  if (!hasAttemptOwnedFileIdentity(writtenIdentity, identity)) {
   refuse("publish");
  }
  await handle.sync();
  await handle.close();
  handle = undefined;
  const candidate = await openStableRegularFile(candidatePath, CONFIG_MAX_BYTES, "publish");
  if (!hasAttemptOwnedFileIdentity(candidate.fingerprint, identity) || !buffersEqual(candidate.bytes, bytes)) {
   refuse("publish");
  }
  assertPrivatePuidOwned(candidate.fingerprint);
  return { candidatePath, identity };
 } catch (error) {
  if (handle) {
   try {
    await handle.close();
   } catch {
    // The identity check below remains authoritative for cleanup.
   }
  }
  if (identity) {
   await removeCandidate(candidatePath, identity);
  }
  if (error instanceof DefaultAgentRolesRefused) {
   throw error;
  }
  refuse("publish");
 }
}

function validateCandidate(runtimePaths, candidatePath) {
 const result = spawnSync(process.execPath, ["/app/dist/index.js", "config", "validate"], {
  env: {
   ...process.env,
   HOME: runtimePaths.home,
   OPENCLAW_HOME: runtimePaths.home,
   OPENCLAW_STATE_DIR: runtimePaths.stateDir,
   OPENCLAW_CONFIG_DIR: runtimePaths.configDir,
   OPENCLAW_CONFIG_PATH: candidatePath,
   OPENCLAW_WORKSPACE_DIR: runtimePaths.workspaceDir,
  },
  shell: false,
  stdio: "ignore",
  timeout: VALIDATION_TIMEOUT_MS,
  killSignal: "SIGKILL",
 });
 if (result.error || result.signal || result.status !== 0) {
  refuse("validation");
 }
}

async function publishValidatedConfig(runtimePaths, original, bytes) {
 const candidate = await createCandidate(runtimePaths.configPath, bytes);
 let published = false;
 try {
  validateCandidate(runtimePaths, candidate.candidatePath);
  const current = await openStableRegularFile(runtimePaths.configPath, CONFIG_MAX_BYTES, "config");
  if (!snapshotsMatch(original, current)) {
   refuse("config");
  }
  await assertDirectoryWithoutSymlinks(runtimePaths.configDir, "publish");
  await fs.rename(candidate.candidatePath, runtimePaths.configPath);
  published = true;
  await syncParentDirectory(runtimePaths.configDir);
  const final = await openStableRegularFile(runtimePaths.configPath, CONFIG_MAX_BYTES, "publish");
  if (!buffersEqual(final.bytes, bytes)) {
   refuse("publish");
  }
  assertPrivatePuidOwned(final.fingerprint);
 } catch (error) {
  if (!published) {
   await removeCandidate(candidate.candidatePath, candidate.identity);
  }
  throw error;
 }
}

async function main() {
 const dryRun = process.argv.length === 3 && process.argv[2] === "--dry-run";
 if (!dryRun && process.argv.length !== 2) {
  refuse("arguments");
 }

 const runtimePaths = resolveRuntimePaths();
 const adapter = await loadRuntime(await readRuntimeRecord());
 const original = await openStableRegularFile(runtimePaths.configPath, CONFIG_MAX_BYTES, "config");
 let config;
 try {
  config = JSON.parse(utf8Decoder.decode(original.bytes));
 } catch {
  refuse("config");
 }
 if (!isRecord(config)) {
  refuse("config");
 }

 const roster = classifyLegacyRoster(config);
 if (!roster.applicable) {
  return "default-agent-roles: already-materialized";
 }
 validateFieldConfig(config, roster);
 const options = Object.freeze({
  ambientChannelIds: Object.freeze(["telegram"]),
  env: Object.freeze({
   ...process.env,
   HOME: runtimePaths.home,
   OPENCLAW_HOME: runtimePaths.home,
   OPENCLAW_STATE_DIR: runtimePaths.stateDir,
   OPENCLAW_CONFIG_DIR: runtimePaths.configDir,
   OPENCLAW_CONFIG_PATH: runtimePaths.configPath,
   OPENCLAW_WORKSPACE_DIR: runtimePaths.workspaceDir,
  }),
  materializeSessionStore: true,
  materializeWorkspace: true,
 });

 let materialized;
 try {
  materialized = adapter.materializeLegacyDefaultAgentRoles(config, "main", options);
 } catch {
  refuse("materialize");
 }
 const result = assertMaterializationResult(materialized);
 assertMaterializedConfig(config, result.config, result.inserted, runtimePaths.workspaceDir);
 if ((result.inserted.size > 0) !== !isDeepStrictEqual(config, result.config)) {
  refuse("result");
 }

 let idempotent;
 try {
  idempotent = adapter.materializeLegacyDefaultAgentRoles(result.config, "main", options);
 } catch {
  refuse("materialize");
 }
 const idempotentResult = assertMaterializationResult(idempotent);
 if (idempotentResult.inserted.size !== 0 || !isDeepStrictEqual(idempotentResult.config, result.config)) {
  refuse("result");
 }

 if (result.inserted.size === 0) {
  return "default-agent-roles: already-materialized";
 }
 if (dryRun) {
  return "default-agent-roles: planned";
 }
 await publishValidatedConfig(runtimePaths, original, serializeConfig(result.config));
 return "default-agent-roles: applied";
}

main()
 .then((status) => {
  process.stdout.write(`${status}\n`);
 })
 .catch((error) => {
  const code = error instanceof DefaultAgentRolesRefused ? error.code : "internal";
  process.stdout.write(`default-agent-roles: refused code=${code}\n`);
  process.exitCode = 1;
 });
