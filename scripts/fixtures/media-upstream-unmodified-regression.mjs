#!/usr/bin/env node
// Container-only: node scripts/fixtures/media-upstream-unmodified-regression.mjs
// Copy this fixture and ../build-openclaw-media-fuse-adapter.mjs into an already
// local official upstream image; run with --network none and no host mounts.
// Uses only Node built-ins and private /tmp copies. Never installs dependencies.
// This classification test does NOT replace any of the six real media FUSE suites.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

assert.equal(process.argv.length, 2, 'usage: node media-upstream-unmodified-regression.mjs');
assert.equal(process.platform, 'linux', 'requires the official Linux image, not the host');
assert(['x64', 'arm64'].includes(process.arch), 'requires an image-supported architecture');
assert(process.report.getReport().header.glibcVersionRuntime, 'requires the glibc image');
assert.deepEqual(Object.keys(os.networkInterfaces()), ['lo'], 'run the container with --network none');
const builder = fileURLToPath(new URL('../build-openclaw-media-fuse-adapter.mjs', import.meta.url));
const builderBytes = fs.readFileSync(builder);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sourceRequire = createRequire('/app/package.json');
const sourcePackage = fs.realpathSync(path.dirname(path.dirname(sourceRequire.resolve('@openclaw/fs-safe'))));
assert(sourcePackage.startsWith('/app/node_modules/'), 'source dependency must be image-owned');
const sourceMetadata = readJson(path.join(sourcePackage, 'package.json'));
assert.equal(sourceMetadata.name, '@openclaw/fs-safe');
const publications = {
  '0.26.0': '1082f05f8c3de3e9878391ebeb0da3dba9d178d9b4c17efe90ccd2b8a39ee17f',
  '0.26.13': '54d7e05b04d881ed5837c387391046a7c926f96c9ef18a434fc766fee4bf7452',
};
// Calibrate the untouched local image before generating unknown fingerprints:
// a missing/corrupt fixture source is a prerequisite failure, never meaningful RED.
assert(Object.hasOwn(publications, sourceMetadata.version), 'fixture needs a currently audited source dependency');
assert.equal(sha256(fs.readFileSync(path.join(sourcePackage, 'dist/private-producer-handoff.js'))),
  'a25e1fd92e70ffbd2a271cbeb70598da2f88bf9ba367e2e898e095edffcb4ad5', 'source handoff is not unmodified upstream');
assert.equal(sha256(fs.readFileSync(path.join(sourcePackage, 'dist/publish-file.js'))), publications[sourceMetadata.version],
  'source publication is not unmodified upstream');
const sourceCallers = fs.readdirSync('/app/dist').filter(name => /^store\.read-scope-[\w-]+\.mjs$/.test(name));
assert.equal(sourceCallers.length, 1, 'fixture needs exactly one real guarded media caller');
const callerName = sourceCallers[0];
const sourceCaller = path.join('/app/dist', callerName);
const callerBytes = fs.readFileSync(sourceCaller);
assert([
  '68ce2c259e0baa50ad84d8eadd55efda756641e0efe0da1925445f7049b3e145',
  '1088645426f8d87cbd111babdec4cfd76a849942196d943c376ea0b801193160',
].includes(sha256(callerBytes)), 'fixture needs an untouched currently audited caller');
const nativeName = `@openclaw/fs-safe-linux-${process.arch}-gnu`;
const nativeEntry = createRequire(path.join(sourcePackage, 'package.json')).resolve(nativeName);
// The native entry can be below dist; locate its actual package manifest rather
// than assuming a tarball layout. Only that package is copied, never all of /app.
let sourceNative = path.dirname(nativeEntry);
while (!fs.existsSync(path.join(sourceNative, 'package.json'))) {
  const parent = path.dirname(sourceNative);
  assert.notEqual(parent, sourceNative, 'native package manifest missing');
  sourceNative = parent;
}
assert.equal(readJson(path.join(sourceNative, 'package.json')).name, nativeName);
assert(fs.realpathSync(sourceNative).startsWith('/app/node_modules/'), 'source native package must be image-owned');
const nativeRelativeEntry = path.relative(sourceNative, nativeEntry);

function snapshot(directory) {
  const entries = new Map();
  function visit(file, relative) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) entries.set(relative, { kind: 'link', mode: stat.mode, target: fs.readlinkSync(file) });
    else if (stat.isDirectory()) {
      entries.set(relative, { kind: 'directory', mode: stat.mode });
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.join(relative, name));
    } else {
      assert(stat.isFile(), `unsupported fixture source entry: ${file}`);
      entries.set(relative, { kind: 'file', mode: stat.mode, bytes: fs.readFileSync(file) });
    }
  }
  visit(directory, '.');
  return entries;
}
function unchanged(directory, before) {
  const after = snapshot(directory);
  assert.deepEqual([...after.keys()], [...before.keys()], `source paths changed: ${directory}`);
  for (const [name, expected] of before) {
    const actual = after.get(name);
    assert.equal(actual.kind, expected.kind, `source entry type changed: ${name}`);
    assert.equal(actual.mode, expected.mode, `source entry mode changed: ${name}`);
    if (expected.kind === 'file') assert(actual.bytes.equals(expected.bytes), `source bytes changed: ${name}`);
    if (expected.kind === 'link') assert.equal(actual.target, expected.target, `source link redirected: ${name}`);
  }
}
const originalPackage = snapshot(sourcePackage);
const originalNative = snapshot(sourceNative);
const originalAppMetadata = fs.readFileSync('/app/package.json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-upstream-unmodified-'));
fs.chmodSync(root, 0o700);
const results = [];
const unknownVersion = '0.0.0-media-unmodified-fixture';
function setUnknownVersion(fixture) {
  const manifest = path.join(fixture.packageRoot, 'package.json');
  fs.writeFileSync(manifest, `${JSON.stringify({ ...readJson(manifest), version: unknownVersion })}\n`);
}
function changeCaller(fixture) {
  fs.appendFileSync(fixture.caller, '\n// Synthetic unknown fingerprint; media behavior is unchanged.\n');
}
function corrupt(fixture, file) {
  // Valid JavaScript, but the known dependency's audited bytes no longer match.
  fs.appendFileSync(path.join(fixture.packageRoot, 'dist', file), '\n// Known-version byte corruption must not become an unknown-version exemption.\n');
}
function setup(name) {
  const directory = path.join(root, name);
  const app = path.join(directory, 'app');
  const packageRoot = path.join(app, 'node_modules/@openclaw/fs-safe');
  const nativeRoot = path.join(app, 'node_modules', nativeName);
  fs.mkdirSync(path.join(app, 'dist'), { recursive: true, mode: 0o700 });
  fs.cpSync(sourcePackage, packageRoot, { recursive: true, dereference: true });
  fs.cpSync(sourceNative, nativeRoot, { recursive: true, dereference: true });
  fs.writeFileSync(path.join(app, 'package.json'), originalAppMetadata, { flag: 'wx' });
  const caller = path.join(app, 'dist', callerName);
  fs.writeFileSync(caller, callerBytes, { flag: 'wx' });
  return { directory, app, packageRoot, nativeRoot, caller, record: path.join(directory, 'media-fuse.json') };
}
function unmodifiedRecord(fixture) {
  const record = readJson(fixture.record);
  const metadata = readJson(path.join(fixture.packageRoot, 'package.json'));
  const handoffHash = sha256(fs.readFileSync(path.join(fixture.packageRoot, 'dist/private-producer-handoff.js')));
  const callerHash = sha256(fs.readFileSync(fixture.caller));
  assert.equal(record.mode, 'upstream-unmodified', 'record must explicitly distinguish unmodified upstream from an adapter');
  assert.equal(record.classification, 'static-only', 'classification must not claim behavioral verification');
  assert.equal(record.acceptance, 'pending-publication-gates', 'classification must not claim publication acceptance');
  assert.equal(record.upstreamVersion, readJson(path.join(fixture.app, 'package.json')).version);
  assert.equal(record.previousVersion, metadata.version);
  assert.equal(record.installedVersion, metadata.version, 'record must not claim an installed override');
  assert.equal(record.packageRoot, fixture.packageRoot, 'record must identify the unchanged image dependency');
  assert.equal(record.caller?.path, fixture.caller, 'the six-suite consumer must receive the original caller path');
  assert.equal(record.caller.sourceSha256, callerHash, 'record must identify exact original caller bytes');
  assert.equal(record.handoff?.sourceSha256, handoffHash, 'record must identify exact original dependency handoff bytes');
  if (record.caller.patchedSha256 !== undefined) assert.equal(record.caller.patchedSha256, callerHash);
  if (record.handoff.patchedSha256 !== undefined) assert.equal(record.handoff.patchedSha256, handoffHash);
  assert.equal(record.native?.path, path.join(fixture.nativeRoot, nativeRelativeEntry));
  assert.equal(record.native.abiVerified, false, 'classification must leave native ABI verification to the unchanged media gate');
  assert.equal(record.native.sha256, sha256(fs.readFileSync(record.native.path)), 'record must identify the actual untouched native binding');
  assert.equal(record.builderSha256, sha256(builderBytes), 'record must identify the exact exercised builder');
  if (record.archives !== undefined) assert.deepEqual(record.archives, [], 'unmodified classification must not install archives');
}
function run(name, mutate, accept, errorPattern) {
  try {
    const fixture = setup(name);
    mutate(fixture);
    const before = snapshot(fixture.app);
    const result = spawnSync(process.execPath, [builder, fixture.app, fixture.record], {
      cwd: fixture.directory, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: '', HOME: fixture.directory, TMPDIR: fixture.directory, FS_SAFE_NATIVE_MODE: 'require' },
    });
    // Check the complete source tree even when classification fails, before the
    // exit-status assertion can obscure a partial mutation or dependency redirect.
    unchanged(fixture.app, before);
    assert.ifError(result.error);
    assert.equal(result.signal, null, `builder did not exit normally: ${result.signal}`);
    const diagnostic = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (accept) {
      assert.equal(result.status, 0, `${name}: structurally intact unknown upstream must reach the unchanged six-suite gate, not the strict fingerprint refusal:\n${diagnostic}`);
      unmodifiedRecord(fixture);
    } else {
      assert.notEqual(result.status, 0, `${name}: unsafe input must remain fatal`);
      assert.equal(fs.existsSync(fixture.record), false, 'fatal classification must not leave a success record');
      assert.match(diagnostic, errorPattern, `${name}: refusal must identify the safety boundary, not a harness/network failure`);
      assert.doesNotMatch(diagnostic, /cannot fetch|fetch failed|ENETUNREACH|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i);
    }
    results.push({ name, status: 'PASS' });
  } catch (error) {
    results.push({ name, status: 'FAIL', message: error.message });
  }
}
try {
  console.log(JSON.stringify({
    kind: 'media-classification-source', appVersion: readJson('/app/package.json').version,
    fsSafeVersion: sourceMetadata.version, callerSha256: sha256(callerBytes), builderSha256: sha256(builderBytes)
  }));
  run('unknown-version-metadata-only', setUnknownVersion, true);
  run('unknown-caller-comment-only', changeCaller, true);
  run('unknown-version-transitive-initializer-must-not-run', fixture => {
    setUnknownVersion(fixture);
    const siblingName = 'media-classification-bystander.mjs';
    fs.writeFileSync(path.join(fixture.app, 'dist', siblingName), 'export const bystander = "original-image-bytes";\n', { flag: 'wx' });
    // The payload targets only this private synthetic app, outside both package
    // trees and the guarded caller. Importing the handoff must not execute it.
    const initializerName = 'media-classification-initializer-fixture.js';
    const initializer = [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(new URL(${JSON.stringify(`../../../../dist/${siblingName}`)}, import.meta.url), 'export const bystander = "unexpected-initializer-write";\\n');`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(fixture.packageRoot, 'dist', initializerName), initializer, { flag: 'wx' });
    const handoffPath = path.join(fixture.packageRoot, 'dist/private-producer-handoff.js');
    const handoff = fs.readFileSync(handoffPath);
    fs.writeFileSync(handoffPath, Buffer.concat([Buffer.from(`import ${JSON.stringify(`./${initializerName}`)};\n`), handoff]));
  }, true);
  run('unknown-version-missing-caller', fixture => {
    setUnknownVersion(fixture); fs.unlinkSync(fixture.caller);
  }, false, /guarded media|caller|layout|unaudited fs-safe version/i);
  run('unknown-version-ambiguous-callers', fixture => {
    setUnknownVersion(fixture);
    fs.copyFileSync(fixture.caller, path.join(fixture.app, 'dist/store.read-scope-fixture-duplicate.mjs'));
  }, false, /guarded media|caller|layout|unaudited fs-safe version/i);
  run('malformed-package-metadata', fixture => {
    fs.writeFileSync(path.join(fixture.packageRoot, 'package.json'), '{"name":"@openclaw/fs-safe","version":');
  }, false, /JSON|package config|package\.json|Unexpected|SyntaxError/i);
  run('known-version-handoff-corruption-with-unknown-caller', fixture => {
    changeCaller(fixture); corrupt(fixture, 'private-producer-handoff.js');
  }, false, /unaudited installed dependency bytes/i);
  run('known-version-publication-corruption-with-unknown-caller', fixture => {
    changeCaller(fixture); corrupt(fixture, 'publish-file.js');
  }, false, /unaudited installed dependency bytes/i);
  run('unknown-version-missing-native-binding', fixture => {
    setUnknownVersion(fixture); fs.rmSync(fixture.nativeRoot, { recursive: true });
  }, false, /native|binding|ABI|helper-unavailable|unaudited fs-safe version/i);
} finally {
  try {
    unchanged(sourcePackage, originalPackage);
    unchanged(sourceNative, originalNative);
    assert(fs.readFileSync(sourceCaller).equals(callerBytes), 'original /app caller was modified');
    assert(fs.readFileSync('/app/package.json').equals(originalAppMetadata), 'original /app metadata was modified');
    assert(fs.readFileSync(builder).equals(builderBytes), 'builder source was modified');
  } finally {
    // Only the exact mkdtemp-owned tree is disposable; never remove /app or a
    // builder-owned installation outside this fixture root.
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false, 'fixture-owned temporary tree remains');
  }
}
for (const result of results) console.log(JSON.stringify({ kind: 'media-classification-case', ...result }));
assert.equal(results.filter(result => result.status === 'FAIL').length, 0, 'media unchanged-upstream classification regression failed');
