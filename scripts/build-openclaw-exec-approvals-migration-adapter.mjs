#!/usr/bin/env node
/** Bind this image to the exact compiled exec-approvals migration chunk. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const REQUIRED_EXPORTS = ["detectLegacyExecApprovals", "migrateLegacyExecApprovals"];
const COMPILED_EXPORTS = {
  detectLegacyExecApprovals: "t",
  migrateLegacyExecApprovals: "n",
};
const ADAPTER_BASENAME = "openclaw-unraid-exec-approvals-migration-adapter.mjs";
const CHUNK_FILENAME = /^state-migrations\.exec-approvals-[A-Za-z0-9_-]+\.js$/;
const RECORD_VERSION = 1;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

class BuildContractError extends Error { }

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function moduleUrl(modulePath) {
  return pathToFileURL(modulePath).href;
}

function parseTerminalExports(source) {
  const terminalExport = /^(?<body>[\s\S]*?)(?<separator>(?:^|[;\n])\s*)export\s*\{(?<members>[^{}]*)\};?\s*$/;
  const match = terminalExport.exec(source);
  if (!match?.groups) {
    throw new BuildContractError("OpenClaw exec approvals module does not have the expected terminal export shape");
  }

  const mappings = [];
  for (const member of match.groups.members.split(",").map((value) => value.trim()).filter(Boolean)) {
    const memberMatch = /^(?<local>[A-Za-z_$][\w$]*)(?:\s+as\s+(?<exported>[A-Za-z_$][\w$]*))?$/.exec(member);
    if (!memberMatch?.groups) {
      throw new BuildContractError("OpenClaw exec approvals module has an unexpected export member");
    }
    mappings.push({
      local: memberMatch.groups.local,
      exported: memberMatch.groups.exported ?? memberMatch.groups.local,
    });
  }
  if (mappings.length === 0 || new Set(mappings.map((mapping) => mapping.exported)).size !== mappings.length) {
    throw new BuildContractError("OpenClaw exec approvals module has an ambiguous public export surface");
  }
  return { body: match.groups.body, separator: match.groups.separator, mappings };
}

function patchModuleExports(source) {
  const parsed = parseTerminalExports(source);
  const byExportedName = new Map(parsed.mappings.map((mapping) => [mapping.exported, mapping.local]));
  if (!REQUIRED_EXPORTS.every((name) => byExportedName.has(COMPILED_EXPORTS[name]))) {
    throw new BuildContractError("OpenClaw exec approvals module is missing an exact v2026.8.2 export");
  }
  const selected = REQUIRED_EXPORTS.map(
    (name) => `${byExportedName.get(COMPILED_EXPORTS[name])} as ${name}`,
  );
  return [
    `${parsed.body}${parsed.separator}`.trimEnd(),
    `export { ${selected.join(", ")} };`,
    "",
  ].join("\n");
}

async function findExecApprovalsModule(distDir) {
  const entries = await fs.readdir(distDir, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isFile() || !CHUNK_FILENAME.test(entry.name)) {
      continue;
    }
    const sourceModulePath = path.join(distDir, entry.name);
    const sourceBytes = await fs.readFile(sourceModulePath);
    let source;
    let exports;
    try {
      source = utf8Decoder.decode(sourceBytes);
      exports = parseTerminalExports(source);
    } catch {
      continue;
    }
    if (!REQUIRED_EXPORTS.every((name) => exports.mappings.some((mapping) => mapping.exported === COMPILED_EXPORTS[name]))) {
      continue;
    }
    candidates.push({ sourceModulePath, sourceBytes, source });
  }

  if (candidates.length !== 1) {
    throw new BuildContractError("expected exactly one top-level OpenClaw exec approvals migration module");
  }
  return candidates[0];
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
    throw new BuildContractError("usage: build-openclaw-exec-approvals-migration-adapter.mjs DIST_DIR RECORD_PATH");
  }

  const distDir = path.resolve(distDirArgument);
  const recordPath = path.resolve(recordPathArgument);
  const sourceModule = await findExecApprovalsModule(distDir);
  const adapterPath = path.join(path.dirname(sourceModule.sourceModulePath), ADAPTER_BASENAME);
  const adapterSource = patchModuleExports(sourceModule.source);

  await writeNewFile(adapterPath, adapterSource, 0o644);
  const adapter = await import(moduleUrl(adapterPath));
  const adapterExports = Object.keys(adapter).sort();
  const requiredExports = [...REQUIRED_EXPORTS].sort();
  if (
    adapterExports.length !== requiredExports.length ||
    adapterExports.some((name, index) => name !== requiredExports[index]) ||
    REQUIRED_EXPORTS.some((name) => typeof adapter[name] !== "function")
  ) {
    throw new BuildContractError("generated exec approvals migration adapter has an unexpected export shape");
  }

  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  const record = {
    version: RECORD_VERSION,
    adapterPath,
    adapterSha256: sha256(adapterSource),
    sourceModulePath: sourceModule.sourceModulePath,
    sourceModuleSha256: sha256(sourceModule.sourceBytes),
  };
  await writeNewFile(recordPath, `${JSON.stringify(record)}\n`, 0o644);
  process.stdout.write("openclaw exec approvals migration adapter ready\n");
}

main().catch((error) => {
  const message = error instanceof BuildContractError ? error.message : "exec approvals migration adapter build failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
