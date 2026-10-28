#!/usr/bin/env node
/** Bind this image to the exact compiled legacy default-agent role materializer. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const REQUIRED_EXPORT = "materializeLegacyDefaultAgentRoles";
const OPTIONAL_EXPORT = "retireLegacyAgentDefaultMarkers";
const CRON_GUARD_EXPORT = "assertLegacyCronOwnershipBeforeConfigWrite";
const ADAPTER_BASENAME = "openclaw-unraid-default-agent-roles-adapter.mjs";
const CHUNK_FILENAME = /^legacy(?:\.roster)?-[A-Za-z0-9_-]+\.(?:mjs|js)$/;
const RECORD_VERSION = 1;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

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

function patchModuleExports(source, cronSafetyModules) {
  const terminalExport = /^(?<body>[\s\S]*?)(?<separator>(?:^|[;\n])\s*)export\s*\{(?<members>[^{}]*)\};?\s*$/;
  const match = terminalExport.exec(source);
  if (!match?.groups) {
    throw new BuildContractError("OpenClaw default-agent roles module does not have the expected terminal export shape");
  }

  const exportedNames = match.groups.members
    .split(",")
    .map((member) => member.trim())
    .filter(Boolean)
    .map((member) => {
      const memberMatch = /^(?<local>[A-Za-z_$][\w$]*)(?:\s+as\s+(?<exported>[A-Za-z_$][\w$]*))?$/.exec(member);
      if (!memberMatch?.groups) {
        throw new BuildContractError("OpenClaw default-agent roles module has an unexpected export member");
      }
      return memberMatch.groups.exported ?? memberMatch.groups.local;
    });
  if (
    exportedNames.length === 0 ||
    new Set(exportedNames).size !== exportedNames.length ||
    exportedNames.includes(REQUIRED_EXPORT)
  ) {
    throw new BuildContractError("OpenClaw default-agent roles module has an unexpected public export surface");
  }

  return [
    `${match.groups.body}${match.groups.separator}`.trimEnd(),
    ...(cronSafetyModules.length === 0 ? [] : [
      `import { ${cronSafetyModules[0].exportedName} as unraidCronOwnerGuard } from ${JSON.stringify(`./${path.basename(cronSafetyModules[0].sourceModulePath)}`)};`,
      `import { ${cronSafetyModules[1].exportedName} as unraidArtifactPreservingStateReads } from ${JSON.stringify(`./${path.basename(cronSafetyModules[1].sourceModulePath)}`)};`,
      `async function ${CRON_GUARD_EXPORT}(sourceConfig, nextConfig, env) {`,
      "  return unraidArtifactPreservingStateReads(() => unraidCronOwnerGuard({",
      "    env, nextConfig, snapshot: { sourceConfigBeforeMigrations: sourceConfig, sourceConfig, parsed: sourceConfig, config: sourceConfig },",
      "  }), { agentDatabases: true });",
      "}",
    ]),
    `export { ${[REQUIRED_EXPORT, ...(cronSafetyModules.length === 0 ? [] : [OPTIONAL_EXPORT, CRON_GUARD_EXPORT])].join(", ")} };`,
    "",
  ].join("\n");
}

async function findDefaultAgentRolesModule(distDir) {
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
    try {
      source = utf8Decoder.decode(sourceBytes);
    } catch {
      continue;
    }
    if (!hasExactlyOneNamedFunctionDeclaration(source, REQUIRED_EXPORT)) {
      continue;
    }
    candidates.push({ sourceModulePath, sourceBytes, source });
  }

  if (candidates.length !== 1) {
    throw new BuildContractError("expected exactly one top-level OpenClaw default-agent roles module");
  }
  return candidates[0];
}

async function findNamedFunctionModule(distDir, prefix, functionName) {
  const candidates = [];
  for (const entry of await fs.readdir(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(`${prefix}-`) || !/\.(?:mjs|js)$/.test(entry.name)) continue;
    const sourceModulePath = path.join(distDir, entry.name);
    const sourceBytes = await fs.readFile(sourceModulePath);
    const source = utf8Decoder.decode(sourceBytes);
    if (!hasExactlyOneNamedFunctionDeclaration(source, functionName)) continue;
    const terminal = /(?:^|\n)export\s*\{(?<members>[^{}]*)\};?\s*$/.exec(source);
    const mapping = terminal?.groups?.members.match(new RegExp(String.raw`(?:^|,)\s*${functionName}(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*(?=,|$)`));
    if (!mapping) continue;
    const exportedName = mapping[1] ?? functionName;
    const namespace = await import(moduleUrl(sourceModulePath));
    if (typeof namespace[exportedName] !== "function") continue;
    candidates.push({ sourceModulePath, sourceBytes, exportedName });
  }
  if (candidates.length !== 1) throw new BuildContractError(`expected exactly one OpenClaw ${functionName} module`);
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
    throw new BuildContractError("usage: build-openclaw-default-agent-roles-adapter.mjs DIST_DIR RECORD_PATH");
  }

  const distDir = path.resolve(distDirArgument);
  const recordPath = path.resolve(recordPathArgument);
  const sourceModule = await findDefaultAgentRolesModule(distDir);
  const cronSafetyModules = hasExactlyOneNamedFunctionDeclaration(sourceModule.source, OPTIONAL_EXPORT)
    ? await Promise.all([
      findNamedFunctionModule(distDir, "legacy-owner", "repairLegacyCronOwnersBeforeConfigWrite"),
      findNamedFunctionModule(distDir, "artifact-preserving-state-reads", "withArtifactPreservingStateReads"),
    ])
    : [];
  const adapterPath = path.join(path.dirname(sourceModule.sourceModulePath), ADAPTER_BASENAME);
  const adapterSource = patchModuleExports(sourceModule.source, cronSafetyModules);

  await writeNewFile(adapterPath, adapterSource, 0o644);
  const adapter = await import(moduleUrl(adapterPath));
  const adapterExports = Object.keys(adapter).sort();
  if (
    adapterExports.join(",") !== [REQUIRED_EXPORT, ...(cronSafetyModules.length === 0 ? [] : [OPTIONAL_EXPORT, CRON_GUARD_EXPORT])].sort().join(",") ||
    adapterExports.some((name) => typeof adapter[name] !== "function")
  ) {
    throw new BuildContractError("generated default-agent roles adapter has an unexpected export shape");
  }

  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  const record = {
    version: RECORD_VERSION,
    adapterPath,
    adapterSha256: sha256(adapterSource),
    sourceModulePath: sourceModule.sourceModulePath,
    sourceModuleSha256: sha256(sourceModule.sourceBytes),
    ...(cronSafetyModules.length === 0 ? {} : {
      cronSafetyModules: cronSafetyModules.map((module) => ({
        path: module.sourceModulePath,
        sha256: sha256(module.sourceBytes),
      })),
    }),
  };
  await writeNewFile(recordPath, `${JSON.stringify(record)}\n`, 0o644);
  process.stdout.write("openclaw default-agent roles adapter ready\n");
}

main().catch((error) => {
  const message = error instanceof BuildContractError ? error.message : "default-agent roles adapter build failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
