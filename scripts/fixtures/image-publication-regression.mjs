#!/usr/bin/env node
// Run: node scripts/fixtures/image-publication-regression.mjs
// Needs Node >=18, Bash, Docker, and existing registry:2/alpine:3/busybox:1.37.0.
// No builds, pulls, remote registries, npm dependencies, or production edits.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workflowPath = path.join(root, '.github/workflows/build-image.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const lines = workflow.replace(/\r\n/g, '\n').split('\n');
const pushSteps = lines.flatMap((line, index) => /^      - name: Push\s*$/.test(line) ? [index] : []);
assert.equal(pushSteps.length, 1, 'expected exactly one real build-image Push step');
const stepStart = pushSteps[0];
let stepEnd = stepStart + 1;
while (stepEnd < lines.length && (!lines[stepEnd].trim() || /^ {8,}\S/.test(lines[stepEnd]))) stepEnd++;
const step = lines.slice(stepStart, stepEnd);
assert(step.includes("        if: steps.gate.outputs.build == 'true'"), 'Push must remain behind the tested-image gate');
assert(step.includes('          UPSTREAM_TAG: ${{ steps.tag.outputs.tag }}'), 'unknown Push upstream-tag environment mapping');
assert(step.includes('          CANDIDATE_IMAGE_ID: ${{ steps.candidate.outputs.image_id }}'), 'Push must receive the captured tested-image identity');
const runIndex = step.indexOf('        run: |');
assert(runIndex >= 0, 'expected literal Push shell block');
const runLines = step.slice(runIndex + 1);
assert(runLines.every((line) => !line.trim() || line.startsWith('          ')), 'unexpected Push block indentation');
const shell = runLines.map((line) => line.slice(10)).join('\n').replace(/\n*$/, '\n');
assert(!shell.includes('${{'), 'unresolved Actions interpolation inside Push shell');
// Fail closed if future workflow changes need broader effects. Only these real
// Docker tag/push operands can execute; shell control flow and quoting stay intact.
const destination = String.raw`"\$DERIVED_IMAGE:(?:latest|\$UPSTREAM_TAG|\$\{UPSTREAM_TAG\})"`;
const tagCommand = new RegExp(String.raw`^docker tag "\$CANDIDATE_IMAGE_ID" ${destination}$`);
const pushCommand = new RegExp(String.raw`^docker push ${destination}$`);
const guardCommands = new Set([
  'if [[ ! "$CANDIDATE_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]]; then',
  'echo "Invalid tested candidate image identity" >&2',
  'if [ "$(docker image inspect --format \'{{.Id}}\' "$DERIVED_IMAGE:smoke")" != "$CANDIDATE_IMAGE_ID" ]; then',
  'echo "Local smoke tag no longer identifies the tested candidate" >&2',
  'exit 1',
]);
for (const line of shell.split('\n').map((line) => line.trim())) {
  assert(!line || line.startsWith('#') || line === 'set -euo pipefail' ||
    /^if \[ "\$UPSTREAM_TAG" (?:!=|=|==) "latest" \]; then$/.test(line) ||
    line === 'else' || line === 'fi' || guardCommands.has(line) || tagCommand.test(line) || pushCommand.test(line),
    `unsupported Push command; review local-only effect boundary: ${line}`);
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${binary} ${args.join(' ')}: ${result.error?.message ?? `exit ${result.status}`}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout.trim();
}
const requestedHost = process.env.DOCKER_HOST || '';
const requestedContext = process.env.DOCKER_CONTEXT || '';
assert(!(requestedHost && requestedContext), 'ambiguous Docker routing: set only one of DOCKER_HOST or DOCKER_CONTEXT');
// Resolve context metadata without contacting its daemon. All daemon operations
// below use one checked endpoint explicitly, never ambient routing precedence.
const dockerEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:DOCKER_HOST|DOCKER_CONTEXT|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|BASH_ENV|ENV)$/i.test(key)));
Object.assign(dockerEnv, { MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*', BASH_ENV: '', ENV: '' });
const context = requestedHost ? '(explicit host)' : requestedContext || command('docker', ['context', 'show'], { env: dockerEnv });
const endpoint = requestedHost || JSON.parse(command('docker', ['--context', context, 'context', 'inspect', context], { env: dockerEnv }))[0]?.Endpoints?.docker?.Host;
assert(typeof endpoint === 'string' && (
  /^unix:\/\/\/[^\r\n\0]+$/.test(endpoint) || /^npipe:\/{4}\.\/pipe\/[^/\\\r\n\0]+$/.test(endpoint)
), 'requires a local Unix socket or local Windows named-pipe Docker endpoint');
const dockerArgs = (...args) => ['--host', endpoint, ...args];
const docker = (...args) => command('docker', dockerArgs(...args), { env: dockerEnv });
const dockerJson = (...args) => JSON.parse(docker(...args));
const bash = process.env.PUBLICATION_REGRESSION_BASH ?? (process.platform === 'win32'
  ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe') : 'bash');
command(bash, ['--noprofile', '--norc', '-c', 'command -v docker >/dev/null'], { env: dockerEnv });
const pinnedShell = 'docker() { command docker --host "$PUBLICATION_REGRESSION_DOCKER_ENDPOINT" "$@"; }\n' + shell;
const localImages = Object.fromEntries(['registry:2', 'alpine:3', 'busybox:1.37.0'].map((tag) => [
  tag, dockerJson('image', 'inspect', tag)[0].Id,
]));
assert.notEqual(localImages['alpine:3'], localImages['busybox:1.37.0'], 'fixture images must be distinct');
const runId = randomUUID().replaceAll('-', '');
const name = `image-publication-regression-${runId}`;
const localTags = new Set();
const results = [];
const testedImages = new Map();
let containerId;
let volumes = [];
let base;
let origin;
let cleanupFailed = false;

function check(label, actual, expected) {
  const passed = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ label, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}
async function registry(relative) {
  // Read on the daemon's host loopback too: Docker Desktop's Windows loopback
  // port forwarding is not necessarily reachable from its Linux daemon.
  const response = spawnSync('docker', dockerArgs('exec', containerId, 'wget', '-S', '-O', '-', '-T', '5',
    '--header', 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
    `${origin}/v2/${relative}`), { cwd: root, encoding: 'utf8', timeout: 10_000, env: dockerEnv });
  assert(!response.error && response.status === 0, `registry ${relative}: ${response.error?.message ?? response.stderr}`);
  return {
    body: JSON.parse(response.stdout),
    digest: response.stderr.match(/Docker-Content-Digest:\s*(sha256:[a-f0-9]{64})/i)?.[1],
  };
}
async function manifest(repository, tag) {
  const result = await registry(`${repository}/manifests/${tag}`);
  assert.match(result.digest ?? '', /^sha256:[a-f0-9]{64}$/, 'registry manifest digest missing');
  assert.match(result.body.config?.digest ?? '', /^sha256:[a-f0-9]{64}$/, 'expected single tiny-image manifest');
  return { digest: result.digest, image: result.body.config.digest };
}
function tag(source, destination) {
  assert(destination.startsWith(`${base}/`), 'tag destination escaped private registry');
  localTags.add(destination);
  docker('tag', source, destination);
}
function publish(source, destination) {
  tag(source, destination);
  docker('push', destination);
}
function executePush(repository, upstreamTag) {
  const derived = `${base}/${repository}`;
  assert.match(upstreamTag, /^(?:latest|2026\.1\.1)$/);
  localTags.add(`${derived}:latest`);
  localTags.add(`${derived}:${upstreamTag}`);
  const testedImageId = testedImages.get(`${derived}:smoke`);
  assert.match(testedImageId ?? '', /^sha256:[a-f0-9]{64}$/, 'publication requires a previously exercised immutable image');
  console.log(`EXECUTE actual Push: DERIVED_IMAGE=${derived} UPSTREAM_TAG=${upstreamTag}`);
  const output = command(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', pinnedShell], {
    env: { ...dockerEnv, PUBLICATION_REGRESSION_DOCKER_ENDPOINT: endpoint, DERIVED_IMAGE: derived, UPSTREAM_TAG: upstreamTag, CANDIDATE_IMAGE_ID: testedImageId },
  });
  console.log(output);
}
async function tags(repository, expected) {
  const actual = (await registry(`${repository}/tags/list`)).body.tags ?? [];
  check(`${repository}: publishes only selected tags, never smoke`, actual.sort(), [...expected].sort());
}
function smoke(image) {
  const imageId = docker('image', 'inspect', '--format', '{{.Id}}', image);
  const identity = docker('run', '--rm', '--pull', 'never', '--network', 'none', '--entrypoint', '/bin/sh', imageId,
    '-c', 'test -x /bin/busybox && printf "tiny-image-smoke-ok"');
  assert.equal(identity, 'tiny-image-smoke-ok', 'real tiny-image smoke must pass before publication');
  testedImages.set(image, imageId);
  console.log(`TESTED ${image} id=${imageId}: ${identity}`);
}

console.log(`SOURCE root=${root} HEAD=${command('git', ['rev-parse', 'HEAD'])}`);
console.log(`WORKFLOW sha256=${sha256(workflow)} PushLines=${stepStart + runIndex + 2}-${stepEnd} PushSha256=${sha256(shell)}`);
console.log(`FIXTURE sha256=${sha256(fs.readFileSync(fileURLToPath(import.meta.url)))}`);
console.log(`DOCKER context=${context} endpoint=${endpoint}`);
console.log(`IMAGES ${JSON.stringify(localImages)}`);
try {
  // Bind within the Docker host namespace, not a Windows-only forwarded port.
  // The registry itself listens strictly on 127.0.0.1; no published interface.
  base = `127.0.0.1:${randomInt(20_000, 60_000)}`;
  origin = `http://${base}`;
  containerId = docker('run', '-d', '--pull', 'never', '--name', name,
    '--label', `openclaw.publication-regression=${runId}`, '--network', 'host',
    '-e', `REGISTRY_HTTP_ADDR=${base}`, localImages['registry:2']);
  const container = dockerJson('inspect', containerId)[0];
  volumes = container.Mounts.filter((mount) => mount.Type === 'volume').map((mount) => mount.Name);
  assert.equal(container.HostConfig.NetworkMode, 'host');
  assert(container.Config.Env.includes(`REGISTRY_HTTP_ADDR=${base}`), 'registry must bind only daemon loopback');
  assert.deepEqual(container.HostConfig.PortBindings, {}, 'registry must have no published host interfaces');
  console.log(`REGISTRY name=${name} id=${containerId} daemonLoopback=${origin} volumes=${JSON.stringify(volumes)}`);
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await registry(''); ready = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  assert(ready, 'private registry did not become ready');
  // Containerd may expose an index as image inspect Id, while push publishes
  // the available platform manifest. Obtain independent, real registry oracles.
  publish(localImages['alpine:3'], `${base}/fixture-identities:prior`);
  publish(localImages['busybox:1.37.0'], `${base}/fixture-identities:candidate`);
  const priorReference = await manifest('fixture-identities', 'prior');
  const candidateReference = await manifest('fixture-identities', 'candidate');
  assert.notEqual(priorReference.digest, candidateReference.digest, 'registry fixture contents must be distinct');
  console.log(`PLATFORM MANIFESTS prior=${JSON.stringify(priorReference)} candidate=${JSON.stringify(candidateReference)}`);

  const pinned = 'pinned-distinct';
  publish(localImages['alpine:3'], `${base}/${pinned}:latest`);
  publish(localImages['alpine:3'], `${base}/${pinned}:2026.1.1`);
  const prior = await manifest(pinned, 'latest');
  check('seed latest identifies prior image', prior.digest, priorReference.digest);
  tag(localImages['busybox:1.37.0'], `${base}/${pinned}:smoke`);
  smoke(`${base}/${pinned}:smoke`);
  executePush(pinned, '2026.1.1');
  const pinnedAfter = await manifest(pinned, '2026.1.1');
  const latestAfter = await manifest(pinned, 'latest');
  console.log(`PINNED before=${JSON.stringify(prior)} selected=${JSON.stringify(pinnedAfter)} latest=${JSON.stringify(latestAfter)}`);
  check('pinned version receives tested smoke content', pinnedAfter.digest, candidateReference.digest);
  check('pinned version preserves prior latest digest', latestAfter.digest, prior.digest);
  await tags(pinned, ['latest', '2026.1.1']);

  const latest = 'latest-distinct';
  publish(localImages['alpine:3'], `${base}/${latest}:latest`);
  publish(localImages['alpine:3'], `${base}/${latest}:2026.1.1`);
  const sentinel = await manifest(latest, '2026.1.1');
  tag(localImages['busybox:1.37.0'], `${base}/${latest}:smoke`);
  smoke(`${base}/${latest}:smoke`);
  executePush(latest, 'latest');
  const latestFirst = await manifest(latest, 'latest');
  check('latest receives tested smoke content', latestFirst.digest, candidateReference.digest);
  check('latest publication leaves existing pinned digest unchanged', (await manifest(latest, '2026.1.1')).digest, sentinel.digest);
  await tags(latest, ['latest', '2026.1.1']);
  executePush(latest, 'latest');
  check('identical latest content preserves digest', (await manifest(latest, 'latest')).digest, latestFirst.digest);
  check('identical latest leaves pinned digest unchanged', (await manifest(latest, '2026.1.1')).digest, sentinel.digest);
  await tags(latest, ['latest', '2026.1.1']);

  // Both public tags already contain the candidate: identical pinned publish
  // must also be harmless, without manufacturing a different-image assertion.
  publish(localImages['busybox:1.37.0'], `${base}/${latest}:2026.1.1`);
  const identicalPinned = await manifest(latest, '2026.1.1');
  executePush(latest, '2026.1.1');
  check('identical pinned content preserves selected digest', (await manifest(latest, '2026.1.1')).digest, identicalPinned.digest);
  check('identical pinned content preserves latest digest', (await manifest(latest, 'latest')).digest, latestFirst.digest);
  await tags(latest, ['latest', '2026.1.1']);
} catch (error) {
  results.push({ label: 'setup/execution', passed: false });
  console.error(`ERROR ${error.stack}`);
} finally {
  for (const tagName of localTags) {
    try {
      const present = docker('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', '--filter', `reference=${tagName}`);
      if (present) docker('image', 'rm', tagName);
    } catch (error) { cleanupFailed = true; console.error(`CLEANUP ERROR ${error.message}`); }
  }
  if (containerId) {
    try { docker('rm', '-f', '-v', containerId); }
    catch (error) { cleanupFailed = true; console.error(`CLEANUP ERROR ${error.message}`); }
  }
  try {
    const containers = docker('ps', '-aq', '--filter', `label=openclaw.publication-regression=${runId}`);
    const remainingTags = docker('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', '--filter', `reference=${base ?? name}/*`);
    const remainingVolumes = volumes.filter((volume) => docker('volume', 'ls', '-q', '--filter', `name=^${volume}$`));
    console.log(`CLEANUP READBACK containers=${JSON.stringify(containers)} tags=${JSON.stringify(remainingTags)} volumes=${JSON.stringify(remainingVolumes)}`);
    assert.equal(containers, '', 'owned registry container survived');
    assert.equal(remainingTags, '', 'owned local image tags survived');
    assert.deepEqual(remainingVolumes, [], 'owned anonymous registry volume survived');
    for (const [tagName, id] of Object.entries(localImages)) assert.equal(dockerJson('image', 'inspect', tagName)[0].Id, id, 'borrowed input image changed');
    console.log('CLEANUP PASS: own container, anonymous volumes and tags absent; borrowed images unchanged');
  } catch (error) { cleanupFailed = true; console.error(`CLEANUP ERROR ${error.stack}`); }
}
const failed = results.filter((result) => !result.passed).length;
console.log(`IMAGE PUBLICATION REGRESSION: ${results.length - failed} PASS / ${failed} FAIL; cleanup=${cleanupFailed ? 'FAIL' : 'PASS'}`);
process.exitCode = failed || cleanupFailed ? 1 : 0;
