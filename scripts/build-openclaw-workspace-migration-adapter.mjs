#!/usr/bin/env node
/**
 * Bind the image to OpenClaw's workspace-only legacy-state importer.
 *
 * The upstream compiled chunk name is an implementation detail. This build
 * step discovers exactly one compatible ESM module, verifies its live exports,
 * and creates an intentionally tiny same-directory adapter. Runtime consumes
 * the immutable record rather than guessing a chunk name.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_EXPORTS = ["detectLegacyWorkspaceState", "migrateLegacyWorkspaceState"];
const ADAPTER_BASENAME = "openclaw-unraid-workspace-migration-adapter.mjs";
const RECORD_VERSION = 1;
const CONFIG_FACADE_RELATIVE_PATH = "index.js";
const DOCTOR_MODULE_FILENAME = /^state-migrations\.doctor-[A-Za-z0-9_-]+\.js$/;

class BuildContractError extends Error { }

function sha256(contents) {
 return createHash("sha256").update(contents).digest("hex");
}

function moduleUrl(modulePath) {
 return pathToFileURL(modulePath).href;
}

function hasExactlyOneNamedFunctionDeclaration(source, name) {
 const declaration = new RegExp(
  String.raw`(?:^|[;}\n])\s*(?:async\s+)?function\s+${name}\s*\(`,
  "g",
 );
 return [...source.matchAll(declaration)].length === 1;
}

function patchDoctorModuleExports(source) {
 const terminalExport = /^(?<body>[\s\S]*?)(?<separator>(?:^|[;\n])\s*)export\s*\{(?<members>[^{}]*)\};?\s*$/;
 const match = terminalExport.exec(source);
 if (!match?.groups) {
  throw new BuildContractError("OpenClaw doctor module does not have the expected terminal export shape");
 }

 const members = match.groups.members
  .split(",")
  .map((member) => member.trim())
  .filter(Boolean);
 const exportedNames = members.map((member) => {
  const memberMatch = /^(?<local>[A-Za-z_$][\w$]*)(?:\s+as\s+(?<exported>[A-Za-z_$][\w$]*))?$/.exec(
   member,
  );
  if (!memberMatch?.groups) {
   throw new BuildContractError("OpenClaw doctor module has an unexpected export member");
  }
  return memberMatch.groups.exported ?? memberMatch.groups.local;
 });
 if (
  exportedNames.length === 0 ||
  new Set(exportedNames).size !== exportedNames.length ||
  REQUIRED_EXPORTS.some((name) => exportedNames.includes(name))
 ) {
  throw new BuildContractError("OpenClaw doctor module has an unexpected public export surface");
 }

 return [
  `${match.groups.body}${match.groups.separator}`.trimEnd(),
  "export { detectLegacyWorkspaceState, migrateLegacyWorkspaceState };",
  "",
 ].join("\n");
}

async function findWorkspaceMigrationModule(distDir) {
 const entries = await fs.readdir(distDir, { withFileTypes: true });
 entries.sort((left, right) => left.name.localeCompare(right.name));
 const candidates = [];

 for (const entry of entries) {
  if (!entry.isFile() || !DOCTOR_MODULE_FILENAME.test(entry.name)) {
   continue;
  }
  const sourceModulePath = path.join(distDir, entry.name);
  const sourceBytes = await fs.readFile(sourceModulePath);
  const source = sourceBytes.toString("utf8");
  if (!REQUIRED_EXPORTS.every((name) => hasExactlyOneNamedFunctionDeclaration(source, name))) {
   continue;
  }
  candidates.push({ sourceModulePath, sourceBytes, source });
 }

 if (candidates.length !== 1) {
  throw new BuildContractError(
   "expected exactly one top-level OpenClaw doctor module with the required function declarations",
  );
 }
 return candidates[0];
}

async function assertConfigFacade(distDir) {
 const configModulePath = path.join(distDir, CONFIG_FACADE_RELATIVE_PATH);
 let namespace;
 try {
  namespace = await import(moduleUrl(configModulePath));
 } catch {
  throw new BuildContractError("OpenClaw config loader facade is unavailable");
 }
 if (typeof namespace.loadConfig !== "function") {
  throw new BuildContractError("OpenClaw config loader facade has an unexpected export shape");
 }
 return configModulePath;
}

async function writeNewFile(filePath, contents, mode) {
 const handle = await fs.open(filePath, "wx", mode);
 try {
  await handle.writeFile(contents, "utf8");
  await handle.sync();
 } finally {
  await handle.close();
 }
}

async function main() {
 const [distDirArgument, recordPathArgument] = process.argv.slice(2);
 if (!distDirArgument || !recordPathArgument || process.argv.length !== 4) {
  throw new BuildContractError("usage: build-openclaw-workspace-migration-adapter.mjs DIST_DIR RECORD_PATH");
 }

 const distDir = path.resolve(distDirArgument);
 const recordPath = path.resolve(recordPathArgument);
 const doctorModule = await findWorkspaceMigrationModule(distDir);
 const sourceModulePath = doctorModule.sourceModulePath;
 const configModulePath = await assertConfigFacade(distDir);
 const adapterPath = path.join(path.dirname(sourceModulePath), ADAPTER_BASENAME);
 const adapterSource = patchDoctorModuleExports(doctorModule.source);

 await writeNewFile(adapterPath, adapterSource, 0o644);
 const adapterNamespace = await import(moduleUrl(adapterPath));
 const adapterExports = Object.keys(adapterNamespace).sort();
 const requiredAdapterExports = [...REQUIRED_EXPORTS].sort();
 if (
  adapterExports.length !== requiredAdapterExports.length ||
  adapterExports.some((name, index) => name !== requiredAdapterExports[index]) ||
  REQUIRED_EXPORTS.some((name) => typeof adapterNamespace[name] !== "function")
 ) {
  throw new BuildContractError("generated workspace migration adapter has an unexpected export shape");
 }

 await fs.mkdir(path.dirname(recordPath), { recursive: true });
 const record = {
  version: RECORD_VERSION,
  adapterPath,
  adapterSha256: sha256(adapterSource),
  sourceModulePath,
  sourceModuleSha256: sha256(doctorModule.sourceBytes),
  configModulePath,
  configModuleSha256: sha256(await fs.readFile(configModulePath)),
 };
 await writeNewFile(recordPath, `${JSON.stringify(record)}\n`, 0o644);
 process.stdout.write("openclaw workspace migration adapter ready\n");
}

main().catch((error) => {
 const message = error instanceof BuildContractError ? error.message : "workspace migration adapter build failed";
 process.stderr.write(`${message}\n`);
 process.exitCode = 1;
});
