import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const childKind = process.argv[2]?.startsWith('--child-') ? process.argv[2].slice(8) : undefined;
const base = childKind ? process.argv[3] : process.argv[2] ?? os.tmpdir();
if (!childKind && process.argv[2]) assert.equal(fs.statfsSync(base).type, 0x65735546);
const root = childKind ? base : fs.mkdtempSync(path.join(base, 'media-native-mode-'));
process.env.FS_SAFE_NATIVE_MODE = childKind === 'required' ? 'require' : 'off';
Object.assign(process.env, { HOME: root, OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_DIR: root, OPENCLAW_CONFIG_PATH: path.join(root, 'openclaw.json'), OPENCLAW_WORKSPACE_DIR: path.join(root, 'workspace') });
const requireImage = createRequire('/app/package.json');
const modules = fs.readdirSync('/app/dist').filter(name => /^store-[\w-]+\.mjs$/.test(name))
  .map(name => ({ file: path.join('/app/dist', name), source: fs.readFileSync(path.join('/app/dist', name), 'utf8') }))
  .filter(module => module.source.includes('async function saveMediaBuffer('));
assert.equal(modules.length, 1);
const module = modules[0];
const exports = await import(pathToFileURL(module.file).href);
const pick = name => { const alias = module.source.match(new RegExp(`\\b${name} as (\\w+)`))?.[1]; const fn = exports[name] ?? exports[alias]; assert.equal(typeof fn, 'function'); return fn; };
const save = pick('saveMediaStream');
const read = pick('readMediaBuffer');
const pdfText = 'BT /F1 12 Tf 72 720 Td (Synthetic FUSE PDF) Tj ET\n';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${Buffer.byteLength(pdfText)} >>\nstream\n${pdfText}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];
let prefix = '%PDF-1.4\n'; const offsets = [0];
for (const [index, body] of objects.entries()) { offsets.push(Buffer.byteLength(prefix)); prefix += `${index + 1} 0 obj\n${body}\nendobj\n`; }
const xref = 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
let padding = 319000; let pdf;
for (let pass = 0; pass < 3; pass++) { const body = prefix + '%' + 'p'.repeat(padding) + '\n'; pdf = Buffer.from(body + xref + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${Buffer.byteLength(body)}\n%%EOF\n`); padding += 319700 - pdf.length; }
assert.equal(pdf.length, 319700);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const expectedHash = digest(pdf);
const limit = 500 * 1024 * 1024;
const guarded = { assertCommitAllowed() { } };
const foreign = Buffer.from('foreign-bytes-must-survive\n');
const originalLink = fs.linkSync;
const originalOpen = fsp.open;
const originalUuid = crypto.randomUUID;
crypto.randomUUID = () => '22222222-2222-4222-8222-222222222222';
async function* bytes() { yield pdf; }
const invoke = (subdir, options) => save(bytes(), 'application/pdf', subdir, limit, 'proof.pdf', undefined, options);
function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).flatMap(name => {
    const file = path.join(directory, name); const stat = fs.lstatSync(file);
    return stat.isDirectory() && !stat.isSymbolicLink() ? filesBelow(file) : [{ file, stat }];
  });
}
function completedFiles(directory) {
  return filesBelow(directory).filter(({ file, stat }) => stat.isFile() && stat.size === pdf.length && digest(fs.readFileSync(file)) === expectedHash).map(({ file }) => file);
}
if (childKind) {
  let linked, injected = 0, caught;
  if (childKind === 'emfile') {
    fs.linkSync = (source, target) => { originalLink(source, target); linked = String(target); };
    fsp.open = async (file, ...args) => {
      if (String(file) === linked && injected === 0) { injected++; throw Object.assign(new Error('fixture target pin EMFILE'), { code: 'EMFILE' }); }
      return originalOpen.call(fsp, file, ...args);
    };
    syncBuiltinESMExports();
  } else {
    const pkg = path.dirname(path.dirname(requireImage.resolve('@openclaw/fs-safe')));
    const native = await import(pathToFileURL(path.join(pkg, 'dist/native.js')).href);
    const binding = native.requireNativeBinding('linkBeneath');
    native.__setNativeLoaderForTest(() => ({ ...binding, linkBeneath: undefined }));
    fs.linkSync = () => { injected++; throw new Error('required mode must not select pathname fallback'); };
  }
  try { await invoke('child', childKind === 'required' ? guarded : undefined); } catch (error) { caught = error; }
  fs.linkSync = originalLink; fsp.open = originalOpen; syncBuiltinESMExports();
  assert(caught, 'fault boundary must propagate an exception');
  if (childKind === 'emfile') { assert.equal(caught.code, 'EMFILE'); assert.equal(injected, 1); }
  else { assert(JSON.stringify(caught, ['code', 'cause', 'message']).includes('helper-unavailable')); assert.equal(injected, 0); }
  assert(completedFiles(path.join(root, 'media')).length >= 1, 'completed output must retain a data name before exit');
  console.log(JSON.stringify({ kind: 'child-fault', fault: childKind, propagated: true, injected, completedNamesBeforeExit: completedFiles(path.join(root, 'media')).length }));
  // Leave the child naturally: the parent checks names after all exit callbacks.
} else {
  const results = [];
  async function run(name, fn) {
    try { const detail = await fn(); results.push({ name, status: 'PASS', ...detail }); }
    catch (error) { results.push({ name, status: 'FAIL', code: error.code, message: error.message }); }
    finally { fs.linkSync = originalLink; fsp.open = originalOpen; syncBuiltinESMExports(); }
  }
  try {
    console.log(JSON.stringify({ kind: 'native-mode-identity', openclaw: requireImage('./package.json').version, mode: process.env.FS_SAFE_NATIVE_MODE, realFuse: Boolean(process.argv[2]), pdfBytes: pdf.length, pdfSha256: expectedHash }));
    for (const [kind, options] of [['plain', undefined], ['guarded', guarded]]) {
      await run(`native-off-public-PDF-stream-${kind}`, async () => {
        const saved = await invoke(kind, options); const reopened = await read(saved.id, kind, limit);
        assert.equal(digest(reopened.buffer), expectedHash); assert.equal(fs.statSync(saved.path).nlink, 1);
        return { bytes: saved.size, sha256: expectedHash, nlink: 1 };
      });
    }
    await run('native-off-existing-target-never-overwritten', async () => {
      const saved = await invoke('collision', guarded); const before = fs.statSync(saved.path, { bigint: true });
      await assert.rejects(invoke('collision', guarded));
      assert.equal(fs.statSync(saved.path, { bigint: true }).ino, before.ino); assert.equal(digest(fs.readFileSync(saved.path)), expectedHash);
      return { admittedBytesRetained: true };
    });
    await run('native-off-target-symlink-never-followed', async () => {
      const saved = await invoke('symlink', guarded); const victim = path.join(root, 'foreign-victim'); fs.writeFileSync(victim, foreign);
      fs.unlinkSync(saved.path); fs.symlinkSync(victim, saved.path); await assert.rejects(invoke('symlink', guarded));
      assert(fs.lstatSync(saved.path).isSymbolicLink()); assert.deepEqual(fs.readFileSync(victim), foreign); return { foreignBytesRetained: true };
    });
    await run('native-off-stored-extra-hardlink-refused', async () => {
      const saved = await invoke('hardlink'); const alias = path.join(root, 'extra-hardlink'); fs.linkSync(saved.path, alias);
      await assert.rejects(read(saved.id, 'hardlink', limit)); assert.equal(digest(fs.readFileSync(alias)), expectedHash); return { admittedBytesRetained: true };
    });
    await run('native-off-target-substitution-refused-without-deleting-foreign-data', async () => {
      let held, targetPath;
      fs.linkSync = (source, target) => { originalLink(source, target); if (String(target).includes('target-swap')) { targetPath = target; held = `${target}.held`; fs.renameSync(target, held); fs.writeFileSync(target, foreign, { flag: 'wx' }); } };
      await assert.rejects(invoke('target-swap', guarded)); assert(held); assert.equal(digest(fs.readFileSync(held)), expectedHash); assert.deepEqual(fs.readFileSync(targetPath), foreign);
      return { admittedAndForeignBytesRetained: true };
    });
    await run('native-off-source-substitution-refused-without-deleting-foreign-data', async () => {
      let held, sourcePath, targetPath;
      fs.linkSync = (source, target) => { if (String(target).includes('source-swap')) { sourcePath = source; targetPath = target; held = `${source}.held`; fs.renameSync(source, held); fs.writeFileSync(source, foreign, { flag: 'wx' }); } return originalLink(source, target); };
      await assert.rejects(invoke('source-swap', guarded)); assert(held); assert.equal(digest(fs.readFileSync(held)), expectedHash); assert.deepEqual(fs.readFileSync(sourcePath), foreign); assert.deepEqual(fs.readFileSync(targetPath), foreign);
      return { admittedAndForeignBytesRetained: true };
    });
    await run('native-off-parent-substitution-refused', async () => {
      const dir = path.join(root, 'media/parent-swap'); const held = `${dir}.held`; let targetName;
      fs.linkSync = (source, target) => { originalLink(source, target); if (path.dirname(target) === dir) { targetName = path.basename(target); fs.renameSync(dir, held); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'foreign'), foreign); } };
      await assert.rejects(invoke('parent-swap', guarded)); assert(targetName); assert.equal(digest(fs.readFileSync(path.join(held, targetName))), expectedHash); assert.deepEqual(fs.readFileSync(path.join(dir, 'foreign')), foreign);
      return { admittedAndForeignBytesRetained: true };
    });
    await run('native-off-partial-producer-failure-cleans-only-unfinished-output', async () => {
      async function* failing() { yield pdf.subarray(0, 1024); throw new Error('fixture partial producer failure'); }
      await assert.rejects(save(failing(), 'application/pdf', 'partial', limit, 'proof.pdf'));
      assert.deepEqual(filesBelow(path.join(root, 'media/partial')), []); return { incompleteOutputRemoved: true };
    });
    for (const fault of ['emfile', 'required']) {
      await run(`completed-output-survives-${fault}-and-child-exit-cleanup`, async () => {
        const childRoot = path.join(root, `${fault}-child`); fs.mkdirSync(childRoot);
        const output = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--child-${fault}`, childRoot], { encoding: 'utf8', env: { ...process.env, FS_SAFE_NATIVE_MODE: fault === 'required' ? 'require' : 'off' } });
        assert.equal(output.status, 0, `${output.stdout}\n${output.stderr}`);
        const complete = completedFiles(path.join(childRoot, 'media')); assert(complete.length >= 1, 'exit cleanup erased completed output');
        if (fault === 'emfile') { assert.equal(complete.length, 1); assert.equal(fs.statSync(complete[0]).nlink, 1); }
        return { completedNamesAfterExit: complete.length, child: output.stdout.trim(), errorNotSuppressed: true };
      });
    }
    const leaks = fs.readdirSync('/proc/self/fd').flatMap(fd => { try { const name = fs.readlinkSync(`/proc/self/fd/${fd}`); return name.startsWith(root) ? [name] : []; } catch (error) { if (error.code !== 'ENOENT') throw error; return []; } });
    assert.deepEqual(leaks, []);
  } finally {
    fs.linkSync = originalLink; fsp.open = originalOpen; crypto.randomUUID = originalUuid; syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true });
    for (const result of results) console.log(JSON.stringify(result));
    console.log(JSON.stringify({ kind: 'native-mode-summary', passed: results.filter(x => x.status === 'PASS').length, failed: results.filter(x => x.status === 'FAIL').length, realFuse: Boolean(process.argv[2]), cleanupAbsent: !fs.existsSync(root) }));
  }
  process.exitCode = results.some(x => x.status === 'FAIL') ? 1 : 0;
}
