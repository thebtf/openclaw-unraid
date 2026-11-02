#!/usr/bin/env node
/** Bind only audited compiled code to the image-owned authoritative-v adapter. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { SHADOW_CONTRACT } from "./openclaw-memory-knn-shadow.mjs";

const CONTRACTS = {
  "2026.10.8": {
    knn: "7bc83909b7ac0f1c66bf887fd2a61081f9634add74f99ca4ef9195be271d4e72",
    child: "1f98e323a22d61f66d0c65ec7a42f1bf95a6bbab48af5309ad53cc8e2f82191d",
    parent: "5dedfdb78873bbd3f172c9e2f1de307254cae299ade5b54db3d6f5ecf0cb07f0",
  },
  "2026.10.9": {
    knn: "8de7bbb2416e421fcf357339b5675f0140023d6f19543cae2c9448717ddfcae9",
    child: "b0f78f957f88a4c739696d870e795c58c30e58cc285d24f94aa2b75d06ebfa11",
    parent: "adff52eb7d9038cbc07d5de0dc9e93437535c267706cee51ab335b6783a1c4ed",
  },
};
const HELPER_URL = "file:///usr/local/lib/openclaw-memory-knn-shadow.mjs";
const PROJECTION = "vec_distance_cosine(v.embedding, ?) AS dist";
const QUERY_ENTRY = "function runVectorKnnQuery(db, request) {\n\tvalidateVectorKnnRequest(request);";
const CHILD_CALL = "if ((await loadSqliteVecExtension({\n\t\t\t\tdb,\n\t\t\t\textensionPath: input.extensionPath\n\t\t\t})).ok) return runVectorKnnQuery(db, input.request);";
const PARENT_RETURN = "\treturn {\n\t\trows: value.rows,\n\t\tfallbackScanRequired: value.fallbackScanRequired\n\t};";
const UNMODIFIED_REASONS = ["unsupported-version", "unsupported-module-layout", "unsupported-module-bytes", "unsupported-native-binary", "unsupported-callsite"];
const UNMODIFIED_WARNING = "WARNING: memory cosine repair not applied; using unchanged upstream search. Slow search/timeouts may return until upstream is fixed or this image contract is audited.";

class BuildContractError extends Error { }

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function findModule(directory, pattern, kind) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const matches = entries.filter((entry) => pattern.test(entry.name));
  if (matches.length !== 1 || !matches[0].isFile()) return null;
  const modulePath = path.join(directory, matches[0].name);
  const bytes = await fs.readFile(modulePath);
  return { kind, path: modulePath, bytes, sourceSha256: sha256(bytes) };
}

function assertProvenance(record) {
  const patched = record?.mode === "patched";
  if (!record || typeof record !== "object" || Array.isArray(record) || record.version !== 2 ||
    typeof record.upstreamVersion !== "string" || !record.upstreamVersion.trim() ||
    !/^[a-f0-9]{64}$/.test(record.helperSha256 ?? "") || record.repairApplied !== patched ||
    record.repair !== (patched ? SHADOW_CONTRACT.repair : null) ||
    (patched ? record.reason !== "audited-contract" : record.mode !== "upstream-unmodified" || !UNMODIFIED_REASONS.includes(record.reason)) ||
    !Array.isArray(record.modules) || ![0, 3].includes(record.modules.length) ||
    record.modules.some((module, index) => module?.kind !== ["knn", "child", "parent"][index] ||
      typeof module.path !== "string" || !path.isAbsolute(module.path) || !/^[a-f0-9]{64}$/.test(module.sourceSha256 ?? "") ||
      (Object.hasOwn(module, "patchedSha256") && !/^[a-f0-9]{64}$/.test(module.patchedSha256))) ||
    (patched && (!Object.hasOwn(CONTRACTS, record.upstreamVersion) || record.modules.length !== 3 ||
      record.modules.some((module) => module.sourceSha256 !== CONTRACTS[record.upstreamVersion][module.kind] || !module.patchedSha256) ||
      record.nativeExtensionSha256 !== SHADOW_CONTRACT.extensionSha256 || record.schemaSha256 !== SHADOW_CONTRACT.schemaSha256)) ||
    (!patched && record.modules.some((module) => Object.hasOwn(module, "patchedSha256")))) {
    throw new BuildContractError("invalid memory cosine projection provenance");
  }
}

async function main() {
  const [distArgument, recordArgument] = process.argv.slice(2);
  if (!distArgument || !recordArgument || process.argv.length !== 4) {
    throw new BuildContractError("usage: build-openclaw-memory-knn-projection.mjs DIST_DIR RECORD_PATH | --runtime-status RECORD_PATH");
  }
  const recordPath = path.resolve(recordArgument);
  const helperSha256 = sha256(await fs.readFile(fileURLToPath(new URL("./openclaw-memory-knn-shadow.mjs", import.meta.url))));
  if (distArgument === "--runtime-status") {
    const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
    assertProvenance(record);
    if (record.helperSha256 !== helperSha256) throw new BuildContractError("invalid memory cosine projection helper provenance");
    if (record.mode === "upstream-unmodified") process.stderr.write(`[bootstrap] ${UNMODIFIED_WARNING}\n`);
    else process.stdout.write("[bootstrap] memory cosine projection: audited shadow adapter available; runtime ABI and memory guards apply\n");
    return;
  }
  const distDir = path.resolve(distArgument);
  const packagePath = path.join(distDir, "..", "package.json");
  const { version } = JSON.parse(await fs.readFile(packagePath, "utf8"));
  if (typeof version !== "string" || !version.trim()) throw new BuildContractError("invalid upstream image version metadata");
  const provenance = { version: 2, mode: "upstream-unmodified", repairApplied: false, repair: null, reason: "unsupported-version", upstreamVersion: version, helperSha256, modules: [] };
  let modules;
  let patchedKnn;
  let patchedChild;
  let patchedParent;
  if (Object.hasOwn(CONTRACTS, version)) {
    modules = [
      await findModule(distDir, /^manager-search-knn-(?!entrypoint-)[A-Za-z0-9_-]+\.(?:mjs|js)$/, "knn"),
      await findModule(path.join(distDir, "extensions", "memory-core"), /^memory-search-knn\.child\.js$/, "child"),
      await findModule(path.join(distDir, "extensions", "memory-core"), /^manager-runtime\.js$/, "parent"),
    ];
    provenance.reason = "unsupported-module-layout";
    if (modules.every(Boolean)) {
      provenance.modules = modules.map(({ kind, path, sourceSha256 }) => ({ kind, path, sourceSha256 }));
      provenance.reason = "unsupported-module-bytes";
      if (modules.every((module) => module.sourceSha256 === CONTRACTS[version][module.kind])) {
        const knn = modules[0].bytes.toString("utf8");
        const child = modules[1].bytes.toString("utf8");
        const parent = modules[2].bytes.toString("utf8");
        provenance.reason = "unsupported-callsite";
        if (knn.split(PROJECTION).length === 2 && knn.split(QUERY_ENTRY).length === 2 && child.split(CHILD_CALL).length === 2 && parent.split(PARENT_RETURN).length === 2) {
          provenance.reason = "unsupported-native-binary";
          let extensionPath;
          if (process.platform === "linux" && process.arch === "x64") {
            let loader;
            try { loader = createRequire(packagePath)("sqlite-vec"); } catch (error) {
              if (error.code !== "MODULE_NOT_FOUND") throw error;
            }
            if (typeof loader?.getLoadablePath === "function") extensionPath = loader.getLoadablePath();
          }
          if (extensionPath && sha256(await fs.readFile(extensionPath)) === SHADOW_CONTRACT.extensionSha256) {
            patchedKnn = `import { installShadowProjection } from "${HELPER_URL}";\n` + knn
              .replace(PROJECTION, "vec_distance_cosine(COALESCE(openclaw_unraid_shadow_v(v.id), v.embedding), ?) AS dist")
              .replace(QUERY_ENTRY, `${QUERY_ENTRY}\n\tinstallShadowProjection(db);`);
            patchedChild = `import { withShadowProjection } from "${HELPER_URL}";\n` + child.replace(CHILD_CALL,
              "const extension = await loadSqliteVecExtension({ db, extensionPath: input.extensionPath });\n\t\t\tif (extension.ok) return withShadowProjection(db, input.request, extension.extensionPath, runVectorKnnQuery);");
            patchedParent = "let unraidShadowFallbackReported = false;\n" + parent.replace(PARENT_RETURN,
              '\tif (value.unraidShadowFallback === "native-v" && !unraidShadowFallbackReported) {\n\t\tunraidShadowFallbackReported = true;\n\t\tlog.warn("Memory shadow projection unavailable; using original upstream vectors. Slow search/timeouts may return; check image ABI and available memory.");\n\t}\n' + PARENT_RETURN);
            Object.assign(provenance, { mode: "patched", repairApplied: true, repair: SHADOW_CONTRACT.repair, reason: "audited-contract", nativeExtensionSha256: SHADOW_CONTRACT.extensionSha256, schemaSha256: SHADOW_CONTRACT.schemaSha256 });
            provenance.modules[0].patchedSha256 = sha256(patchedKnn);
            provenance.modules[1].patchedSha256 = sha256(patchedChild);
            provenance.modules[2].patchedSha256 = sha256(patchedParent);
          }
        }
      }
    }
  }
  assertProvenance(provenance);
  // Only contract mismatches select unchanged upstream. IO/record failures abort.
  const record = await fs.open(recordPath, "wx", 0o644);
  try {
    if (patchedKnn !== undefined) {
      await fs.writeFile(modules[0].path, patchedKnn, "utf8");
      await fs.writeFile(modules[1].path, patchedChild, "utf8");
      await fs.writeFile(modules[2].path, patchedParent, "utf8");
    }
    await record.writeFile(`${JSON.stringify(provenance)}\n`, "utf8");
    await record.sync();
  } finally {
    await record.close();
  }
  if (provenance.mode === "upstream-unmodified") process.stderr.write(`${UNMODIFIED_WARNING}\n`);
  else process.stdout.write(`openclaw authoritative memory shadow projection ready (${version})\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof BuildContractError ? error.message : "memory cosine projection operation failed"}\n`);
  process.exitCode = 1;
});
