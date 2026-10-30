import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
const base = process.argv[2];
assert(base && fs.statfsSync(base).type === 0x65735546, 'consumer requires calibrated real FUSE');
const root = fs.mkdtempSync(path.join(base, 'media-store-consumer-'));
Object.assign(process.env, { HOME: root, OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_DIR: root, OPENCLAW_CONFIG_PATH: path.join(root, 'openclaw.json'), OPENCLAW_WORKSPACE_DIR: path.join(root, 'workspace') });
const requireImage = createRequire('/app/package.json');
const pkgRoot = path.dirname(path.dirname(requireImage.resolve('@openclaw/fs-safe')));
const nativeModule = await import(pathToFileURL(path.join(pkgRoot, 'dist/native.js')).href);
const binding = nativeModule.requireNativeBinding('renameNoReplace', 'linkBeneath', 'removeStagedFile');
const counts = { renameUnsupported: 0, nativeLink: 0, nativeUnlink: 0 };
nativeModule.__setNativeLoaderForTest(() => ({
  ...binding,
  renameNoReplace() { counts.renameUnsupported++; throw Object.assign(new Error('fixture ENOTSUP'), { code: 'ENOTSUP' }); },
  linkBeneath(...args) { counts.nativeLink++; return binding.linkBeneath(...args); },
  removeStagedFile(...args) { counts.nativeUnlink++; return binding.removeStagedFile(...args); },
}));
const provenance = JSON.parse(fs.readFileSync('/usr/local/lib/openclaw-unraid-media-fuse.json'));
const storeModules = fs.readdirSync('/app/dist').filter(name => /^store-[\w-]+\.mjs$/.test(name))
  .map(name => ({ file: path.join('/app/dist', name), source: fs.readFileSync(path.join('/app/dist', name), 'utf8') }))
  .filter(module => module.source.includes('async function saveMediaBuffer('));
assert.equal(storeModules.length, 1);
const storeModule = storeModules[0];
const storeExports = await import(pathToFileURL(storeModule.file).href);
const pick = name => {
  const alias = storeModule.source.match(new RegExp(`\\b${name} as (\\w+)`))?.[1];
  const fn = storeExports[name] ?? storeExports[alias];
  assert.equal(typeof fn, 'function', `missing actual export ${name}`);
  return fn;
};
const store = { f: pick('saveMediaBuffer'), h: pick('saveMediaStream'), u: pick('readMediaBuffer'), s: pick('getMediaDir') };
const { writeReadScopeMedia } = await import(pathToFileURL(provenance.caller.path).href);
assert.equal(store.s(), path.join(root, 'media'));
const payload = Buffer.alloc(12977751);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) % 256;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const expectedHash = digest(payload);
const input = path.join(root, 'generated-input.bin');
fs.writeFileSync(input, payload, { flag: 'wx' });
// A new synthetic PDF, not the user's document. Pad a legal PDF comment before
// xref to 319,700 bytes; this size is a test choice, not a claim about the report.
const pdfText = 'BT /F1 12 Tf 72 720 Td (Synthetic FUSE PDF) Tj ET\n';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${Buffer.byteLength(pdfText)} >>\nstream\n${pdfText}endstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];
let prefix = '%PDF-1.4\n';
const offsets = [0];
for (const [index, body] of objects.entries()) { offsets.push(Buffer.byteLength(prefix)); prefix += `${index + 1} 0 obj\n${body}\nendobj\n`; }
const xref = 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
let padding = 319000;
let pdf;
for (let pass = 0; pass < 3; pass++) {
  const body = prefix + '%' + 'p'.repeat(padding) + '\n';
  pdf = Buffer.from(body + xref + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${Buffer.byteLength(body)}\n%%EOF\n`);
  padding += 319700 - pdf.length;
}
assert.equal(pdf.length, 319700);
const pdfInput = path.join(root, 'generated-input.pdf');
fs.writeFileSync(pdfInput, pdf, { flag: 'wx' });
const limit = 500 * 1024 * 1024;
const results = [];
const originalUuid = crypto.randomUUID;
const originalLink = fs.linkSync;
const originalRemove = binding.removeStagedFile;
const originalNativeLink = binding.linkBeneath;
const fixedUuid = '11111111-1111-4111-8111-111111111111';
crypto.randomUUID = () => fixedUuid;
const foreign = Buffer.from('foreign-object-must-survive\n');
const guarded = { assertCommitAllowed() { } };
async function run(name, fn) {
  try { const detail = await fn(); results.push({ name, status: 'PASS', ...detail }); }
  catch (error) { results.push({ name, status: 'FAIL', code: error.code, message: error.message }); }
  finally { fs.linkSync = originalLink; binding.linkBeneath = originalNativeLink; binding.removeStagedFile = originalRemove; syncBuiltinESMExports(); }
}
async function check(saved, subdir, expected = payload) {
  assert.equal(saved.size, expected.length);
  const raw = fs.readFileSync(saved.path);
  const contentHash = digest(expected);
  assert.equal(digest(raw), contentHash);
  const stat = fs.lstatSync(saved.path, { bigint: true });
  assert.equal(stat.nlink, 1n);
  const reopened = await store.u(saved.id, subdir, limit);
  assert.equal(digest(reopened.buffer), contentHash);
  return { id: saved.id, bytes: saved.size, sha256: contentHash, nlink: String(stat.nlink) };
}
try {
  console.log(JSON.stringify({
    kind: 'consumer-identity', openclaw: requireImage('./package.json').version,
    fsSafe: JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'))).version,
    consumer: storeModule.file, consumerSha256: digest(Buffer.from(storeModule.source)),
    provenance,
    payloadBytes: payload.length, payloadSha256: expectedHash, realFuse: true
  }));
  await run('public-saveMediaBuffer-fileStore-and-readMediaBuffer', async () => check(await store.f(payload, 'application/octet-stream', 'buffer', limit), 'buffer'));
  await run('public-saveMediaBuffer-guarded-and-readMediaBuffer', async () => check(await store.f(payload, 'application/octet-stream', 'guarded-buffer', limit, undefined, undefined, guarded), 'guarded-buffer'));
  await run('public-saveMediaStream-private-producer-and-readMediaBuffer', async () => check(await store.h(fs.createReadStream(input), 'application/octet-stream', 'stream', limit), 'stream'));
  await run('public-saveMediaStream-guarded-and-readMediaBuffer', async () => check(await store.h(fs.createReadStream(input), 'application/octet-stream', 'guarded-stream', limit, undefined, undefined, guarded), 'guarded-stream'));
  for (const [kind, options] of [['plain', undefined], ['guarded', guarded]]) {
    await run(`synthetic-PDF-public-saveMediaBuffer-${kind}`, async () => {
      const subdir = `pdf-buffer-${kind}`;
      const saved = await store.f(pdf, 'application/pdf', subdir, limit, 'synthetic-proof.pdf', undefined, options);
      assert(saved.id.endsWith('.pdf'));
      return check(saved, subdir, pdf);
    });
    await run(`synthetic-PDF-public-saveMediaStream-${kind}`, async () => {
      const subdir = `pdf-stream-${kind}`;
      const saved = await store.h(fs.createReadStream(pdfInput), 'application/pdf', subdir, limit, 'synthetic-proof.pdf', undefined, options);
      assert(saved.id.endsWith('.pdf'));
      return check(saved, subdir, pdf);
    });
  }
  await run('synthetic-PDF-guarded-no-overwrite', async () => {
    const saved = await store.f(pdf, 'application/pdf', 'pdf-collision', limit, 'proof.pdf', undefined, guarded);
    const identity = fs.lstatSync(saved.path, { bigint: true });
    await assert.rejects(store.f(Buffer.concat([pdf, Buffer.from('\n')]), 'application/pdf', 'pdf-collision', limit, 'proof.pdf', undefined, guarded));
    assert.equal(fs.lstatSync(saved.path, { bigint: true }).ino, identity.ino);
    assert.equal(digest(fs.readFileSync(saved.path)), digest(pdf));
    return { originalSyntheticPdfRetained: true };
  });
  await run('synthetic-PDF-stream-error-preserves-input-and-cleans-stage', async () => {
    async function* failingPdf() { yield pdf.subarray(0, 8192); throw new Error('synthetic PDF producer failed'); }
    await assert.rejects(store.h(failingPdf(), 'application/pdf', 'pdf-write-error', limit, 'proof.pdf', undefined, guarded));
    assert.equal(digest(fs.readFileSync(pdfInput)), digest(pdf));
    assert.deepEqual(fs.readdirSync(path.join(root, 'media/pdf-write-error')), []);
    return { originalSyntheticPdfRetained: true, temporaryOutputRemoved: true };
  });
  await run('public-guarded-target-collision-never-overwrites', async () => {
    const saved = await store.f(payload, 'application/octet-stream', 'collision', limit, undefined, undefined, guarded);
    const identity = fs.lstatSync(saved.path, { bigint: true });
    await assert.rejects(store.f(foreign, 'application/octet-stream', 'collision', limit, undefined, undefined, guarded));
    assert.equal(fs.lstatSync(saved.path, { bigint: true }).ino, identity.ino);
    assert.equal(digest(fs.readFileSync(saved.path)), expectedHash);
    return { targetRetained: true };
  });
  await run('public-guarded-target-symlink-never-followed', async () => {
    const saved = await store.f(payload, 'application/octet-stream', 'symlink', limit, undefined, undefined, guarded);
    const victim = path.join(root, 'foreign-victim'); fs.writeFileSync(victim, foreign);
    fs.unlinkSync(saved.path); fs.symlinkSync(victim, saved.path);
    await assert.rejects(store.f(payload, 'application/octet-stream', 'symlink', limit, undefined, undefined, guarded));
    assert(fs.lstatSync(saved.path).isSymbolicLink()); assert.deepEqual(fs.readFileSync(victim), foreign);
    return { victimRetained: true };
  });
  await run('public-stored-symlink-and-extra-hardlink-refused', async () => {
    const saved = await store.f(payload, 'application/octet-stream', 'stored-security', limit);
    const alias = path.join(root, 'additional-hardlink'); fs.linkSync(saved.path, alias);
    await assert.rejects(store.u(saved.id, 'stored-security', limit));
    fs.unlinkSync(alias);
    const held = `${saved.path}.held`; fs.renameSync(saved.path, held); fs.symlinkSync(held, saved.path);
    await assert.rejects(store.u(saved.id, 'stored-security', limit));
    assert.equal(digest(fs.readFileSync(held)), expectedHash);
    return { originalBytesRetained: true };
  });
  await run('public-guarded-target-substitution-refused-and-values-retained', async () => {
    let moved;
    binding.linkBeneath = (...args) => {
      originalNativeLink.apply(binding, args);
      const target = path.join(fs.readlinkSync(`/proc/self/fd/${args[2]}`), args[3]);
      if (String(target).includes('guarded-swap')) {
        moved = `${target}.held`; fs.renameSync(target, moved); fs.writeFileSync(target, foreign, { flag: 'wx' });
      }
    };
    await assert.rejects(store.f(payload, 'application/octet-stream', 'guarded-swap', limit, undefined, undefined, guarded));
    assert(moved); assert.equal(digest(fs.readFileSync(moved)), expectedHash);
    assert.deepEqual(fs.readFileSync(moved.slice(0, -5)), foreign);
    return { admittedBytesAndForeignBytesRetained: true };
  });
  await run('public-guarded-post-unlink-error-retains-sole-target', async () => {
    binding.removeStagedFile = (...args) => { const result = originalRemove.apply(binding, args); throw Object.assign(new Error(`fixture after ${result}`), { code: 'EIO' }); };
    await assert.rejects(store.f(payload, 'application/octet-stream', 'guarded-unlink-error', limit, undefined, undefined, guarded));
    const dir = path.join(root, 'media/guarded-unlink-error');
    const names = fs.readdirSync(dir); assert.equal(names.length, 1);
    const output = path.join(dir, names[0]); assert.equal(digest(fs.readFileSync(output)), expectedHash);
    assert.equal(fs.statSync(output).nlink, 1);
    return { errorPropagated: true, soleTargetRetained: true };
  });
  await run('public-stream-write-error-preserves-input-and-cleans-temporary-output', async () => {
    async function* failing() { yield payload.subarray(0, 8192); throw new Error('fixture producer failed'); }
    await assert.rejects(store.h(failing(), 'application/octet-stream', 'write-error', limit, undefined, undefined, guarded));
    assert.equal(digest(fs.readFileSync(input)), expectedHash);
    assert.deepEqual(fs.readdirSync(path.join(root, 'media/write-error')), []);
    return { sourceRetained: true, temporaryOutputRemoved: true };
  });
  await run('public-subdir-escape-refused', async () => {
    await assert.rejects(store.f(payload, 'application/octet-stream', '../escape', limit));
    assert(!fs.existsSync(path.join(root, 'escape'))); return { escapedWrite: false };
  });
  await run('guarded-real-caller-result-id-traversal-refused', async () => {
    const dir = path.join(root, 'media/result-traversal'); fs.mkdirSync(dir);
    await assert.rejects(writeReadScopeMedia({
      dir, tempPrefix: '.fixture', write: async handle => {
        await handle.writeFile(pdf); return { id: '../../outside.pdf' };
      }
    }));
    assert(!fs.existsSync(path.join(root, 'outside.pdf')));
    return { escapedWrite: false };
  });
  await run('guarded-real-caller-result-id-symlink-parent-refused', async () => {
    const dir = path.join(root, 'media/result-alias'); fs.mkdirSync(dir);
    const outside = path.join(root, 'outside-directory'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(dir, 'alias'));
    await assert.rejects(writeReadScopeMedia({
      dir, tempPrefix: '.fixture', write: async handle => {
        await handle.writeFile(pdf); return { id: 'alias/escape.pdf' };
      }
    }));
    assert.deepEqual(fs.readdirSync(outside), []);
    return { escapedWrite: false };
  });
  await run('guarded-real-caller-extra-source-hardlink-refused', async () => {
    const dir = path.join(root, 'media/source-hardlink'); fs.mkdirSync(dir);
    const alias = path.join(root, 'source-stage-alias');
    await assert.rejects(writeReadScopeMedia({
      dir, tempPrefix: '.fixture', write: async handle => {
        await handle.writeFile(pdf); const source = fs.readlinkSync(`/proc/self/fd/${handle.fd}`);
        fs.linkSync(source, alias); return { id: 'published.pdf' };
      }
    }));
    assert.equal(digest(fs.readFileSync(alias)), digest(pdf));
    assert(!fs.existsSync(path.join(dir, 'published.pdf')));
    return { admittedBytesRetained: true, publicationRefused: true };
  });
  await run('public-guarded-source-substitution-refused-and-values-retained', async () => {
    let saved, sourceName, targetName;
    binding.linkBeneath = (...args) => {
      const source = path.join(fs.readlinkSync(`/proc/self/fd/${args[0]}`), args[1]);
      if (source.includes('guarded-source-swap')) {
        sourceName = source; targetName = path.join(fs.readlinkSync(`/proc/self/fd/${args[2]}`), args[3]);
        saved = `${source}.held`; fs.renameSync(source, saved); fs.writeFileSync(source, foreign, { flag: 'wx' });
      }
      return originalNativeLink.apply(binding, args);
    };
    await assert.rejects(store.f(payload, 'application/octet-stream', 'guarded-source-swap', limit, undefined, undefined, guarded));
    assert(saved); assert.equal(digest(fs.readFileSync(saved)), expectedHash);
    assert.deepEqual(fs.readFileSync(sourceName), foreign); assert.deepEqual(fs.readFileSync(targetName), foreign);
    return { admittedBytesAndForeignBytesRetained: true };
  });
  await run('public-guarded-parent-substitution-stays-on-pinned-directory', async () => {
    const dir = path.join(root, 'media/guarded-parent-swap'); const held = `${dir}.held`;
    let targetName;
    binding.linkBeneath = (...args) => {
      const targetDir = fs.readlinkSync(`/proc/self/fd/${args[2]}`);
      if (targetDir === dir) {
        targetName = args[3]; fs.renameSync(dir, held); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'foreign'), foreign);
      }
      return originalNativeLink.apply(binding, args);
    };
    await assert.rejects(store.f(payload, 'application/octet-stream', 'guarded-parent-swap', limit, undefined, undefined, guarded));
    assert(targetName); assert(!fs.existsSync(path.join(dir, targetName)));
    assert.deepEqual(fs.readFileSync(path.join(dir, 'foreign')), foreign);
    assert.equal(digest(fs.readFileSync(path.join(held, targetName))), expectedHash);
    return { pinnedOriginalBytesAndForeignDirectoryRetained: true };
  });
  const leaked = fs.readdirSync('/proc/self/fd').flatMap(fd => {
    try { const target = fs.readlinkSync(`/proc/self/fd/${fd}`); return target.startsWith(root) ? [target] : []; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return []; }
  });
  assert.deepEqual(leaked, [], 'consumer leaked owned file/directory descriptors');
} finally {
  crypto.randomUUID = originalUuid; fs.linkSync = originalLink; binding.linkBeneath = originalNativeLink; binding.removeStagedFile = originalRemove;
  nativeModule.__resetNativeLoaderForTest(); syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true });
  for (const result of results) console.log(JSON.stringify(result));
  console.log(JSON.stringify({
    kind: 'consumer-summary', passed: results.filter(x => x.status === 'PASS').length,
    failed: results.filter(x => x.status === 'FAIL').length, counts, cleanupRoot: root, cleanupAbsent: !fs.existsSync(root),
    unexercised: ['actual Unraid filesystem', 'Telegram/network/provider transport', 'read-scope cancellation/delegation', 'crash/durability/cross-device', 'full concurrent attacker race space', 'arm64 runtime']
  }));
}
process.exitCode = results.some(x => x.status === 'FAIL') ? 1 : 0;
