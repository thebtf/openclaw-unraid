#!/usr/bin/env node
// Windows Docker Desktop runner; schema-only modes also run in Linux containers.
// No execution occurs merely on import.
// Run: node historical-same-volume-regression.mjs sha256:<local-image-id> <new-evidence-directory> --git-bash=<absolute-Git-for-Windows-bash.exe> [--expected-config-id=sha256:<config-id>]
// Uses the actual workflow importer/entrypoint/oracles. No pulls, tags, builds,
// automatic removal or force/prune. All resources remain for Main's inspection.
// Lifecycle adapted from Main's retained run-historical-gate.py, not its artifacts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runnerPath = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const endpoint = 'npipe:////./pipe/dockerDesktopLinuxEngine';
const context = 'desktop-linux';
const ownerLabel = 'io.openclaw.historical-gate.run';
const purposeLabel = 'io.openclaw.historical-gate.purpose';
const purpose = 'historical-2026.9.2-upgrade';
const immutable = /^sha256:[a-f0-9]{64}$/;
const fullId = /^[a-f0-9]{64}$/;
const overrides = /^(?:DOCKER_HOST|DOCKER_CONTEXT|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|DOCKER_CONFIG|DOCKER_API_VERSION|DOCKER_DEFAULT_PLATFORM|DOCKER_BUILDKIT|BUILDKIT_HOST|BUILDKIT_CONTEXT|BUILDX_BUILDER|BUILDX_CONFIG|BUILDX_HOST)$/i;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function environment() {
  assert.equal(process.platform, 'win32', 'requires this Windows Docker Desktop workstation');
  const found = Object.keys(process.env).filter((key) => overrides.test(key) && process.env[key]);
  assert.equal(found.length, 0, `refusing Docker/BuildKit overrides: ${found.join(', ')}`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:BASH_ENV|ENV|SHELLOPTS|BASHOPTS)$/.test(key) && !key.startsWith('BASH_FUNC_')));
  return { ...env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };
}
function writeExclusive(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function save(file, value) {
  const next = `${file}.next`;
  writeExclusive(next, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(next, file);
}
function same(actual, expected, label) { assert.deepEqual(actual, expected, label); }
function imageIdentity(image) {
  return Object.fromEntries(['Id', 'Os', 'Architecture', 'RootFS', 'Config'].map((key) => [key, image[key]]));
}
function volumeIdentity(volume) {
  return Object.fromEntries(['Name', 'CreatedAt', 'Driver', 'Scope', 'Mountpoint', 'Options', 'Labels'].map((key) => [key, volume[key]]));
}
function containerIdentity(container) {
  return {
    ...Object.fromEntries(['Id', 'Name', 'Created', 'Image', 'Mounts'].map((key) => [key, container[key]])),
    requestedImage: container.Config.Image, labels: container.Config.Labels
  };
}

class Engine {
  constructor(directory) {
    this.directory = directory;
    this.statePath = path.join(directory, 'resources.json');
    this.state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
  }
  persist() { save(this.statePath, this.state); }
  event(record) {
    const fd = fs.openSync(path.join(this.directory, 'docker-events.jsonl'), 'a', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(record)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  raw(args, input) {
    const env = environment();
    const sequence = ++this.state.sequence;
    this.persist();
    this.event({ event: 'before', sequence, args });
    // Context metadata is checked separately; effects always bind the literal
    // Desktop pipe, so a later context-file edit cannot reroute an operation.
    const result = spawnSync(this.state.dockerExe, ['--host', endpoint, ...args], {
      cwd: root, env, input, timeout: 360_000, maxBuffer: 64 * 1024 * 1024,
    });
    writeExclusive(path.join(this.directory, `${sequence}.stdout`), result.stdout ?? Buffer.alloc(0));
    writeExclusive(path.join(this.directory, `${sequence}.stderr`), result.stderr ?? Buffer.alloc(0));
    this.event({ event: 'after', sequence, status: result.status, signal: result.signal, error: result.error?.message });
    if (result.error || result.status === null || result.signal) {
      this.state.uncertain = true;
      this.persist();
      throw new Error(`Docker outcome unknown; preserve all resources: ${result.error?.message ?? result.signal}`);
    }
    return result;
  }
  checked(args, input) {
    const result = this.raw(args, input);
    assert.equal(result.status, 0, `Docker ${args[0]} failed: ${result.stderr.toString('utf8')}`);
    return result.stdout.toString('utf8').trim();
  }
  json(args) { return JSON.parse(this.checked(args)); }
  reconcile() {
    const metadata = this.json(['context', 'inspect', context])[0];
    assert.equal(metadata.Name, context);
    assert.equal(metadata.Endpoints.docker.Host, endpoint, 'desktop-linux endpoint drift');
    assert(!metadata.Endpoints.docker.SkipTLSVerify, 'unexpected TLS bypass');
    const info = this.json(['info', '--format', '{{json .}}']);
    assert.equal(info.Name, 'docker-desktop');
    assert.equal(info.OSType, 'linux');
    assert.match(info.OperatingSystem, /Docker Desktop/i);
    assert(info.ID, 'missing daemon identity');
    if (this.state.engineId) assert.equal(info.ID, this.state.engineId, 'daemon identity drift');
    else { this.state.engineId = info.ID; this.persist(); }
  }
  namesAbsent(kind, name) {
    const args = kind === 'container' ? ['container', 'ls', '--all', '--format', '{{.Names}}']
      : ['volume', 'ls', '--format', '{{.Name}}'];
    assert(!this.checked(args).split(/\r?\n/).includes(name), `resource name already exists: ${name}`);
  }
  pinImage(role, selector, expectedConfigId) {
    const image = this.json(['image', 'inspect', selector])[0];
    assert.match(image.Id, immutable);
    assert.equal(image.Os, 'linux');
    assert.equal(image.Architecture, 'amd64');
    if (role === 'candidate') assert.equal(image.Id, selector, 'immutable local image ID mismatch');
    // With containerd, inspect.Id may be an index ID rather than the config ID.
    // Do not require the config digest to resolve as a standalone local image.
    const byId = this.json(['image', 'inspect', image.Id])[0];
    same(imageIdentity(byId), imageIdentity(image), 'local image ID does not resolve to the same image');
    this.state.images[role] = { selector, id: image.Id, identity: imageIdentity(image), expectedConfigId };
    writeExclusive(path.join(this.directory, `${role}-image.inspect.json`), `${JSON.stringify(image, null, 2)}\n`);
    this.persist();
  }
  checkImages() {
    for (const pin of Object.values(this.state.images)) {
      for (const selector of new Set([pin.selector, pin.id])) {
        same(imageIdentity(this.json(['image', 'inspect', selector])[0]), pin.identity, 'pinned image drift');
      }
    }
  }
  createVolume(name) {
    this.reconcile();
    this.namesAbsent('volume', name);
    this.state.pending = { kind: 'volume', name };
    this.persist();
    assert.equal(this.checked(['volume', 'create', '--label', `${ownerLabel}=${this.state.runId}`,
      '--label', `${purposeLabel}=${purpose}`, name]), name);
    const volume = this.json(['volume', 'inspect', name])[0];
    assert.equal(volume.Name, name);
    assert.equal(volume.Labels?.[ownerLabel], this.state.runId);
    assert.equal(volume.Labels?.[purposeLabel], purpose);
    assert(volume.CreatedAt, 'missing volume creation identity');
    this.state.volumes.push(volumeIdentity(volume));
    this.state.pending = null;
    this.persist();
    return name;
  }
  ownedVolume(name) {
    const expected = this.state.volumes.find((volume) => volume.Name === name);
    assert(expected, `unowned volume: ${name}`);
    same(volumeIdentity(this.json(['volume', 'inspect', name])[0]), expected, 'volume identity drift');
  }
  ownedContainer(identifier) {
    const matches = this.state.containers.filter((container) =>
      [container.Id, container.Name.slice(1)].includes(identifier));
    assert.equal(matches.length, 1, `container is not exactly owned: ${identifier}`);
    const expected = matches[0];
    const actual = this.json(['container', 'inspect', expected.Id])[0];
    same(containerIdentity(actual), expected, 'container identity drift');
    assert.equal(actual.Config.Labels?.[ownerLabel], this.state.runId);
    assert.equal(actual.Config.Labels?.[purposeLabel], purpose);
    for (const mount of actual.Mounts) {
      assert.equal(mount.Type, 'volume', 'unexpected non-volume mount');
      this.ownedVolume(mount.Name);
    }
    return actual;
  }
  runContainer(args) {
    this.reconcile();
    this.checkImages();
    const indexes = args.flatMap((value, index) => Object.values(this.state.images)
      .some((pin) => [pin.selector, pin.id].includes(value)) ? [index] : []);
    assert.equal(indexes.length, 1, 'expected exactly one pinned image operand');
    const index = indexes[0];
    const pin = Object.values(this.state.images).find((image) => [image.selector, image.id].includes(args[index]));
    const options = args.slice(0, index).filter((value) => !['--rm', '-d'].includes(value));
    const command = args.slice(index + 1);
    const detached = args.slice(0, index).includes('-d');
    const interactive = options.includes('-i');
    let name = `${this.state.prefix}-helper-${this.state.containers.length + 1}`;
    if (options.includes('--name')) {
      const nameIndex = options.indexOf('--name');
      name = options[nameIndex + 1];
      assert.equal(name, this.state.container, 'unexpected explicit container name');
      options.splice(nameIndex, 2);
    }
    // Fail closed on new option forms; no host bind, privilege or routing may
    // silently enter the extracted test. Values/scripts after the image remain
    // the unchanged real workflow commands, not mocked native functions.
    const mounted = new Set();
    for (let i = 0; i < options.length; i++) {
      if (options[i] === '-i') continue;
      assert(['--network', '--user', '--entrypoint', '-v', '-e'].includes(options[i]), `unsupported container option: ${options[i]}`);
      const option = options[i], value = options[++i];
      assert.equal(typeof value, 'string', 'missing container option value');
      if (option === '--network') assert.equal(value, 'none');
      if (option === '-v') {
        const parts = value.split(':');
        assert(parts.length === 2 || (parts.length === 3 && parts[2] === 'ro'), 'unsupported volume specification');
        this.ownedVolume(parts[0]);
        assert(parts[1].startsWith('/'), 'volume destination must be absolute');
        mounted.add(parts[1]);
      }
    }
    assert(options.includes('--network') && options[options.indexOf('--network') + 1] === 'none');
    // Explicitly own every image-declared volume; never leave anonymous volumes
    // that docker run --rm would silently discard before evidence inspection.
    for (const destination of Object.keys(pin.identity.Config.Volumes ?? {})) {
      if (!mounted.has(destination)) {
        const extra = this.createVolume(`${this.state.prefix}-implicit-${this.state.volumes.length + 1}`);
        options.push('-v', `${extra}:${destination}`);
      }
    }
    this.namesAbsent('container', name);
    this.state.pending = { kind: 'container', name, image: pin.id };
    this.persist();
    const cid = this.checked(['create', '--pull=never', '--name', name,
      '--label', `${ownerLabel}=${this.state.runId}`, '--label', `${purposeLabel}=${purpose}`,
      ...options, pin.id, ...command]);
    assert.match(cid, fullId, 'missing full create receipt');
    this.state.pending.id = cid;
    this.persist();
    const actual = this.json(['container', 'inspect', cid])[0];
    assert.equal(actual.Id, cid);
    assert.equal(actual.Name, `/${name}`);
    assert.equal(actual.Config.Image, pin.id, 'container did not bind the pinned local image');
    assert.match(actual.Image, immutable, 'missing runtime config ID');
    if (pin.expectedConfigId) assert.equal(actual.Image, pin.expectedConfigId, 'runtime config ID mismatch');
    if (pin.runtimeConfigId) assert.equal(actual.Image, pin.runtimeConfigId, 'runtime config identity drift');
    pin.runtimeConfigId = actual.Image;
    assert.equal(actual.Config.Labels?.[ownerLabel], this.state.runId);
    assert.equal(actual.Config.Labels?.[purposeLabel], purpose);
    for (const mount of actual.Mounts) {
      assert.equal(mount.Type, 'volume');
      this.ownedVolume(mount.Name);
    }
    this.state.containers.push(containerIdentity(actual));
    this.state.pending = null;
    this.persist();
    const input = interactive ? fs.readFileSync(0) : undefined;
    const result = this.raw(['start', ...(!detached ? ['--attach'] : []), ...(interactive ? ['--interactive'] : []), cid], input);
    if (detached) { if (result.status === 0) process.stdout.write(`${cid}\n`); }
    else process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status !== 0 || detached) return result.status;
    const stopped = this.ownedContainer(cid);
    assert.equal(stopped.State.Running, false, 'attached helper is still running');
    return stopped.State.ExitCode;
  }
  proxy(args) {
    this.reconcile();
    if (args[0] === 'run') return this.runContainer(args.slice(1));
    if (args[0] === 'volume') {
      same(args, ['volume', 'create', this.state.volume], 'unexpected volume operation');
      process.stdout.write(`${this.createVolume(this.state.volume)}\n`);
      return 0;
    }
    let actual, operation;
    if (args[0] === 'inspect') {
      assert.equal(args.length, 4);
      same(args.slice(0, 3), ['inspect', '-f', '{{.State.Running}}']);
      actual = this.ownedContainer(args[3]);
      operation = ['inspect', '-f', args[2], actual.Id];
    } else if (args[0] === 'stop') {
      assert.equal(args.length, 4);
      same(args.slice(0, 3), ['stop', '-t', '15']);
      actual = this.ownedContainer(args[3]);
      operation = ['stop', '-t', '15', actual.Id];
    } else if (args[0] === 'start' || args[0] === 'logs' || args[0] === 'exec') {
      if (args[0] !== 'exec') assert.equal(args.length, 2);
      actual = this.ownedContainer(args[1]);
      operation = [args[0], actual.Id, ...args.slice(2)];
    } else throw new Error(`unsupported extracted Docker operation: ${args[0]}`);
    const result = this.raw(operation);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.status;
  }
  diagnostics() {
    this.reconcile();
    for (const expected of this.state.containers) {
      const actual = this.ownedContainer(expected.Id);
      writeExclusive(path.join(this.directory, `${actual.Id}.inspect.json`), `${JSON.stringify(actual, null, 2)}\n`);
      this.raw(['logs', '--timestamps', actual.Id]);
    }
    for (const expected of this.state.volumes) this.ownedVolume(expected.Name);
  }
}

function adapt(original) {
  const changes = [];
  function replace(old, replacement) {
    assert.equal(original.split(old).length, 2, `workflow adaptation is no longer unique: ${old}`);
    original = original.replace(old, replacement);
    changes.push({ old, replacement });
  }
  replace('upgrade_volume=smoke-historical-92-state', 'upgrade_volume="$HISTORICAL_VOLUME"');
  replace('upgrade_container=smoke-historical-92-candidate', 'upgrade_container="$HISTORICAL_CONTAINER"');
  replace('cleanup() {\n  docker rm -f "$upgrade_container" >/dev/null 2>&1 || true\n  docker volume rm "$upgrade_volume" >/dev/null 2>&1 || true\n}\ntrap cleanup EXIT\n',
    '# No workflow cleanup: outer runner retains every owned resource and evidence.\n');
  replace('docker pull "$old_image"\n', '# Outer runner requires the pinned old image to exist locally.\n');
  const operands = original.split('"$DERIVED_IMAGE:smoke"').length - 1;
  assert(operands >= 2, 'missing candidate image operands');
  original = original.replaceAll('"$DERIVED_IMAGE:smoke"', '"$HISTORICAL_CANDIDATE_IMAGE"');
  changes.push({ old: '"$DERIVED_IMAGE:smoke"', replacement: '"$HISTORICAL_CANDIDATE_IMAGE"', count: operands });
  return { shell: original, changes };
}

function main() {
  const env = environment();
  const [image, requestedDirectory, bashOption, expectedOption, ...extra] = process.argv.slice(2);
  assert.match(image ?? '', immutable, 'provide the immutable local image/index ID that actually resolves');
  assert(requestedDirectory, 'provide a new evidence directory; existing directories are never reused');
  assert.equal(extra.length, 0, 'unexpected arguments');
  const requestedBash = bashOption?.match(/^--git-bash=(.+)$/)?.[1];
  assert(requestedBash && path.isAbsolute(requestedBash) && path.parse(requestedBash).root.length > 1,
    'provide --git-bash with a fully qualified Git for Windows bash.exe path; no PATH/WSL alias lookup');
  const expectedConfigId = expectedOption?.match(/^--expected-config-id=(sha256:[a-f0-9]{64})$/)?.[1];
  assert(!expectedOption || expectedConfigId, 'invalid optional expected config ID');
  const workflowPath = path.join(root, '.github/workflows/build-image.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const lines = workflow.replace(/\r\n/g, '\n').split('\n');
  const starts = lines.flatMap((line, index) => line === '      - name: Historical 2026.9.2 same-volume upgrade smoke' ? [index] : []);
  assert.equal(starts.length, 1, 'expected one historical same-volume step');
  let end = starts[0] + 1;
  while (end < lines.length && (!lines[end].trim() || /^ {8,}\S/.test(lines[end]))) end++;
  const step = lines.slice(starts[0], end);
  assert(step.includes("        if: steps.gate.outputs.build == 'true'"), 'historical smoke must gate publication');
  const runIndex = step.indexOf('        run: |');
  assert(runIndex >= 0, 'expected literal historical shell block');
  const body = step.slice(runIndex + 1);
  assert(body.every((line) => !line.trim() || line.startsWith('          ')));
  const original = body.map((line) => line.slice(10)).join('\n').replace(/\n*$/, '\n');
  assert(!original.includes('${{'), 'unresolved Actions interpolation');
  const oldPin = original.match(/^old_image=(ghcr\.io\/thebtf\/openclaw-unraid@sha256:[a-f0-9]{64})$/m)?.[1];
  assert(oldPin, 'missing immutable historical image pin');
  const adapted = adapt(original);
  const bash = fs.realpathSync(requestedBash);
  assert(fs.statSync(bash).isFile() && path.basename(bash).toLowerCase() === 'bash.exe',
    'explicit Git Bash executable is unavailable or is not bash.exe');
  const where = spawnSync('where.exe', ['docker.exe'], { encoding: 'utf8', env });
  assert(!where.error && where.status === 0, 'docker.exe is unavailable; no automatic install');
  const dockerExe = fs.realpathSync(where.stdout.trim().split(/\r?\n/)[0]);
  assert(fs.statSync(dockerExe).isFile());
  const directory = path.join(fs.realpathSync(path.dirname(path.resolve(requestedDirectory))), path.basename(requestedDirectory));
  fs.mkdirSync(directory, { mode: 0o700 });
  const runId = randomUUID().replaceAll('-', '');
  const prefix = `historical-upgrade-${runId}`;
  save(path.join(directory, 'resources.json'), {
    runId, prefix, dockerExe, sequence: 0,
    volume: `${prefix}-state`, container: `${prefix}-candidate`, images: {}, containers: [], volumes: [],
    pending: null, uncertain: false, outcome: 'PREPARING', resourcesRetained: true
  });
  console.log(`Evidence directory: ${directory}`);
  let engine = new Engine(directory);
  try {
    engine.reconcile();
    engine.pinImage('candidate', image, expectedConfigId);
    engine.pinImage('old', oldPin);
    engine.namesAbsent('container', engine.state.container);
    engine.namesAbsent('volume', engine.state.volume);
    writeExclusive(path.join(directory, 'workflow.original.sh'), original);
    save(path.join(directory, 'adaptations.json'), adapted.changes);
    const shell = 'set -euo pipefail\ndocker() { "$HISTORICAL_NODE" "$HISTORICAL_RUNNER" --docker-proxy "$HISTORICAL_RUN_DIR" "$@"; }\n' + adapted.shell;
    const script = path.join(directory, 'historical-step.desktop.sh');
    writeExclusive(script, shell);
    save(path.join(directory, 'source-identity.json'), {
      root, workflowPath, workflowSha256: sha256(workflow),
      originalShellSha256: sha256(original), executedShellSha256: sha256(shell), runnerPath,
      runnerSha256: sha256(fs.readFileSync(runnerPath)), gitBashPath: bash, image, expectedConfigId, oldPin, context, endpoint
    });
    engine.state.outcome = 'RUNNING';
    engine.persist();
    const log = fs.openSync(path.join(directory, 'workflow.log'), 'wx', 0o600);
    let result;
    try {
      result = spawnSync(bash, ['--noprofile', '--norc', script.replaceAll('\\', '/')], {
        cwd: root, stdio: ['ignore', log, log], env: {
          ...env,
          HISTORICAL_NODE: process.execPath.replaceAll('\\', '/'), HISTORICAL_RUNNER: runnerPath.replaceAll('\\', '/'),
          HISTORICAL_RUN_DIR: directory.replaceAll('\\', '/'), HISTORICAL_VOLUME: engine.state.volume,
          HISTORICAL_CONTAINER: engine.state.container, HISTORICAL_CANDIDATE_IMAGE: engine.state.images.candidate.id
        },
      });
    } finally { fs.fsyncSync(log); fs.closeSync(log); }
    // Every proxy reloads/persists the same run. Never overwrite its fresh IDs,
    // pending effect or uncertainty with the pre-workflow in-memory snapshot.
    engine = new Engine(directory);
    engine.state.gateExit = result.status;
    engine.state.signal = result.signal;
    engine.state.outcome = !result.error && result.status === 0 && !result.signal && !engine.state.pending && !engine.state.uncertain
      ? 'PASS_RESOURCES_RETAINED' : 'FAIL_OR_INCOMPLETE_RESOURCES_RETAINED';
    if (result.error || result.signal || result.status === null) engine.state.uncertain = true;
    engine.persist();
    engine.diagnostics();
    console.log(`${engine.state.outcome}; inspect workflow.log and resources.json: ${directory}`);
    return engine.state.outcome === 'PASS_RESOURCES_RETAINED' ? 0 : 1;
  } catch (error) {
    engine = new Engine(directory);
    engine.state.outcome = 'FAIL_OR_INCOMPLETE_RESOURCES_RETAINED';
    engine.state.error = String(error);
    engine.persist();
    // Do not retry effects, stop unknown containers or remove anything. Exact
    // pending names/receipts and already observed full IDs remain in resources.
    engine.event({ event: 'runner-failure', error: String(error) });
    console.error(`${error}\nNo cleanup. Evidence/resources retained: ${directory}`);
    return 1;
  }
}

// Schema-only current-cohort phase: never start a Gateway or dispatch outbox work.
async function currentSchemaCohort(mode) {
  const { DatabaseSync } = await import('node:sqlite');
  const { pathToFileURL } = await import('node:url');
  const state = '/home/node/.openclaw';
  const files = {
    state: { file: `${state}/state/openclaw.sqlite`, tables: ['delivery_queue_entries', 'skill_workshop_changes', 'acp_sessions'] },
    agent: { file: `${state}/agents/main/agent/openclaw-agent.sqlite`, tables: ['session_nodes', 'session_windows', 'transcript_events', 'context_engine_turn_outbox'] },
  };
  const artifactIdentity = (file) => {
    const stat = fs.statSync(file, { bigint: true });
    return {
      dev: String(stat.dev), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs),
      size: Number(stat.size), sha256: sha256(fs.readFileSync(file))
    };
  };
  const snapshot = (file, tables) => {
    const db = new DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      return {
        version: db.prepare('PRAGMA user_version').get().user_version,
        rows: Object.fromEntries(tables.map(table => [table, JSON.parse(JSON.stringify(
          db.prepare(`SELECT rowid AS source_rowid, * FROM "${table}" ORDER BY rowid`).all()))]))
      };
    } finally { db.close(); }
  };
  const originalArtifacts = () => {
    const originals = {};
    for (const name of fs.readdirSync(`${state}/session-sqlite-migration-runs`).filter(name => name.startsWith('session-sqlite-') && name.endsWith('.json'))) {
      const file = `${state}/session-sqlite-migration-runs/${name}`;
      originals[file] = artifactIdentity(file);
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const target of manifest.targets) for (const move of target.completedMoves ?? []) originals[move.archivePath] = artifactIdentity(move.archivePath);
    }
    assert(Object.keys(originals).length >= 3, 'missing original import receipt/transcript/registry');
    return originals;
  };
  if (mode === '--current-schema-seed') {
    fs.mkdirSync(`${state}/agents/main/sessions`, { recursive: true, mode: 0o700 });
    fs.mkdirSync(`${state}/workspace`, { recursive: true, mode: 0o700 });
    const id = '33333333-3333-4333-8333-333333333333';
    const timestamp = '2026-10-01T12:00:00.000Z';
    const sessionKey = 'agent:main:main';
    const entry = {
      sessionId: id, updatedAt: Date.parse(timestamp), sessionStartedAt: Date.parse(timestamp),
      chatType: 'direct', sessionFile: `${state}/agents/main/sessions/${id}.jsonl`
    };
    fs.writeFileSync(`${state}/agents/main/sessions/sessions.json`, JSON.stringify({ [sessionKey]: entry }), { flag: 'wx' });
    const events = [
      { type: 'session', version: 3, id, timestamp, cwd: `${state}/workspace` },
      {
        type: 'message', id: 'current-cohort-user', parentId: null, timestamp,
        message: { role: 'user', content: [{ type: 'text', text: 'Synthetic current-cohort retained bytes — λ' }], timestamp: Date.parse(timestamp) }
      },
    ];
    fs.writeFileSync(entry.sessionFile, events.map(event => JSON.stringify(event)).join('\n') + '\n', { flag: 'wx' });
    fs.writeFileSync(`${state}/openclaw.json`, JSON.stringify({
      gateway: { mode: 'local', auth: { mode: 'token', token: 'synthetic-current-cohort-token' } },
      agents: { ownership: 'explicit', defaults: { systemAgent: { agentId: 'main' } }, entries: { main: { workspace: `${state}/workspace` } } },
      plugins: { enabled: false },
    }), { flag: 'wx' });
    const imported = spawnSync(process.execPath, ['/app/dist/index.js', 'doctor', '--session-sqlite', 'import', '--session-sqlite-all-agents', '--json'], { encoding: 'utf8', env: process.env });
    assert.equal(imported.status, 0, `native current-cohort import failed: ${imported.stderr}\n${imported.stdout}`);
    const shared = new DatabaseSync(files.state.file);
    const agent = new DatabaseSync(files.agent.file);
    try {
      assert.equal(shared.prepare('PRAGMA user_version').get().user_version, 20);
      assert.equal(agent.prepare('PRAGMA user_version').get().user_version, 25);
      const payload = JSON.stringify({ state: 'pending', synthetic: 'retained outbox bytes — λ' });
      for (const rowid of [11, 29]) agent.prepare('INSERT INTO context_engine_turn_outbox(rowid,advancement_key,engine_id,owner_plugin_id,session_id,payload_json,attempt_count,last_attempt_at,last_error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(rowid, `synthetic-advance-${rowid}`, 'synthetic-offline-engine', 'synthetic-owner', id, payload, rowid, 100, 'synthetic-original-error', 200);
      for (const rowid of [7, 19]) shared.prepare('INSERT INTO skill_workshop_changes(rowid,change_id,agent_id,skill_name,action,actor,summary,created_at_ms) VALUES(?,?,?,?,?,?,?,?)')
        .run(rowid, `synthetic-change-${rowid}`, 'main', 'synthetic-skill', 'patch', 'user', 'retained cursor bytes — λ', 200);
      shared.prepare('INSERT INTO acp_sessions(session_key,session_id,backend,agent,runtime_session_name,identity_json,mode,state,last_activity_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(sessionKey, id, 'synthetic-offline', 'main', 'synthetic-runtime', JSON.stringify({ agentSessionId: '\u00a0 synthetic-agent \t', acpxSessionId: '\n synthetic-acpx \u3000' }), 'persistent', 'idle', 200, 200);
      const delivery = {
        id: 'synthetic-retained-delivery', kind: 'message', channel: 'synthetic-offline', to: 'offline-only',
        payload: { text: 'retained delivery bytes — λ' }, completionRetention: { idPrefix: 'synthetic-', maxAgeMs: 60000, maxEntries: 7 }
      };
      shared.prepare('INSERT INTO delivery_queue_entries(queue_name,id,status,entry_kind,channel,target,entry_json,enqueued_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run('synthetic-current-cohort', delivery.id, 'pending', delivery.kind, delivery.channel, delivery.to, JSON.stringify(delivery), 200, 200);
      shared.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      agent.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { shared.close(); agent.close(); }
    const chown = spawnSync('chown', ['-R', '1000:1000', state], { encoding: 'utf8' });
    assert.equal(chown.status, 0, chown.stderr);
    const before = {
      databases: Object.fromEntries(Object.entries(files).map(([kind, { file, tables }]) =>
        [kind, { ...snapshot(file, tables), identity: { dev: String(fs.statSync(file).dev), ino: String(fs.statSync(file).ino) } }])), originals: originalArtifacts()
    };
    process.stdout.write(JSON.stringify(before));
    return;
  }
  assert.equal(mode, '--current-schema-check');
  const before = JSON.parse(fs.readFileSync(0, 'utf8'));
  const contract = JSON.parse(fs.readFileSync('/usr/local/lib/openclaw-unraid-schema-migration.json', 'utf8'));
  assert([[20, 25], [22, 27]].some(([state, agent]) => contract.stateVersion === state && contract.agentVersion === agent));
  const migrated = contract.stateVersion === 22;
  const compare = (actual, expected, label) => {
    assert.equal(actual.length, expected.length, `${label}: row count`);
    const columns = expected.length ? Object.keys(expected[0]) : [];
    assert.deepEqual(actual.map(row => columns.map(column => row[column])), expected.map(row => columns.map(column => row[column])), label);
  };
  for (const [kind, { file, tables }] of Object.entries(files)) {
    const actual = snapshot(file, tables);
    assert.equal(actual.version, kind === 'state' ? contract.stateVersion : contract.agentVersion);
    assert.deepEqual({ dev: String(fs.statSync(file).dev), ino: String(fs.statSync(file).ino) }, before.databases[kind].identity, `${kind} database replaced`);
    assert.equal(fs.statSync(file).uid, 1000);
    for (const table of tables) compare(actual.rows[table], before.databases[kind].rows[table], `${table}: original rows/columns/rowids`);
    if (migrated && kind === 'agent') {
      for (const row of actual.rows.context_engine_turn_outbox) {
        assert.equal(row.enqueue_sequence, row.source_rowid);
        assert.equal(row.payload_state, 'pending');
      }
      for (const row of actual.rows.session_nodes) assert.equal(row.session_started_at, JSON.parse(row.entry_json).sessionStartedAt);
    }
    if (migrated && kind === 'state') {
      for (const row of actual.rows.skill_workshop_changes) assert.equal(row.cursor_id, row.source_rowid);
      assert.equal(actual.rows.acp_sessions[0].resume_agent_session_id, 'synthetic-agent');
      assert.equal(actual.rows.acp_sessions[0].resume_acpx_session_id, 'synthetic-acpx');
      const delivery = actual.rows.delivery_queue_entries[0];
      assert.equal(delivery.retention_id_prefix, 'synthetic-');
      assert.equal(delivery.retention_max_age_ms, 60000);
      assert.equal(delivery.retention_max_entries, 7);
    }
  }
  assert.deepEqual(originalArtifacts(), before.originals, 'original import receipts/archives changed');
  const groups = fs.readdirSync(`${state}/session-sqlite-migration-runs`).filter(name => name.startsWith('startup-migration-') && name.endsWith('.json'));
  assert.equal(groups.length, migrated ? 1 : 0, 'unexpected backup group count or retry-created group');
  for (const name of groups) {
    const manifest = JSON.parse(fs.readFileSync(`${state}/session-sqlite-migration-runs/${name}`, 'utf8'));
    assert.equal(typeof manifest.completedAt, 'string');
    assert.equal(manifest.targets.length, 2);
    assert.equal(new Set(manifest.targets.map(target => target.sqlitePath)).size, 2);
    for (const [kind, { file, tables }] of Object.entries(files)) {
      const target = manifest.targets.find(target => target.sqlitePath === file);
      assert(target, 'backup group omitted database');
      assert.deepEqual(target.databaseIdentity, before.databases[kind].identity);
      assert.equal(target.validationBeforeArchive, 'passed');
      assert.equal(target.completedMoves.length, 1);
      const move = target.completedMoves[0];
      assert.equal(move.kind, 'database-backup');
      assert.equal(move.sourcePath, file);
      assert(move.archivePath.startsWith(`${file}.pre-startup-migration-`) && move.archivePath.endsWith('.bak'));
      assert.deepEqual(artifactIdentity(move.archivePath), move.artifact.identity, 'verified backup artifact changed');
      const backup = snapshot(move.archivePath, tables);
      assert.equal(backup.version, before.databases[kind].version);
      for (const table of tables) assert.deepEqual(backup.rows[table], before.databases[kind].rows[table], `${table}: original backup rows`);
    }
  }
  console.log('CURRENT-COHORT SAME-VOLUME SCHEMA OK: original rows/identities/import artifacts preserved; projections/cursors/outbox sequence and whole-fleet backups verified; no Gateway dispatch');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(runnerPath) && ['--current-schema-seed', '--current-schema-check'].includes(process.argv[2])) {
  currentSchemaCohort(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
} else if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(runnerPath)) {
  try {
    if (process.argv[2] === '--docker-proxy') {
      assert(process.argv[3], 'missing run directory');
      process.exitCode = new Engine(process.argv[3]).proxy(process.argv.slice(4));
    } else process.exitCode = main();
  } catch (error) { console.error(`HISTORICAL RUNNER REFUSAL: ${error}`); process.exitCode = 125; }
}
