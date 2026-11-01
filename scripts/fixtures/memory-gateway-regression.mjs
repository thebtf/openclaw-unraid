#!/usr/bin/env node
// Run: node scripts/fixtures/memory-gateway-regression.mjs EXACT_IMAGE_ID [LOCAL_CONTEXT]
// Node >=18, existing local Linux image; no builds, pulls, host mounts or provider access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const directory = path.dirname(fileURLToPath(import.meta.url));
const imageId = process.argv[2];
const contextName = process.argv[3] ?? (process.platform === 'win32' ? 'desktop-linux' : 'default');
assert(process.argv.length === 3 || process.argv.length === 4, 'usage: node memory-gateway-regression.mjs EXACT_IMAGE_ID [LOCAL_CONTEXT]');
assert.match(imageId ?? '', /^sha256:[a-f0-9]{64}$/, 'tags and mutable selectors are refused');
assert.match(contextName, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'Docker context must be an explicit name');
for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'BUILDKIT_HOST']) {
  assert(!process.env[key], `${key} must be unset; remote or ambiguous overrides are refused`);
}
let endpoint;
let containerId;
let creationAttempted = false;
let sequence = 0;
const token = randomUUID();
const name = `memory-gateway-regression-${token}`;
const ownerLabel = 'io.openclaw.memory-gateway-regression';
const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-gateway-regression-'));
const receiptPath = path.join(runDirectory, 'receipt.json');
const receipt = { schema: 'openclaw-memory-gateway-host/1', status: 'INCOMPLETE', started: new Date().toISOString(), contextName, endpoint: null, imageId, token, name, runDirectory, executedScenarios: 0, cleanup: 'NOT_ATTEMPTED' };
const persist = () => fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
function docker(args, { allowFailure = false, timeout = 30000, input } = {}) {
  assert(endpoint || (args.length === 3 && args[0] === 'context' && args[1] === 'inspect' && args[2] === contextName), 'resolve the named local context before contacting a daemon');
  const result = spawnSync('docker', endpoint ? ['--host', endpoint, ...args] : args, {
    cwd: directory, encoding: 'utf8', windowsHide: true, timeout, input, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' },
  });
  const step = ++sequence;
  fs.writeFileSync(path.join(runDirectory, `${step}.stdout`), result.stdout ?? '', { mode: 0o600 });
  fs.writeFileSync(path.join(runDirectory, `${step}.stderr`), result.stderr ?? '', { mode: 0o600 });
  fs.appendFileSync(path.join(runDirectory, 'docker.jsonl'), JSON.stringify({ step, args, status: result.status, signal: result.signal, error: result.error?.message ?? null, stdinBytes: input ? Buffer.byteLength(input) : 0 }) + '\n', { mode: 0o600 });
  if (!allowFailure) {
    assert.ifError(result.error);
    assert.equal(result.status, 0, `Docker ${args[0]} failed; see ${runDirectory}/${step}.stderr`);
  }
  return result;
}
function inspectOwned(reference = containerId) {
  const result = docker(['container', 'inspect', reference], { allowFailure: true });
  assert.ifError(result.error);
  if (result.status !== 0) {
    assert.match(result.stderr ?? '', /No such (?:container|object)/i, 'inspection failure is not evidence of absence');
    return null;
  }
  const value = JSON.parse(result.stdout)[0];
  assert.equal(value.Config.Labels?.[ownerLabel], token, 'never adopt or remove foreign fixture resources');
  assert.equal(value.Name, `/${name}`);
  assert.equal(value.Image, imageId);
  assert.equal(value.Config.Image, imageId);
  if (containerId) assert.equal(value.Id, containerId);
  return value;
}
try {
  persist();
  const contexts = JSON.parse(docker(['context', 'inspect', contextName]).stdout);
  assert.equal(contexts.length, 1, 'one explicit local Docker context required');
  assert.equal(contexts[0].Name, contextName);
  const resolvedEndpoint = contexts[0].Endpoints?.docker?.Host;
  assert.equal(typeof resolvedEndpoint, 'string');
  assert.match(resolvedEndpoint, /^(?:npipe:\/\/\/\/\.\/pipe\/[^/\\\s\0]+|unix:\/\/\/[^\s\0]+)$/, 'only a local named pipe or Unix socket is permitted');
  endpoint = resolvedEndpoint;
  receipt.endpoint = endpoint;
  const info = JSON.parse(docker(['info', '--format', '{"id":{{json .ID}},"osType":{{json .OSType}},"operatingSystem":{{json .OperatingSystem}}}']).stdout);
  assert.equal(info.osType, 'linux');
  if (process.platform === 'win32') assert(/Docker Desktop/i.test(info.operatingSystem), 'Windows runs require the actual local Linux Docker Desktop engine');
  receipt.daemon = info;
  const image = JSON.parse(docker(['image', 'inspect', imageId]).stdout)[0];
  assert.equal(image.Id, imageId);
  assert.equal(image.Os, 'linux');
  assert.equal(image.Architecture, 'amd64');
  assert.equal(Object.keys(image.Config.Volumes ?? {}).length, 0, 'image-declared persistent volumes are refused');
  receipt.image = { id: image.Id, repoDigests: image.RepoDigests, versionLabel: image.Config.Labels?.['org.opencontainers.image.version'], baseDigestLabel: image.Config.Labels?.['org.opencontainers.image.base.digest'] };
  const sourceNames = ['memory-gateway-regression.mjs', 'memory-gateway-scenario.mjs', 'memory-gateway-observer.cjs'];
  receipt.inputs = Object.fromEntries(sourceNames.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex')]));
  const files = Object.fromEntries(sourceNames.slice(1).map(file => [file, fs.readFileSync(path.join(directory, file), 'utf8')]));
  const bootstrap = `import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';const root=fs.mkdtempSync('/tmp/memory-gateway-package-');try{const files=${JSON.stringify(files)};for(const [name,content] of Object.entries(files))fs.writeFileSync(path.join(root,name),content,{flag:'wx',mode:0o600});await import(pathToFileURL(path.join(root,'memory-gateway-scenario.mjs')).href);}finally{fs.rmSync(root,{recursive:true,force:false});console.log(JSON.stringify({schema:'memory-gateway-package-cleanup/1',absent:!fs.existsSync(root)}));}`;
  persist();
  creationAttempted = true;
  const created = docker(['create', '--pull=never', '--name', name, '--label', `${ownerLabel}=${token}`,
    '--interactive', '--network=none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777',
    '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--no-healthcheck', '--restart=no',
    '--memory=3g', '--memory-swap=3g', '--cpus=2', '--pids-limit=256', '--workdir=/app', '--entrypoint=node', imageId,
    '--input-type=module', '-']);
  containerId = created.stdout.trim();
  assert.match(containerId, /^[a-f0-9]{64}$/);
  receipt.containerId = containerId;
  const container = inspectOwned();
  assert(container);
  assert.equal(container.HostConfig.NetworkMode, 'none');
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.equal(container.HostConfig.Privileged, false);
  assert.equal(container.Config.User, '1000:1000');
  assert.equal(container.HostConfig.Memory, 3 * 1024 ** 3);
  assert.equal(container.HostConfig.MemorySwap, 3 * 1024 ** 3);
  assert.deepEqual(container.HostConfig.PortBindings ?? {}, {});
  assert(container.Mounts.every(mount => mount.Type === 'tmpfs' && mount.Destination === '/tmp'));
  assert.equal(Object.keys(container.HostConfig.Tmpfs).join(','), '/tmp');
  assert.deepEqual(container.HostConfig.Devices ?? [], []);
  assert.deepEqual(container.Config.Healthcheck.Test, ['NONE']);
  receipt.sourceDelivery = 'fixture sources via stdin into owned tmpfs; no bind mounts, socket, persistent volumes, ports or host credentials';
  persist();
  const execution = docker(['start', '--attach', '--interactive', containerId], { timeout: 720000, input: bootstrap, allowFailure: true });
  receipt.execution = { exitCode: execution.status, error: execution.error?.message ?? null, signal: execution.signal };
  const stopped = inspectOwned();
  assert(stopped);
  receipt.containerState = stopped.State;
  const records = (execution.stdout ?? '').split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const proofs = records.filter(record => record.schema === 'openclaw-gateway-memory-proof/1');
  assert.equal(proofs.length, 1, 'UNRESOLVED_MEMORY_GATEWAY_FIXTURE_ENTRYPOINT: one real in-container Gateway result required; inspect retained runtime stderr');
  receipt.proof = proofs[0];
  receipt.executedScenarios = receipt.proof.scenarios.length;
  const packageCleanup = records.filter(record => record.schema === 'memory-gateway-package-cleanup/1');
  assert.equal(packageCleanup.length, 1);
  assert.equal(packageCleanup[0].absent, true);
  assert.ifError(execution.error);
  assert.equal(execution.status, 0, 'Gateway regression failed; inspect the retained receipt and bounded logs');
  assert.equal(stopped.State.Running, false);
  assert.equal(stopped.State.OOMKilled, false);
  assert.equal(stopped.State.ExitCode, 0);
  assert.equal(receipt.proof.status, 'PASS');
  const repairMode = receipt.proof.identity?.provenance?.mode;
  assert(['patched', 'upstream-unmodified'].includes(repairMode));
  const expectedModes = repairMode === 'patched' ? ['candidate', 'headroom-fallback'] : ['upstream-unmodified'];
  assert.deepEqual(receipt.proof.scenarios.map(scenario => [scenario.mode, scenario.status]), expectedModes.map(mode => [mode, 'PASS']));
  assert.equal(receipt.proof.cleanup.ownedProcessesRemaining, 0);
  assert.equal(receipt.proof.cleanup.syntheticRootAbsent, true);
  receipt.status = 'PASS';
} catch (error) {
  receipt.status = 'FAIL';
  receipt.error = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  try {
    const current = creationAttempted ? inspectOwned(containerId ?? name) : null;
    if (current) {
      containerId ??= current.Id;
      docker(['container', 'rm', '--force', containerId]);
      assert.equal(docker(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `id=${containerId}`]).stdout.trim(), '', 'owned container remains after cleanup');
    }
    receipt.cleanup = { status: 'PASS', containerId: containerId ?? null, absent: true, creationAttempted, hostBindMounts: 0, persistentVolumes: 0, imagesCreated: 0 };
  } catch (error) {
    receipt.status = 'FAIL';
    receipt.cleanup = { status: 'FAIL', containerId: containerId ?? null, error: error.message };
    process.exitCode = 1;
  }
  receipt.finished = new Date().toISOString();
  persist();
  // CI keeps the same bounded result evidence as local runs, not merely exit zero.
  process.stdout.write(JSON.stringify({ ...receipt, receiptPath }) + '\n');
}
