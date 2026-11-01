#!/usr/bin/env node
/** Bind schema-only startup maintenance to this image's exact native exports. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONTRACTS = [
  [/^doctor-database-preflight-/, ["prepareDoctorDatabasePreflight"]],
  [/^doctor-maintenance-/, ["beginDoctorMaintenance"]],
  [/^doctor-migration-backup-/, ["backupDoctorMigrationDatabases"]],
  [/^doctor-migration-backup-artifacts-/, ["completeDoctorMigrationBackups"]],
  [/^openclaw-state-db-/, ["prepareOpenClawStateDatabaseSchema"]],
  [/^openclaw-agent-db-maintenance-lease-/, ["withAgentDatabaseMaintenanceLease"]],
  [/^openclaw-agent-db-maintenance-/, ["migrateOpenClawAgentDatabaseForMaintenance"]],
  [/^openclaw-database-preflight-/, ["preflightOpenClawDatabaseSchemas"]],
  [/^session-sqlite-migration-manifest-/, ["listSessionSqliteMigrationManifestPaths", "readSessionSqliteMigrationManifest", "readMigrationArtifactIdentity", "sameMigrationArtifact"]],
];
const BASENAME = "openclaw-unraid-schema-migration-adapter.mjs";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function main() {
  if (process.argv.length !== 4) throw Error("expected DIST_DIR RECORD_PATH");
  const dist = path.resolve(process.argv[2]);
  const recordPath = path.resolve(process.argv[3]);
  const names = (await fs.readdir(dist)).filter((name) => /\.(?:mjs|js)$/.test(name));
  const modules = [];
  const exports = [];
  let nativeSchema;
  for (const [pattern, required] of CONTRACTS) {
    const candidates = [];
    for (const name of names.filter((name) => pattern.test(name))) {
      const sourcePath = path.join(dist, name);
      const bytes = await fs.readFile(sourcePath);
      const source = bytes.toString("utf8");
      if (!required.every((symbol) => [...source.matchAll(new RegExp(`(?:^|[;}\\n])\\s*(?:async\\s+)?function\\s+${symbol}\\s*\\(`, "g"))].length === 1)) continue;
      const terminal = /(?:^|[;\n])\s*export\s*\{([^{}]*)\};?\s*$/.exec(source);
      if (!terminal) throw Error("native terminal exports changed");
      const mappings = terminal[1].split(",").map((member) => /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(member));
      if (mappings.some((mapping) => !mapping)) throw Error("native export mapping changed");
      const selected = required.map((symbol) => {
        const matches = mappings.filter((mapping) => mapping[1] === symbol);
        if (matches.length !== 1) throw Error("native export missing or ambiguous");
        return { local: symbol, exported: matches[0][2] ?? matches[0][1] };
      });
      candidates.push({ sourcePath, sha256: digest(bytes), selected, source });
    }
    if (candidates.length !== 1) throw Error("native schema capability missing or ambiguous");
    const candidate = candidates[0];
    const namespace = await import(pathToFileURL(candidate.sourcePath).href);
    if (candidate.selected.some(({ exported }) => typeof namespace[exported] !== "function")) throw Error("native schema capability type changed");
    if (required.includes("preflightOpenClawDatabaseSchemas")) {
      const defaults = [...candidate.source.matchAll(/const\s+supportedVersions\s*=\s*options\.supportedVersions\s*\?\?\s*\{\s*state:\s*(\d+)\s*,\s*agent:\s*(\d+)\s*,?\s*\}\s*;/g)];
      if (defaults.length !== 1) throw Error("native target-schema contract unavailable");
      nativeSchema = { stateVersion: Number(defaults[0][1]), agentVersion: Number(defaults[0][2]) };
      if (nativeSchema.stateVersion !== 20 || nativeSchema.agentVersion !== 25) throw Error("unsupported native target-schema class");
    }
    modules.push({ path: candidate.sourcePath, sha256: candidate.sha256 });
    exports.push(`export { ${candidate.selected.map(({ local, exported }) => `${exported} as ${local}`).join(", ")} } from ${JSON.stringify(`./${path.basename(candidate.sourcePath)}`)};`);
    if (required.includes("prepareOpenClawStateDatabaseSchema")) {
      if ([...candidate.source.matchAll(/(?:^|[;}\n])\s*function\s+isUninitializedNativeStartupDatabase\s*\(/g)].length !== 1 || !/import\s*\{[^}]*\bprepareSqliteReadOnlyLocation\b[^}]*\}\s*from/.test(candidate.source)) throw Error("native first-use classifier unavailable");
      const firstUsePath = path.join(dist, "openclaw-unraid-schema-first-use.mjs");
      const firstUseSource = `${candidate.source}\nexport { isUninitializedNativeStartupDatabase, prepareSqliteReadOnlyLocation };\n`;
      await fs.writeFile(firstUsePath, firstUseSource, { flag: "wx", mode: 0o644 });
      const firstUse = await import(pathToFileURL(firstUsePath).href);
      if (typeof firstUse.isUninitializedNativeStartupDatabase !== "function" || typeof firstUse.prepareSqliteReadOnlyLocation !== "function") throw Error("native first-use exports changed");
      modules.push({ path: firstUsePath, sha256: digest(firstUseSource) });
      exports.push('export { isUninitializedNativeStartupDatabase, prepareSqliteReadOnlyLocation } from "./openclaw-unraid-schema-first-use.mjs";');
    }
  }
  // Release labels are provenance. Admission is the native ABI/schema class
  // above plus the required historical/fresh/restart gates on this image.
  const packagePath = path.join(dist, "../package.json");
  const packageBytes = await fs.readFile(packagePath);
  const version = JSON.parse(packageBytes).version;
  if (typeof version !== "string" || !version.trim() || !nativeSchema) throw Error("native package identity unavailable");
  const adapterPath = path.join(dist, BASENAME);
  const adapter = `${exports.join("\n")}\n`;
  await fs.writeFile(adapterPath, adapter, { flag: "wx", mode: 0o644 });
  await import(pathToFileURL(adapterPath).href);
  await fs.writeFile(recordPath, `${JSON.stringify({ version: 2, openClawVersion: version, ...nativeSchema, packagePath, packageSha256: digest(packageBytes), adapterPath, adapterSha256: digest(adapter), modules })}\n`, { flag: "wx", mode: 0o644 });
  process.stdout.write("openclaw schema migration adapter ready\n");
}

main().catch(() => {
  process.stderr.write("OpenClaw native schema migration build contract refused; audit the upstream capabilities before publishing this image\n");
  process.exitCode = 1;
});
