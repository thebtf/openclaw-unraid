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
const OPTIONAL_ADAPTER_EXPORT = "retireLegacyAgentDefaultMarkers";
const CRON_GUARD_EXPORT = "assertLegacyCronOwnershipBeforeConfigWrite";
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
  ![
   "adapterPath\u0000adapterSha256\u0000sourceModulePath\u0000sourceModuleSha256\u0000version",
   "adapterPath\u0000adapterSha256\u0000cronSafetyModules\u0000sourceModulePath\u0000sourceModuleSha256\u0000version",
  ].includes(Object.keys(parsed).sort().join("\u0000")) ||
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
 if (Object.hasOwn(parsed, "cronSafetyModules") && (
  !Array.isArray(parsed.cronSafetyModules) || parsed.cronSafetyModules.length !== 2 ||
  parsed.cronSafetyModules.some((module) => !isRecord(module) ||
   Object.keys(module).sort().join(",") !== "path,sha256" ||
   !isAbsoluteNormalizedPath(module.path) || !module.path.startsWith("/app/dist/")) ||
  new Set(parsed.cronSafetyModules.map((module) => module.path)).size !== 2
 )) refuse("record");
 return parsed;
}

async function loadRuntime(record) {
 await Promise.all([
  hashStableRuntimeArtifact(record.adapterPath, record.adapterSha256),
  hashStableRuntimeArtifact(record.sourceModulePath, record.sourceModuleSha256),
  ...(record.cronSafetyModules ?? []).map((module) => hashStableRuntimeArtifact(module.path, module.sha256)),
 ]);

 let adapter;
 try {
  adapter = await import(pathToFileURL(record.adapterPath).href);
 } catch {
  refuse("runtime");
 }
 const exports = Object.keys(adapter).sort();
 if (
  ![REQUIRED_ADAPTER_EXPORT, [REQUIRED_ADAPTER_EXPORT, OPTIONAL_ADAPTER_EXPORT, CRON_GUARD_EXPORT].sort().join(",")].includes(exports.join(",")) ||
  Object.hasOwn(adapter, OPTIONAL_ADAPTER_EXPORT) !== Object.hasOwn(record, "cronSafetyModules") ||
  exports.some((name) => typeof adapter[name] !== "function")
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
  return { applicable: false };
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
 if (config.agents.ownership === "explicit" && typeof config.agents.defaults?.systemAgent?.agentId === "string") {
  return { applicable: false };
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

function assertInsertedPaths(insertedPaths, agentId = "main") {
 if (!Array.isArray(insertedPaths)) {
  refuse("result");
 }
 const allowed = new Set([
  pathKey(["agents", "entries", agentId, "workspace"]),
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

function assertMaterializationResult(result, agentId = "main") {
 if (
  !isRecord(result) ||
  Object.keys(result).sort().join("\u0000") !== "config\u0000insertedPaths" ||
  !isRecord(result.config)
 ) {
  refuse("result");
 }
 return { config: result.config, inserted: assertInsertedPaths(result.insertedPaths, agentId) };
}

function assertOwnerEntry(beforeEntry, afterEntry, inserted, workspaceDir, agentId) {
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

 const workspacePath = pathKey(["agents", "entries", agentId, "workspace"]);
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

function assertDefaultTarget(beforeValue, afterValue, inserted, key, agentId) {
 const insertedPath = pathKey(["agents", "defaults", key, "agentId"]);
 if (!inserted.has(insertedPath)) {
  if (!isDeepStrictEqual(beforeValue, afterValue)) {
   refuse("result");
  }
  return;
 }
 if (!isRecord(afterValue) || afterValue.agentId !== agentId || Object.hasOwn(beforeValue ?? {}, "agentId")) {
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

function assertBindings(before, after, inserted, agentId) {
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
   binding.agentId !== agentId ||
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

function assertTalk(before, after, inserted, agentId) {
 const insertedPath = pathKey(["talk", "agentId"]);
 if (before === undefined) {
  if (!inserted.has(insertedPath) || !isRecord(after) || after.agentId !== agentId || Object.keys(after).length !== 1) {
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
 if (Object.hasOwn(before, "agentId") || after.agentId !== agentId) {
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

function assertMaterializedConfig(before, after, inserted, workspaceDir, agentId = "main") {
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
  if (key === agentId) {
   assertOwnerEntry(beforeEntries[key], afterEntries[key], inserted, workspaceDir, agentId);
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
   assertDefaultTarget(defaultsBefore[key], defaultsAfter[key], inserted, key, agentId);
  } else if (!isDeepStrictEqual(defaultsBefore[key], defaultsAfter[key])) {
   refuse("result");
  }
 }
 for (const key of Object.keys(defaultsAfter)) {
  if (!Object.hasOwn(defaultsBefore, key)) {
   if (!ROLE_DEFAULT_KEYS.has(key)) {
    refuse("result");
   }
   assertDefaultTarget(undefined, defaultsAfter[key], inserted, key, agentId);
  }
 }

 assertBindings(before.bindings, after.bindings, inserted, agentId);
 assertTalk(before.talk, after.talk, inserted, agentId);
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

async function retireDefaultMarkers(adapter, runtimePaths) {
 const chunks = [];
 let length = 0;
 for await (const chunk of process.stdin) {
  length += chunk.length;
  if (length > CONFIG_MAX_BYTES) refuse("config");
  chunks.push(chunk);
 }
 const config = JSON.parse(utf8Decoder.decode(Buffer.concat(chunks)));
 if (!isRecord(config) || !isRecord(config.agents?.entries)) refuse("roster");
 const entries = config.agents.entries;
 const ids = Object.keys(entries);
 if (!ids.every((id) => isAgentId(id) && isRecord(entries[id]) &&
  (!Object.hasOwn(entries[id], "default") || typeof entries[id].default === "boolean"))) refuse("roster");
 const marked = ids.filter((id) => entries[id].default === true);
 if (marked.length > 1 || (marked.length > 0 && config.agents.ownership !== undefined)) refuse("roster");
 if (!adapter.retireLegacyAgentDefaultMarkers) return JSON.stringify({ config, paths: [] });
 const expected = structuredClone(config);
 const paths = [];
 for (const id of ids) {
  if (Object.hasOwn(expected.agents.entries[id], "default")) {
   delete expected.agents.entries[id].default;
   paths.push("agents.entries.*.default");
  }
 }
 const owner = ids.length > 1 ? marked[0] : undefined;
 const retired = adapter.retireLegacyAgentDefaultMarkers(config);
 if (!isRecord(retired) || retired.agentCount !== ids.length || retired.legacyOwner !== owner ||
  !isDeepStrictEqual(retired.config, expected)) refuse("result");
 let next = retired.config;
 if (owner) {
  validateFieldConfig(next, { entries: next.agents.entries });
  const options = { ambientChannelIds: ["telegram"], env: process.env, materializeSessionStore: true, materializeWorkspace: true };
  const materialized = adapter.materializeLegacyDefaultAgentRoles(next, owner, options);
  const result = assertMaterializationResult(materialized, owner);
  const workspace = next.agents.defaults?.workspace;
  const expectedWorkspace = typeof workspace === "string" && workspace.trim() ? workspace.trim() : runtimePaths.workspaceDir;
  assertMaterializedConfig(next, result.config, result.inserted, expectedWorkspace, owner);
  const idempotent = assertMaterializationResult(adapter.materializeLegacyDefaultAgentRoles(result.config, owner, options), owner);
  if (idempotent.inserted.size !== 0 || !isDeepStrictEqual(idempotent.config, result.config)) refuse("result");
  next = result.config;
  for (const inserted of materialized.insertedPaths) {
   paths.push(inserted.map((part, index) => index === 2 && inserted[0] === "agents" && inserted[1] === "entries" ? "*" : part).join("."));
  }
 }
 if (ids.length > 1 && next.agents.ownership === undefined) {
  next.agents.ownership = "explicit";
  paths.push("agents.ownership");
 }
 if (marked.length > 0) {
  // Authored templates are not resolved cron partitions, including escaped forms.
  if (typeof config.cron?.store === "string" && config.cron.store.includes("${")) refuse("cron-ownership");
  try {
   const checked = await adapter.assertLegacyCronOwnershipBeforeConfigWrite(config, next, process.env);
   if (!Array.isArray(checked) || checked.length !== 0) refuse("cron-ownership");
  } catch {
   refuse("cron-ownership");
  }
 }
 return JSON.stringify({ config: next, paths: [...new Set(paths)] });
}

async function main() {
 if (process.argv.length === 3 && process.argv[2] === "--retire-default-markers") {
  return retireDefaultMarkers(await loadRuntime(await readRuntimeRecord()), resolveRuntimePaths());
 }
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
