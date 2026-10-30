#!/usr/bin/env node
// Run inside the derived image with this file bind-mounted read-only. No npm install.
// Default: simulate only node:fs deferred unlink; the installed handoff stays real.
// Optional: --real-fuse-root PATH runs on a pre-mounted real FUSE filesystem,
// without the deferred-unlink simulation. Mount with attribute caching disabled.
// Neither mode proves Telegram/store caller integration or the full race space.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireImage = createRequire('/app/package.json');
const entry = requireImage.resolve('@openclaw/fs-safe');
const packageRoot = path.dirname(path.dirname(entry));
const handoffPath = path.join(packageRoot, 'dist/private-producer-handoff.js');
const { handoffPrivateProducerFile } = await import(pathToFileURL(handoffPath).href);
const { FsSafeError } = await import(pathToFileURL(path.join(packageRoot, 'dist/errors.js')).href);
const { publishFileExclusive } = await import(pathToFileURL(path.join(packageRoot, 'dist/publish-file.js')).href);
const { requireNativeBinding, __setNativeLoaderForTest, __resetNativeLoaderForTest } = await import(pathToFileURL(path.join(packageRoot, 'dist/native.js')).href);
const packageInfo = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const payload = Buffer.alloc(65539);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) % 256;
const foreign = Buffer.from('foreign-object-must-survive\n');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const original = {
  open: fsp.open, link: fs.linkSync, unlink: fs.unlinkSync, fstat: fs.fstatSync,
};
const nativeBinding = requireNativeBinding('removeStagedFile');
const originalRemoveStagedFile = nativeBinding.removeStagedFile;
const realFuseRoot = process.argv[2] === '--real-fuse-root' ? process.argv[3] : undefined;
assert(process.argv.length === 2 || (process.argv.length === 4 && realFuseRoot), 'usage: fixture [--real-fuse-root PATH]');
if (realFuseRoot) assert.equal(fs.statfsSync(realFuseRoot).type, 0x65735546, 'expected real FUSE filesystem');
const suiteRoot = fs.mkdtempSync(path.join(realFuseRoot ?? os.tmpdir(), 'media-fuse-regression-'));
const results = [];

function identity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), nlink: String(stat.nlink) };
}
function sameObject(actual, expected) {
  assert.equal(actual.dev, expected.dev, 'device changed');
  assert.equal(actual.ino, expected.ino, 'inode changed');
}
function bytesAt(file, expected) {
  assert.deepEqual(fs.readFileSync(file), expected, `bytes changed: ${path.basename(file)}`);
}
function absent(file) {
  assert.equal(fs.existsSync(file), false, `unexpected surviving path: ${file}`);
}
function pinParent(directory) {
  const pinned = fs.lstatSync(directory, { bigint: true });
  assert(pinned.isDirectory() && !pinned.isSymbolicLink());
  return () => {
    const now = fs.lstatSync(directory, { bigint: true });
    if (now.isSymbolicLink() || !now.isDirectory() || now.dev !== pinned.dev || now.ino !== pinned.ino) {
      throw new FsSafeError('path-mismatch', 'fixture parent identity changed');
    }
  };
}
function setup(name) {
  const directory = fs.mkdtempSync(path.join(suiteRoot, `${name}-`));
  const sourceDir = path.join(directory, 'producer');
  const targetDir = path.join(directory, 'media');
  fs.mkdirSync(sourceDir, { mode: 0o700 });
  fs.mkdirSync(targetDir, { mode: 0o700 });
  const sourcePath = path.join(sourceDir, 'completed.bin');
  const targetPath = path.join(targetDir, 'published.bin');
  fs.writeFileSync(sourcePath, payload, { flag: 'wx', mode: 0o600 });
  return {
    directory, sourceDir, targetDir, sourcePath, targetPath, readWrite: false,
    assertSourceParent: pinParent(sourceDir), assertTargetParent: pinParent(targetDir),
    admitted: fs.lstatSync(sourcePath, { bigint: true }),
  };
}
function restoreBoundaries() {
  fsp.open = original.open;
  fs.linkSync = original.link;
  fs.unlinkSync = original.unlink;
  fs.fstatSync = original.fstat;
  nativeBinding.removeStagedFile = originalRemoveStagedFile;
  syncBuiltinESMExports();
}
function deferredUnlinkBoundary(fixture) {
  if (realFuseRoot) return { mode: 'real-fuse-no-simulation' };
  const opened = new Set();
  const retired = new Set();
  const hiddenPath = path.join(fixture.sourceDir, '.fuse_hidden_fixture');
  const observations = { unlinkCalls: 0, sourceDescriptorsAtUnlink: [], deferredUnlinks: 0, sourceCloses: 0, hiddenReleased: 0 };
  // Count the new native unlink ABI without replacing its real operation.
  nativeBinding.removeStagedFile = (...args) => {
    observations.unlinkCalls++;
    observations.sourceDescriptorsAtUnlink.push(opened.size);
    return originalRemoveStagedFile.apply(nativeBinding, args);
  };
  fsp.open = async function(file, ...args) {
    const handle = await original.open.call(fsp, file, ...args);
    if (String(file) !== fixture.sourcePath) return handle;
    const fd = handle.fd;
    opened.add(fd);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      observations.sourceCloses++;
      opened.delete(fd);
      retired.delete(fd);
      if (opened.size === 0 && fs.existsSync(hiddenPath)) {
        original.unlink(hiddenPath);
        observations.hiddenReleased++;
      }
    };
    return handle;
  };
  fs.unlinkSync = function(file) {
    if (String(file) !== fixture.sourcePath) return original.unlink(file);
    observations.unlinkCalls++;
    observations.sourceDescriptorsAtUnlink.push(opened.size);
    if (opened.size === 0) return original.unlink(file);
    // A real rename holds the inode and hidden hardlink; no handoff result is forged.
    fs.renameSync(file, hiddenPath);
    for (const fd of opened) retired.add(fd);
    observations.deferredUnlinks++;
  };
  fs.fstatSync = function(fd, ...args) {
    const stat = original.fstat(fd, ...args);
    if (retired.has(fd)) stat.nlink = typeof stat.nlink === 'bigint' ? 1n : 1;
    return stat;
  };
  syncBuiltinESMExports();
  return observations;
}
async function invoke(fixture) {
  const result = await handoffPrivateProducerFile(fixture);
  try {
    sameObject(result.identity, fixture.admitted);
    sameObject(fs.fstatSync(result.handle.fd, { bigint: true }), fixture.admitted);
    sameObject(fs.lstatSync(fixture.targetPath, { bigint: true }), fixture.admitted);
    bytesAt(fixture.targetPath, payload);
    assert.equal(fs.lstatSync(fixture.targetPath, { bigint: true }).nlink, 1n);
    absent(fixture.sourcePath);
    result.unregister();
  } finally {
    await result.handle.close();
  }
}
function refusalCodes(error) {
  if (error instanceof FsSafeError) return [error.code];
  if (error instanceof AggregateError) return error.errors.flatMap(refusalCodes);
  return [];
}
async function refuses(fixture, codes, operation = invoke) {
  let failure;
  try { await operation(fixture); } catch (error) { failure = error; }
  assert(failure, 'unsafe handoff unexpectedly succeeded');
  const observed = refusalCodes(failure);
  assert(observed.length > 0 && observed.every((code) => codes.includes(code)),
    `unexpected refusal: ${failure.code}: ${failure.message}`);
  return { refusal: observed, message: failure.message };
}
async function nativeFallback(fixture) {
  const native = requireNativeBinding('renameNoReplace', 'linkBeneath', 'removeStagedFile');
  const calls = { link: 0, unlink: 0 };
  // Exercise the actual asynchronous publication owner. It now owns the source
  // handle and can transfer its pin before unlink; the old synchronous helper
  // cannot close a descriptor owned by its caller. Only rename availability is
  // forced. linkBeneath/removeStagedFile below still invoke the installed addon.
  __setNativeLoaderForTest(() => ({
    ...native,
    renameNoReplace() { throw Object.assign(new Error('fixture renameat2 unsupported'), { code: 'ENOTSUP' }); },
    linkBeneath(...args) { calls.link++; return native.linkBeneath(...args); },
    removeStagedFile(...args) { calls.unlink++; return native.removeStagedFile(...args); },
  }));
  try {
    const result = await publishFileExclusive({
      sourcePath: fixture.sourcePath, targetPath: fixture.targetPath,
      expectedSourceIdentity: fixture.admitted, strategy: 'rename-noreplace',
    });
    assert.equal(result.method, 'rename-noreplace');
    assert.equal(result.fallback, 'link-unlink');
    assert.equal(calls.link, 1, 'native linkat must be exercised');
    assert.equal(calls.unlink, 1, 'native identity-bound unlink must be exercised');
    sameObject(fs.lstatSync(fixture.targetPath, { bigint: true }), fixture.admitted);
    bytesAt(fixture.targetPath, payload);
    assert.equal(fs.lstatSync(fixture.targetPath, { bigint: true }).nlink, 1n);
    absent(fixture.sourcePath);
  } finally { __resetNativeLoaderForTest(); }
}
async function run(name, scenario) {
  const fixture = setup(name);
  try {
    const details = await scenario(fixture);
    results.push({ name, status: 'PASS', ...details });
  } catch (error) {
    const files = [];
    for (const directory of [fixture.sourceDir, fixture.targetDir]) {
      for (const name of fs.readdirSync(directory)) {
        const file = path.join(directory, name);
        const stat = fs.lstatSync(file, { bigint: true });
        files.push({
          path: path.relative(fixture.directory, file), ...identity(stat),
          sha256: stat.isFile() ? sha256(fs.readFileSync(file)) : null
        });
      }
    }
    results.push({ name, status: 'FAIL', code: error.code ?? null, message: error.message, files });
  } finally {
    restoreBoundaries();
  }
}

console.log(JSON.stringify({
  kind: 'identity', node: process.version, openclaw: JSON.parse(fs.readFileSync('/app/package.json', 'utf8')).version,
  fsSafe: packageInfo.version, packageRoot, handoffSha256: sha256(fs.readFileSync(handoffPath)),
  fixtureSha256: sha256(fs.readFileSync(new URL(import.meta.url))), realFuse: Boolean(realFuseRoot),
  model: realFuseRoot ? 'real FUSE, no deferred-unlink simulation' : 'real hidden-name retention + descriptor-only nlink observation',
  payloadSha256: sha256(payload)
}));
try {
  await run('deferred-unlink-filesystem-calibration', async (f) => {
    const observed = deferredUnlinkBoundary(f);
    const handle = await fsp.open(f.sourcePath, 'r');
    try {
      fs.linkSync(f.sourcePath, f.targetPath);
      fs.unlinkSync(f.sourcePath);
      absent(f.sourcePath);
      assert.equal(fs.fstatSync(handle.fd, { bigint: true }).nlink, 1n);
      assert.equal(fs.lstatSync(f.targetPath, { bigint: true }).nlink, 2n);
      observed.descriptorLinksBeforeClose = String(fs.fstatSync(handle.fd, { bigint: true }).nlink);
      observed.targetLinksBeforeClose = String(fs.lstatSync(f.targetPath, { bigint: true }).nlink);
      observed.hiddenBeforeClose = fs.readdirSync(f.sourceDir).filter((name) => name.startsWith('.fuse_hidden'));
      assert.equal(observed.hiddenBeforeClose.length, 1, 'hidden source must survive until close');
      bytesAt(f.targetPath, payload);
    } finally { await handle.close(); }
    assert.equal(fs.lstatSync(f.targetPath, { bigint: true }).nlink, 1n);
    if (!realFuseRoot) {
      assert.equal(observed.unlinkCalls, 1, 'calibration must unlink its open source once');
      assert.deepEqual(observed.sourceDescriptorsAtUnlink, [1], 'calibration must retain an open source at unlink');
      assert.equal(observed.deferredUnlinks, 1, 'calibration must defer source unlink');
      assert.equal(observed.sourceCloses, 1, 'calibration must close its source once');
      assert.equal(observed.hiddenReleased, 1, 'calibration must release its hidden source');
    }
    observed.targetLinksAfterClose = String(fs.lstatSync(f.targetPath, { bigint: true }).nlink);
    assert.equal(fs.readdirSync(f.sourceDir).filter((name) => name.startsWith('.fuse_hidden')).length, 0);
    return { observed };
  });
  assert.equal(results.at(-1).status, 'PASS', 'filesystem did not match deferred-unlink incident semantics');
  if (!realFuseRoot) await run('ordinary-publish-preserves-identity-and-bytes', async (f) => {
    await invoke(f);
    return { target: identity(fs.lstatSync(f.targetPath, { bigint: true })) };
  });
  await run('existing-target-is-never-overwritten', async (f) => {
    fs.writeFileSync(f.targetPath, foreign, { flag: 'wx' });
    const target = fs.lstatSync(f.targetPath, { bigint: true });
    const refused = await refuses(f, ['already-exists']);
    sameObject(fs.lstatSync(f.targetPath, { bigint: true }), target);
    bytesAt(f.targetPath, foreign);
    bytesAt(f.sourcePath, payload);
    return refused;
  });
  await run('symlink-source-is-rejected', async (f) => {
    const saved = path.join(f.sourceDir, 'original.bin');
    fs.renameSync(f.sourcePath, saved);
    fs.symlinkSync(saved, f.sourcePath);
    const refused = await refuses(f, ['path-alias']);
    assert(fs.lstatSync(f.sourcePath).isSymbolicLink());
    bytesAt(saved, payload);
    absent(f.targetPath);
    return refused;
  });
  await run('hardlinked-source-is-rejected', async (f) => {
    const alias = path.join(f.sourceDir, 'alias.bin');
    fs.linkSync(f.sourcePath, alias);
    const refused = await refuses(f, ['hardlink']);
    bytesAt(alias, payload);
    bytesAt(f.sourcePath, payload);
    absent(f.targetPath);
    return refused;
  });
  await run('symlink-target-is-never-followed', async (f) => {
    const victim = path.join(f.targetDir, 'victim.bin');
    fs.writeFileSync(victim, foreign, { flag: 'wx' });
    fs.symlinkSync(victim, f.targetPath);
    const refused = await refuses(f, ['already-exists']);
    assert(fs.lstatSync(f.targetPath).isSymbolicLink());
    bytesAt(victim, foreign);
    bytesAt(f.sourcePath, payload);
    return refused;
  });
  await run('source-substitution-at-link-is-refused-without-deleting-foreign-data', async (f) => {
    const saved = path.join(f.sourceDir, 'saved-original.bin');
    fs.linkSync = (source, target) => {
      fs.renameSync(source, saved);
      fs.writeFileSync(source, foreign, { flag: 'wx' });
      return original.link(source, target);
    };
    const refused = await refuses(f, ['path-mismatch']);
    // Cleanup may aggregate its refusal when the sibling no longer has the admitted identity.
    bytesAt(saved, payload);
    bytesAt(f.sourcePath, foreign);
    bytesAt(f.targetPath, foreign);
    return refused;
  });
  await run('target-substitution-after-link-is-refused-without-deleting-foreign-data', async (f) => {
    const saved = path.join(f.targetDir, 'saved-publication.bin');
    fs.linkSync = (source, target) => {
      original.link(source, target);
      fs.renameSync(target, saved);
      fs.writeFileSync(target, foreign, { flag: 'wx' });
    };
    const refused = await refuses(f, ['path-mismatch']);
    bytesAt(saved, payload);
    bytesAt(f.sourcePath, payload);
    bytesAt(f.targetPath, foreign);
    return refused;
  });
  await run('parent-substitution-after-link-is-refused', async (f) => {
    const saved = path.join(f.directory, 'saved-media');
    fs.linkSync = (source, target) => {
      original.link(source, target);
      fs.renameSync(f.targetDir, saved);
      fs.mkdirSync(f.targetDir);
      fs.writeFileSync(f.targetPath, foreign, { flag: 'wx' });
    };
    const refused = await refuses(f, ['path-mismatch']);
    bytesAt(f.sourcePath, payload);
    bytesAt(path.join(saved, 'published.bin'), payload);
    bytesAt(f.targetPath, foreign);
    return refused;
  });
  await run('post-unlink-error-preserves-sole-publication', async (f) => {
    nativeBinding.removeStagedFile = (...args) => {
      originalRemoveStagedFile.apply(nativeBinding, args);
      throw Object.assign(new Error('fixture post-unlink acknowledgement failure'), { code: 'EIO' });
    };
    await assert.rejects(invoke(f));
    absent(f.sourcePath);
    bytesAt(f.targetPath, payload);
    sameObject(fs.lstatSync(f.targetPath, { bigint: true }), f.admitted);
    assert.equal(fs.lstatSync(f.targetPath, { bigint: true }).nlink, 1n);
    return { errorPropagated: true, recovery: 'sole target retained' };
  });
  await run('unlink-refusal-preserves-both-data-names', async (f) => {
    nativeBinding.removeStagedFile = () => { throw Object.assign(new Error('fixture unlink denied'), { code: 'EACCES' }); };
    await assert.rejects(invoke(f));
    bytesAt(f.sourcePath, payload);
    bytesAt(f.targetPath, payload);
    sameObject(fs.lstatSync(f.targetPath, { bigint: true }), f.admitted);
    return { errorPropagated: true, recovery: 'source and target retained' };
  });
  await run('native-linkat-unlinkat-publish-preserves-identity-and-bytes', async (f) => {
    await nativeFallback(f);
    return { deferredUnlinkExercised: Boolean(realFuseRoot) };
  });
  await run('native-linkat-unlinkat-never-overwrites-target', async (f) => {
    fs.writeFileSync(f.targetPath, foreign, { flag: 'wx' });
    const target = fs.lstatSync(f.targetPath, { bigint: true });
    const refused = await refuses(f, ['already-exists'], nativeFallback);
    sameObject(fs.lstatSync(f.targetPath, { bigint: true }), target);
    bytesAt(f.targetPath, foreign);
    bytesAt(f.sourcePath, payload);
    return { ...refused, realFuse: Boolean(realFuseRoot) };
  });
  await run('deferred-unlink-publish-preserves-identity-and-bytes', async (f) => {
    const observed = deferredUnlinkBoundary(f);
    try { await invoke(f); }
    catch (error) { error.message += `; boundary=${JSON.stringify(observed)}`; throw error; }
    if (!realFuseRoot) {
      assert.equal(observed.unlinkCalls, 1, 'source must be retired');
      assert.deepEqual(observed.sourceDescriptorsAtUnlink, [0], 'source must be closed before unlink');
      assert.equal(observed.sourceCloses, 1, 'source descriptor must be closed');
      assert.equal(observed.deferredUnlinks, 0, 'handoff must prevent deferred source unlink');
      assert.equal(observed.hiddenReleased, 0, 'handoff must not create a hidden source to release');
      absent(path.join(f.sourceDir, '.fuse_hidden_fixture'));
    } else {
      assert.deepEqual(fs.readdirSync(f.sourceDir).filter((name) => name.startsWith('.fuse_hidden')), [],
        'real FUSE hidden source must be released after handoff');
    }
    bytesAt(f.targetPath, payload);
    return { observed, target: identity(fs.lstatSync(f.targetPath, { bigint: true })) };
  });
} finally {
  restoreBoundaries();
  fs.rmSync(suiteRoot, { recursive: true });
  for (const result of results) console.log(JSON.stringify(result));
  console.log(JSON.stringify({
    kind: 'summary', passed: results.filter((r) => r.status === 'PASS').length,
    failed: results.filter((r) => r.status === 'FAIL').length, cleanupRoot: suiteRoot,
    cleanupAbsent: !fs.existsSync(suiteRoot), realFuse: Boolean(realFuseRoot),
    unexercised: [
      ...(!realFuseRoot ? ['real FUSE and native linkat/unlinkat deferred unlink'] : []),
      'actual Unraid filesystem', 'writeReadScopeMedia/Telegram/store caller integration',
      'full race space', 'ownership/permission changes', 'crash/durability and cross-device behavior']
  }));
}
process.exitCode = results.some((result) => result.status === 'FAIL') ? 1 : 0;
