#!/usr/bin/env node
// Image-only dependency override and audited pin transfer; never runs on user state.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const VERSION = '0.26.13';
const HANDOFF = 'a25e1fd92e70ffbd2a271cbeb70598da2f88bf9ba367e2e898e095edffcb4ad5';
const PUBLICATION = {
  '0.26.0': '1082f05f8c3de3e9878391ebeb0da3dba9d178d9b4c17efe90ccd2b8a39ee17f',
  '0.26.13': '54d7e05b04d881ed5837c387391046a7c926f96c9ef18a434fc766fee4bf7452',
};
// npm release archives, not mutable registry tags or unconstrained npm installs.
const ARCHIVES = {
  'fs-safe': 'wmHGL0pKcYN8oO+RlvisaZibXDUOQVj6mNQ2VVIoicsqTMvpgzZGX2U4zu8yZtb32MmvPLg1Y9bRQCcePMoEyw==',
  'fs-safe-linux-x64-gnu': 'nzZMTHFPaHXHQH9HXX5YoN/OEivPpmBlcWrSErK8O3iB0E05uiOG8IYIHgsZZUzLwsVdYbvrIYc6uVwxRR/Qfw==',
  'fs-safe-linux-arm64-gnu': '2rWPoeG5f+H7/CbVv+Q2SEW4xOGZfwtLzZ4kZA2xveOb4EhiU7jSZjfCwaf7/jVGIcwiC5SEvL1cHdTyORwULg==',
};
const CALLERS = new Set([
  '68ce2c259e0baa50ad84d8eadd55efda756641e0efe0da1925445f7049b3e145', // 2026.10.8
  '1088645426f8d87cbd111babdec4cfd76a849942196d943c376ea0b801193160', // 2026.10.9
]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function demand(condition, message) {
  if (!condition) throw new Error(`media FUSE contract: ${message}; image build refused (audit required)`);
}
function replaceOnce(source, before, after) {
  demand(source.split(before).length === 2, 'ambiguous or missing adaptation site');
  return source.replace(before, after);
}
async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

function packageIdentity(metadata, name) {
  return metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata) &&
    metadata.name === name && typeof metadata.version === 'string' && metadata.version.length <= 128 &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.test(metadata.version);
}
async function regularImageFile(file) {
  demand((await fs.lstat(file)).isFile() && await fs.realpath(file) === file, `unsupported image file layout: ${file}`);
  return fs.readFile(file);
}
async function imageTreeSha256(directory) {
  const entries = [];
  async function visit(current) {
    demand(await fs.realpath(current) === current, 'unsupported dependency directory layout');
    const stat = await fs.lstat(current);
    entries.push([path.relative(directory, current), stat.mode]);
    for (const name of (await fs.readdir(current)).sort()) {
      const file = path.join(current, name);
      const info = await fs.lstat(file);
      if (info.isDirectory()) await visit(file);
      else entries.push([path.relative(directory, file), info.mode, hash(await regularImageFile(file))]);
    }
  }
  await visit(directory);
  return hash(JSON.stringify(entries));
}

async function recordUnmodified(app, previous, metadata, callerPath, caller, handoff, publication, recordArgument) {
  // Classification is not acceptance: the exact image must still pass every
  // unchanged media FUSE suite and all other publication gates.
  const manifestPath = path.join(previous, 'package.json');
  const manifest = await regularImageFile(manifestPath);
  demand(JSON.stringify(JSON.parse(manifest.toString('utf8'))) === JSON.stringify(metadata), 'fs-safe package metadata changed during classification');
  const appManifest = await regularImageFile(path.join(app, 'package.json'));
  const upstream = JSON.parse(appManifest.toString('utf8'));
  demand(packageIdentity(upstream, 'openclaw'), 'malformed upstream package metadata');
  demand((await regularImageFile(callerPath)).equals(Buffer.from(caller)), 'guarded media caller changed during classification');
  const syntaxEnvironment = { ...process.env, NODE_OPTIONS: '' };
  delete syntaxEnvironment.NODE_V8_COVERAGE;
  execFileSync(process.execPath, ['--check', callerPath], { stdio: 'pipe', env: syntaxEnvironment });
  const oldRequire = createRequire(manifestPath);
  const nativeName = `@openclaw/fs-safe-linux-${process.arch}-gnu`;
  const nativeEntry = oldRequire.resolve(nativeName);
  demand(nativeEntry.startsWith(`${app}/node_modules/`), 'native binding is not image-owned');
  const nativeBytes = await regularImageFile(nativeEntry);
  let nativeRoot = path.dirname(nativeEntry);
  let nativeMetadata;
  let nativeManifest;
  while (nativeRoot.startsWith(`${app}/node_modules/`)) {
    try {
      nativeManifest = await regularImageFile(path.join(nativeRoot, 'package.json'));
      nativeMetadata = JSON.parse(nativeManifest.toString('utf8'));
      break;
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    nativeRoot = path.dirname(nativeRoot);
  }
  demand(packageIdentity(nativeMetadata, nativeName), 'malformed or missing native package metadata');
  const packageSha256 = await imageTreeSha256(previous);
  const nativePackageSha256 = await imageTreeSha256(nativeRoot);
  const handoffPath = path.join(previous, 'dist/private-producer-handoff.js');
  const publicationPath = path.join(previous, 'dist/publish-file.js');
  demand((await regularImageFile(handoffPath)).equals(handoff) &&
    (await regularImageFile(publicationPath)).equals(publication), 'dependency changed during classification');
  const nativeModulePath = path.join(previous, 'dist/native.js');
  await regularImageFile(nativeModulePath);
  // Never import unknown upstream code or load its native binding in the build.
  // Syntax checks do not execute initializers, including transitive imports;
  // the unchanged six-suite gate owns actual private/native ABI acceptance.
  for (const file of [handoffPath, publicationPath, nativeModulePath]) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', env: syntaxEnvironment });
  }
  demand(await imageTreeSha256(previous) === packageSha256 &&
    await imageTreeSha256(nativeRoot) === nativePackageSha256 &&
    (await regularImageFile(nativeEntry)).equals(nativeBytes) &&
    (await regularImageFile(path.join(nativeRoot, 'package.json'))).equals(nativeManifest) &&
    (await regularImageFile(callerPath)).equals(Buffer.from(caller)) &&
    (await regularImageFile(path.join(app, 'package.json'))).equals(appManifest) &&
    (await regularImageFile(manifestPath)).equals(manifest), 'source changed during static media classification');
  const record = {
    contract: 'openclaw-unraid-media-fuse/1', mode: 'upstream-unmodified', upstreamVersion: upstream.version,
    classification: 'static-only', acceptance: 'pending-publication-gates',
    previousVersion: metadata.version, installedVersion: metadata.version, packageRoot: previous, packageSha256, archives: [],
    native: {
      name: nativeName, version: nativeMetadata.version, path: nativeEntry, sha256: hash(nativeBytes), packageSha256: nativePackageSha256,
      requiredCapabilities: ['renameNoReplace', 'linkBeneath', 'removeStagedFile'], abiVerified: false,
    },
    handoff: { sourceSha256: hash(handoff), patchedSha256: hash(handoff) },
    publication: { sourceSha256: hash(publication) },
    caller: { path: callerPath, sourceSha256: hash(caller), patchedSha256: hash(caller) },
    builderSha256: hash(await fs.readFile(new URL(import.meta.url))),
  };
  await fs.writeFile(recordArgument, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o644 });
  console.log(JSON.stringify(record));
}

async function unpack(name, scratch, destination) {
  const url = `https://registry.npmjs.org/@openclaw/${name}/-/${name}-${VERSION}.tgz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  demand(response.ok, `cannot fetch pinned ${name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const integrity = createHash('sha512').update(bytes).digest('base64');
  demand(integrity === ARCHIVES[name], `archive integrity mismatch for ${name}`);
  const archive = path.join(scratch, `${name}.tgz`);
  await fs.writeFile(archive, bytes, { flag: 'wx' });
  await fs.mkdir(destination, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', destination], { stdio: 'pipe' });
  const metadata = await readJson(path.join(destination, 'package.json'));
  demand(metadata.name === `@openclaw/${name}` && metadata.version === VERSION, 'unpacked package identity mismatch');
  return { name: metadata.name, version: VERSION, url, integrity: `sha512-${integrity}`, archiveSha256: hash(bytes) };
}

function adaptHandoff(original) {
  let source = 'import path from "node:path";\nimport { getNativeBinding, requireNativeBinding } from "./native.js";\nimport { isFsSafeNativeRequired } from "./native-config.js";\nfunction unraidHandoffBinding(capability) {\n    const native = getNativeBinding(capability);\n    if (!native && isFsSafeNativeRequired()) return requireNativeBinding(capability);\n    return native;\n}\n' + original;
  // Guarded media previously used native root.move. Keep that parent-fd
  // mutation boundary for created files; do not replace it with a pathname link.
  source = replaceOnce(source, '            fsSync.linkSync(this.paths.sourcePath, this.paths.targetPath);', `            const native = process.platform === "linux" && "source" in this.paths ? unraidHandoffBinding("linkBeneath") : undefined;
            if (native) {
                const openParent = (file) => {
                    const parent = path.dirname(file);
                    const fd = fsSync.openSync(parent, fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY | fsSync.constants.O_NOFOLLOW);
                    try {
                        assertParents(this.paths);
                        const opened = fsSync.fstatSync(fd, { bigint: true });
                        const named = fsSync.lstatSync(parent, { bigint: true });
                        if (named.isSymbolicLink() || !named.isDirectory() || !sameFileIdentityForCleanup(opened, named))
                            throw pathMismatch("created file parent changed before link");
                        return fd;
                    } catch (error) { fsSync.closeSync(fd); throw error; }
                };
                const sourceParent = openParent(this.paths.sourcePath);
                try {
                    const targetParent = openParent(this.paths.targetPath);
                    try {
                        assertParents(this.paths);
                        native.linkBeneath(sourceParent, path.basename(this.paths.sourcePath), targetParent, path.basename(this.paths.targetPath));
                        assertParents(this.paths);
                    } finally { fsSync.closeSync(targetParent); }
                } finally { fsSync.closeSync(sourceParent); }
            } else {
                fsSync.linkSync(this.paths.sourcePath, this.paths.targetPath);
            }`);
  // Windows already transfers the pin. Linux needs the same dentry lifecycle,
  // but keeps O_NOFOLLOW and the historical read/write access contract.
  source = replaceOnce(source, 'if (process.platform === "win32") {\n            // Legacy Windows unlink',
    'if (process.platform === "win32" || process.platform === "linux") {\n            // Legacy Windows unlink');
  source = replaceOnce(source, 'handle.fd, process.platform === "win32" ? params.targetPath : params.sourcePath, 2',
    'handle.fd, (process.platform === "win32" || process.platform === "linux") ? params.targetPath : params.sourcePath, 2');
  source = replaceOnce(source, '    retireSource() {\n        this.cleanup = "failed";\n        fsSync.unlinkSync(this.paths.sourcePath);\n        this.cleanup = "removed";\n    }', `    retireSource(owner) {
        this.cleanup = "failed";
        const native = process.platform === "linux" ? unraidHandoffBinding("removeStagedFile") : undefined;
        if (native) {
            const parent = path.dirname(this.paths.sourcePath);
            const fd = fsSync.openSync(parent, fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY | fsSync.constants.O_NOFOLLOW);
            try {
                assertParents(this.paths);
                const opened = fsSync.fstatSync(fd, { bigint: true });
                const named = fsSync.lstatSync(parent, { bigint: true });
                if (named.isSymbolicLink() || !named.isDirectory() || !sameFileIdentityForCleanup(opened, named))
                    throw pathMismatch("isolated producer source parent changed before unlink");
                this.inspect(owner, 2n);
                const result = native.removeStagedFile(fd, path.basename(this.paths.sourcePath), owner.fd);
                if (result !== "removed") throw pathMismatch("isolated producer source removal unverified");
                assertParents(this.paths);
                if (fsSync.lstatSync(this.paths.sourcePath, { bigint: true, throwIfNoEntry: false }))
                    throw pathMismatch("isolated producer source name remains after unlink");
            } finally { fsSync.closeSync(fd); }
        } else {
            assertParents(this.paths);
            this.inspect(owner, 2n);
            fsSync.unlinkSync(this.paths.sourcePath);
            assertParents(this.paths);
            if (fsSync.lstatSync(this.paths.sourcePath, { bigint: true, throwIfNoEntry: false }))
                throw pathMismatch("isolated producer source name remains after unlink");
        }
        this.cleanup = "removed";
    }`);
  source = replaceOnce(source, '        state.retireSource();', '        state.retireSource(handle);');
  // Once a completed producer has a second name, an error must not delete it:
  // writeIsolatedProducer will independently retire the original workspace.
  // Keep the exception and release cleanup authority, not the recovered bytes.
  source = replaceOnce(source, '    catch (error) {\n        failures.push(error);\n    }\n    if (failures.length === 0)', `    catch (error) {
        failures.push(error);
        if (!created && state.publication === "published") state.siblingOwned = false;
    }
    if (failures.length === 0)`);
  // After a removal attempt the target may be the only data name. A refusal
  // preserves it, including at exit; it must never be rolled back by pathname.
  source = replaceOnce(source, '    params.assertTargetParent();\n    let current;', `    if (params.state.cleanup !== "preserved") {
        params.state.siblingOwned = false;
        return;
    }
    assertParents(params.state.paths);
    inspectLinkedFile(() => fsSync.lstatSync(params.state.paths.sourcePath, { bigint: true }),
        params.identity, 2n, "isolated producer recovery source");
    params.assertTargetParent();
    let current;`);
  return source;
}

function adaptReadScope(original, installedRoot) {
  let source = `import { handoffCreatedFile as unraidHandoffCreatedFile } from ${JSON.stringify(pathToFileURL(path.join(installedRoot, 'dist/private-producer-handoff.js')).href)};\n` + original;
  source = replaceOnce(source, '\t\tconst retained = handle;', '\t\tlet retained = handle;');
  const start = '\t\tawait mediaRoot.move(temporaryName, finalId, {';
  const end = '\n\t\tresource.assertCurrent();';
  demand(source.split(start).length === 2, 'guarded media move site changed');
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin);
  demand(finish > begin && source.slice(begin, finish).includes('overwrite: false'), 'guarded media no-replace site changed');
  source = source.slice(0, begin) + `\t\t// The handoff consumes/closes the old pin even on refusal. Keep any
\t\t// failed publication recoverable; do not let resource cleanup use a stale fd.
\t\tconst finalPath = await mediaRoot.resolve(finalId);
\t\tif (path.dirname(finalPath) !== mediaRoot.rootReal)
\t\t\tthrow new FsSafeError("invalid-path", "Media output must be a direct child of its pinned directory");
\t\thandle = undefined;
\t\tretained = await unraidHandoffCreatedFile({
\t\t\tsource: retained, identity: expected,
\t\t\tsourcePath: temporaryPath, targetPath: finalPath,
\t\t\tassertSourceParent: () => { assertRequestedDirectory(); assertMediaDirectory(); },
\t\t\tassertTargetParent: () => { assertRequestedDirectory(); assertMediaDirectory(); },
\t\t\tassertBeforeMutation: () => { assertCurrent(); assertRequestedDirectory(); assertMediaDirectory(); }
\t\t});
\t\thandle = retained;` + source.slice(finish);
  return source;
}

async function main() {
  const [appArgument = '/app', recordArgument = '/usr/local/lib/openclaw-unraid-media-fuse.json'] = process.argv.slice(2);
  demand(process.argv.length <= 4 && process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch) &&
    Boolean(process.report.getReport().header.glibcVersionRuntime), 'unsupported platform/arguments');
  const app = path.resolve(appArgument);
  const appRequire = createRequire(path.join(app, 'package.json'));
  const previous = await fs.realpath(path.dirname(path.dirname(appRequire.resolve('@openclaw/fs-safe'))));
  demand(previous.startsWith(`${app}/node_modules/`), 'dependency is not image-owned');
  const metadata = await readJson(path.join(previous, 'package.json'));
  demand(packageIdentity(metadata, '@openclaw/fs-safe'), 'malformed fs-safe package metadata');
  const knownDependency = Object.hasOwn(PUBLICATION, metadata.version);
  const handoff = await fs.readFile(path.join(previous, 'dist/private-producer-handoff.js'));
  const publication = await fs.readFile(path.join(previous, 'dist/publish-file.js'));
  // Corruption of an audited version is never an unknown-upstream exemption,
  // even when its guarded caller has also changed.
  if (knownDependency) demand(hash(handoff) === HANDOFF && hash(publication) === PUBLICATION[metadata.version], 'unaudited installed dependency bytes');
  const dist = path.join(app, 'dist');
  const callers = (await fs.readdir(dist)).filter(name => /^store\.read-scope-[\w-]+\.mjs$/.test(name));
  demand(callers.length === 1, 'unknown guarded media module layout');
  const callerPath = path.join(dist, callers[0]);
  const caller = await fs.readFile(callerPath, 'utf8');
  if (!knownDependency || !CALLERS.has(hash(caller))) {
    await recordUnmodified(app, previous, metadata, callerPath, caller, handoff, publication, recordArgument);
    return;
  }
  const oldRequire = createRequire(path.join(previous, 'package.json'));
  const zipRoot = path.dirname(oldRequire.resolve('jszip/package.json'));
  const install = '/usr/local/lib/openclaw-unraid-fs-safe/node_modules';
  const packageRoot = path.join(install, '@openclaw/fs-safe');
  const nativeName = `fs-safe-linux-${process.arch}-gnu`;
  const nativeRoot = path.join(install, `@openclaw/${nativeName}`);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-media-build-'));
  try {
    const archives = [await unpack('fs-safe', scratch, packageRoot), await unpack(nativeName, scratch, nativeRoot)];
    await fs.symlink(zipRoot, path.join(install, 'jszip'), 'dir');
    const handoffPath = path.join(packageRoot, 'dist/private-producer-handoff.js');
    const handoff = await fs.readFile(handoffPath, 'utf8');
    demand(hash(handoff) === HANDOFF && hash(await fs.readFile(path.join(packageRoot, 'dist/publish-file.js'))) === PUBLICATION[VERSION], 'release entrypoints changed');
    const patchedHandoff = adaptHandoff(handoff);
    const patchedCaller = adaptReadScope(caller, packageRoot);
    await fs.writeFile(handoffPath, patchedHandoff);
    // This source tree is the image dependency, not the upstream repository.
    // Redirect its canonical location too, covering pnpm's pre-existing aliases.
    await fs.rm(previous, { recursive: true });
    await fs.symlink(packageRoot, previous, 'dir');
    await fs.writeFile(callerPath, patchedCaller);
    const { requireNativeBinding } = await import(pathToFileURL(path.join(packageRoot, 'dist/native.js')).href);
    const binding = requireNativeBinding('renameNoReplace', 'linkBeneath', 'removeStagedFile');
    const nativeEntry = createRequire(path.join(packageRoot, 'package.json')).resolve(`@openclaw/${nativeName}`);
    demand(typeof binding.linkBeneath === 'function' && await fs.realpath(appRequire.resolve('@openclaw/fs-safe')) === path.join(packageRoot, 'dist/index.js'), 'installed dependency/ABI mismatch');
    const record = {
      contract: 'openclaw-unraid-media-fuse/1', upstreamVersion: (await readJson(path.join(app, 'package.json'))).version,
      previousVersion: metadata.version, installedVersion: VERSION, packageRoot, archives,
      native: {
        name: `@openclaw/${nativeName}`, version: (await readJson(path.join(nativeRoot, 'package.json'))).version,
        path: nativeEntry, sha256: hash(await fs.readFile(nativeEntry)), capabilities: ['renameNoReplace', 'linkBeneath', 'removeStagedFile']
      },
      handoff: { sourceSha256: hash(handoff), patchedSha256: hash(patchedHandoff) },
      caller: { path: callerPath, sourceSha256: hash(caller), patchedSha256: hash(patchedCaller) },
      builderSha256: hash(await fs.readFile(new URL(import.meta.url))),
    };
    demand(record.native.version === VERSION, 'native package version mismatch');
    await fs.writeFile(recordArgument, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o644 });
    console.log(JSON.stringify(record));
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
