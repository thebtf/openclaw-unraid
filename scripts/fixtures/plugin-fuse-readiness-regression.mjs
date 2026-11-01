import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// 120 s is the upstream model-runtime publication budget, not an override.
// The local FUSE no-selected-plugin baseline was 10.406 s; selected-plugin
// startup stalled ~162 s. This generous gate still rejects that failure.
// Hosted-runner timing is uncalibrated: a control failure is infrastructure/
// fixture failure, not evidence of production causality or the intended RED.
const readinessMs = 120_000;
// Registration is a separate diagnostic observation, never extra time to pass
// readiness. The unmodified FUSE baseline registered only at ~172.8 s; observe
// up to 210 s total before classifying missing registration as UNKNOWN.
const postDeadlineRegistrationMs = 90_000;
const pluginId = 'synthetic-selected-plugin';
const gatewayToken = `synthetic-${randomUUID()}`;
const marker = 'PLUGIN_FUSE_REGISTER ';
const packageName = index => `synthetic-dep-${String(index).padStart(2, '0')}`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const [normalRoot, fuseRoot] = process.argv.slice(2);
const report = {
  readinessMs, postDeadlineRegistrationMs, scenarios: [],
  limits: [
    'Fresh synthetic state; six configured agents are not six retained agent databases or retained-state admission coverage.',
    'Before release, separately run Real FUSE retained-state external plugin entrypoint readiness with synthetic retained databases; this direct-Gateway fixture does not prove that combined path.',
    'Private TMPDIR and XDG_CACHE_HOME are ordinary non-FUSE storage; state and plugin source retain their scenario filesystem.',
  ],
};
let active;
let provider;
let interrupted = false;
const requests = [];
process.once('SIGTERM', () => { interrupted = true; });
process.once('SIGINT', () => { interrupted = true; });

function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
}
function json(file, value) { write(file, JSON.stringify(value, null, 2) + '\n'); }
function inventory(root) {
  const entries = [];
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      assert(stat.isDirectory() || stat.isFile(), `unexpected source entry: ${file}`);
      entries.push({
        path: path.relative(root, file), mode: stat.mode, uid: stat.uid, gid: stat.gid,
        ...(stat.isFile() ? { bytes: stat.size, sha256: digest(fs.readFileSync(file)) } : {})
      });
      if (stat.isDirectory()) visit(file);
    }
  }
  visit(root);
  return entries;
}
function prepare(base, name, selected) {
  const root = path.join(base, name);
  const home = path.join(root, 'home');
  const state = path.join(home, '.openclaw');
  const plugin = path.join(state, 'selected-plugin');
  const ids = ['main', 'agent2', 'agent3', 'agent4', 'agent5', 'agent6'];
  const workspaces = Object.fromEntries(ids.map(id => [id, path.join(state, 'workspaces', id)]));
  for (const workspace of Object.values(workspaces)) fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  json(path.join(plugin, 'package.json'), {
    name: pluginId, version: '1.0.0', type: 'module', main: './dist/index.js',
    dependencies: { [packageName(0)]: '1.0.0', [packageName(1)]: '1.0.0' },
    openclaw: { extensions: ['./dist/index.js'], runtimeExtensions: ['./dist/index.js'] },
  });
  json(path.join(plugin, 'openclaw.plugin.json'), {
    id: pluginId, name: 'Synthetic selected plugin', activation: { onStartup: true },
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  });
  write(path.join(plugin, 'dist/index.js'), `import a from '${packageName(0)}';
import b from '${packageName(1)}';
export default { id: '${pluginId}', name: 'Synthetic selected plugin', register(api) {
  api.logger.info('${marker}'+JSON.stringify({id:'${pluginId}',dependencies:a+b,uid:process.getuid(),gid:process.getgid(),source:import.meta.url}));
} };\n`);
  // Two direct dependencies import and use all 30 transitive packages. This is
  // real built-JS dependency loading, not unused package metadata or sleeps.
  for (let index = 0; index < 32; index++) {
    const deps = index === 0 ? Array.from({ length: 15 }, (_, n) => n + 2)
      : index === 1 ? Array.from({ length: 15 }, (_, n) => n + 17) : [];
    const dir = path.join(plugin, 'node_modules', packageName(index));
    json(path.join(dir, 'package.json'), {
      name: packageName(index), version: '1.0.0', type: 'module', main: './index.js',
      dependencies: Object.fromEntries(deps.map(n => [packageName(n), '1.0.0'])),
    });
    write(path.join(dir, 'index.js'), deps.map(n => `import d${n} from '${packageName(n)}';`).join('\n')
      + `\nexport default ${index + 1}${deps.map(n => '+d' + n).join('')};\n`);
    for (let n = 0; n < 8; n++) {
      write(path.join(dir, 'lib', `module-${n}.js`), `export const fixture = ${JSON.stringify(`synthetic-${index}-${n}-` + 'x'.repeat(2048))};\n`);
      json(path.join(dir, 'data', `asset-${n}.json`), { synthetic: true, package: index, asset: n, padding: 'y'.repeat(2048) });
    }
  }
  const config = {
    gateway: { mode: 'local', bind: 'loopback', port: 18789, auth: { mode: 'token', token: gatewayToken } },
    agents: {
      ownership: 'explicit', defaults: { systemAgent: { agentId: 'main' }, model: { primary: 'synthetic/inert' } },
      entries: Object.fromEntries(Object.entries(workspaces).map(([id, workspace]) => [id, { workspace }]))
    },
    models: {
      mode: 'replace', providers: {
        synthetic: {
          baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'synthetic-not-a-real-secret', api: 'openai-completions',
          models: [{
            id: 'inert', name: 'Synthetic inert', reasoning: false, input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024
          }],
        }
      }
    },
    // Identical allow/source lists prevent bundled auto-selection from making
    // the disabled control a different plugin fleet. Only enabled changes.
    plugins: { allow: [pluginId], slots: { memory: 'none' }, load: { paths: [plugin] }, entries: { [pluginId]: { enabled: selected } } },
  };
  const configPath = path.join(state, 'openclaw.json');
  json(configPath, config);
  // Match overlay-backed /tmp without putting SQLite scratch or caches on
  // the state FUSE mount. These private paths are owned synthetic data only.
  const scratch = path.join(normalRoot, 'process-scratch', name);
  const tmp = path.join(scratch, 'tmp');
  const cache = path.join(scratch, 'cache');
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  assert.notEqual(Number(fs.statfsSync(tmp).type), 0x65735546, 'TMPDIR must not be FUSE');
  assert.notEqual(Number(fs.statfsSync(cache).type), 0x65735546, 'XDG_CACHE_HOME must not be FUSE');
  const stateFsType = Number(fs.statfsSync(state).type);
  const sourceFsType = Number(fs.statfsSync(plugin).type);
  assert.equal(stateFsType, Number(fs.statfsSync(base).type), 'state escaped its scenario filesystem');
  assert.equal(sourceFsType, stateFsType, 'plugin source escaped its state filesystem');
  return {
    name, selected, root, plugin, configPath, configBytes: fs.readFileSync(configPath), source: inventory(plugin),
    env: {
      PATH: process.env.PATH, HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_DIR: state, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_WORKSPACE_DIR: workspaces.main,
      XDG_CACHE_HOME: cache, TMPDIR: tmp, OPENCLAW_GATEWAY_TOKEN: config.gateway.auth.token
    }
  };
}
function launch(fixture) {
  // Use the shipped Gateway, without imports, timeout patches or NODE_OPTIONS.
  // The downstream entrypoint enforces bind=lan and rewrites managed config;
  // direct launch preserves this gate's loopback/config-byte contract. Existing
  // workflow gates still exercise the actual entrypoint and native HEALTHCHECK.
  const child = spawn(process.execPath, ['/app/dist/index.js', 'gateway', '--bind', 'loopback', '--auth', 'token', '--port', '18789'], {
    cwd: '/app', env: fixture.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const run = { child, output: '', registrations: [], partial: ['', ''] };
  const append = (stream, bytes) => {
    const text = bytes.toString();
    run.output = (run.output + text).slice(-65536);
    const lines = (run.partial[stream] + text).split(/\r?\n/);
    run.partial[stream] = lines.pop().slice(-65536);
    for (const line of lines) {
      const index = line.indexOf(marker);
      if (index >= 0) {
        try { run.registrations.push(JSON.parse(line.slice(index + marker.length).replace(/\u001b\[[0-9;]*m/g, ''))); }
        catch { run.markerError = true; }
      }
      if (/Config invalid|SyntaxError|ERR_MODULE_NOT_FOUND|failed to load plugin|error loading plugin/i.test(line)) run.admissionError = true;
    }
  };
  child.stdout.on('data', bytes => append(0, bytes));
  child.stderr.on('data', bytes => append(1, bytes));
  run.closed = new Promise(resolve => {
    child.once('error', error => { run.spawnError = error; resolve(); });
    child.once('close', (code, signal) => { run.exit = { code, signal }; resolve(); });
  });
  return run;
}
function signalGroup(run, signal) {
  if (!run.child.pid) return false;
  try { process.kill(-run.child.pid, signal); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function closeWithin(run, ms) {
  const controller = new AbortController();
  try {
    return await Promise.race([run.closed.then(() => true), delay(ms, false, { signal: controller.signal })]);
  } finally { controller.abort(); }
}
async function stop(run) {
  if (!run) return;
  // Signal the Gateway, not every worker: an orderly PASS requires the
  // Gateway to shut down its own process group without our SIGKILL fallback.
  const gracefulDeadline = performance.now() + 20_000;
  if (run.child.pid && !run.exit) run.child.kill('SIGTERM');
  const closed = await closeWithin(run, 20_000);
  while (signalGroup(run, 0) && performance.now() < gracefulDeadline) await delay(100);
  const groupRemains = signalGroup(run, 0);
  const graceful = closed && !groupRemains;
  const forced = groupRemains ? signalGroup(run, 'SIGKILL') : false;
  assert(await closeWithin(run, 5000), 'Gateway process/stdio did not close after shutdown');
  // tini reaps orphaned workers, including those forcibly stopped on RED.
  for (let n = 0; n < 50 && signalGroup(run, 0); n++) await delay(100);
  assert(!signalGroup(run, 0), 'Gateway process group remains after shutdown');
  const orderly = graceful && !forced && run.exit?.code === 0 && run.exit.signal === null;
  return { orderly, graceful, forced, exit: run.exit };
}
async function exercise(fixture) {
  const result = {
    name: fixture.name, selected: fixture.selected,
    sourceFsType: Number(fs.statfsSync(fixture.plugin).type),
    stateFsType: Number(fs.statfsSync(fixture.env.OPENCLAW_STATE_DIR).type),
    tmpFsType: Number(fs.statfsSync(fixture.env.TMPDIR).type),
    cacheFsType: Number(fs.statfsSync(fixture.env.XDG_CACHE_HOME).type),
    registrations: [], samples: []
  };
  report.scenarios.push(result);
  const started = performance.now();
  active = launch(fixture);
  let readySamples = 0;
  let lastSample;
  while (performance.now() - started < readinessMs) {
    assert(!interrupted, 'observer interrupted');
    assert(!active.spawnError, `Gateway spawn failed: ${active.spawnError?.message}`);
    assert(!active.exit, `Gateway exited before readiness: ${JSON.stringify(active.exit)}`);
    assert.equal(requests.length, 0, 'unexpected synthetic provider request');
    const remaining = readinessMs - (performance.now() - started);
    let sample;
    try {
      const response = await fetch('http://127.0.0.1:18789/readyz', { signal: AbortSignal.timeout(Math.max(1, Math.min(2000, Math.ceil(remaining)))) });
      const body = await response.text();
      sample = { status: response.status, body: body.slice(0, 8192) };
      if (response.status === 200) {
        const readiness = JSON.parse(body);
        assert.equal(readiness.ready, true, 'HTTP 200 did not mean ready');
        assert.equal(readiness.coreReady, true, 'Gateway core is not ready');
        assert.deepEqual(readiness.failing, [], 'Gateway has failing readiness checks');
        if (readiness.agentDatabases !== undefined) assert(Array.isArray(readiness.agentDatabases), 'invalid agentDatabases readiness list');
        // Upstream can return HTTP 200 while database inspection is pending.
        // Keep that response in samples, but never count it as genuine ready.
        readySamples = readiness.agentDatabases === undefined || readiness.agentDatabases.length === 0 ? readySamples + 1 : 0;
      } else readySamples = 0;
    } catch (error) {
      if (error instanceof assert.AssertionError || error instanceof SyntaxError) throw error;
      readySamples = 0;
      sample = { error: error.cause?.code ?? error.name };
    }
    const elapsedMs = Math.round(performance.now() - started);
    const key = JSON.stringify(sample);
    if (key !== lastSample || readySamples > 0) result.samples.push({ elapsedMs, ...sample });
    lastSample = key;
    // Two independent reads reject an isolated early success during sidecars.
    if (readySamples >= 2 && elapsedMs <= readinessMs) { result.readyMs = elapsedMs; break; }
    await delay(Math.min(1000, Math.max(0, readinessMs - (performance.now() - started))));
  }
  if (!result.readyMs && fixture.name === 'fuse-selected-plugin') {
    result.readinessDeadlineMissed = true;
    const registrationDeadline = started + readinessMs + postDeadlineRegistrationMs;
    while (active.registrations.length === 0 && performance.now() < registrationDeadline) {
      assert(!interrupted, 'observer interrupted during post-deadline registration observation');
      assert(!active.spawnError, `Gateway spawn failed: ${active.spawnError?.message}`);
      assert(!active.exit, `Gateway exited during registration observation: ${JSON.stringify(active.exit)}`);
      assert(!active.markerError && !active.admissionError, 'plugin admission/registration error');
      assert.equal(requests.length, 0, 'unexpected synthetic provider request');
      await delay(Math.min(1000, Math.max(0, registrationDeadline - performance.now())));
    }
    result.registrationObservationEndedMs = Math.round(performance.now() - started);
  }
  const registeredBeforeShutdown = active.registrations.length > 0;
  assert(!active.spawnError, `Gateway spawn failed: ${active.spawnError?.message}`);
  assert(!active.exit, `Gateway exited during readiness observation: ${JSON.stringify(active.exit)}`);
  result.shutdown = await stop(active);
  result.registrations = active.registrations;
  result.logTail = active.output;
  assert(!active.markerError, 'malformed plugin registration marker');
  assert(!active.admissionError, 'Gateway plugin admission/configuration error');
  active = undefined;
  if (result.readyMs) assert(result.shutdown.orderly, `ready scenario required non-orderly shutdown: ${JSON.stringify(result.shutdown)}`);
  assert.equal(requests.length, 0, 'unexpected synthetic provider request');
  assert(fs.readFileSync(fixture.configPath).equals(fixture.configBytes), 'Gateway changed original config bytes');
  assert.deepEqual(inventory(fixture.plugin), fixture.source, 'Gateway changed original plugin source bytes/metadata');
  if (fixture.selected) {
    assert(registeredBeforeShutdown, 'UNKNOWN: selected external plugin registration was not observed before the diagnostic bound/shutdown; not a qualified timing RED');
    for (const registration of result.registrations) {
      assert.equal(registration.id, pluginId);
      assert.equal(registration.dependencies, 528, 'all 32 imported packages must be used');
      assert.equal(registration.uid, 1026);
      assert.equal(registration.gid, 100);
      assert.match(registration.source, /^file:\/\//);
    }
  } else assert.equal(result.registrations.length, 0, 'disabled-plugin control executed the plugin');
  if (!result.readyMs) {
    if (fixture.name === 'fuse-selected-plugin') {
      throw Object.assign(new Error(`PLUGIN FUSE READINESS FAIL: selected plugin registered but genuine /readyz was not stable within ${readinessMs}ms; controls passed`), { regression: true });
    }
    throw new Error(`control ${fixture.name} did not reach genuine /readyz within ${readinessMs}ms; not a qualified timing RED`);
  }
  delete result.logTail;
  console.log(`PLUGIN FUSE CONTROL/CASE OK: ${fixture.name} ready=${result.readyMs}ms`);
}

try {
  assert(normalRoot && fuseRoot && process.argv.length === 4, 'expected ordinary and FUSE fixture roots');
  assert.equal(process.getuid(), 1026);
  assert.equal(process.getgid(), 100);
  assert.deepEqual(fs.readdirSync('/sys/class/net').sort(), ['lo'], 'external network interface remains');
  assert.notEqual(Number(fs.statfsSync(normalRoot).type), 0x65735546, 'ordinary control is FUSE');
  assert.equal(Number(fs.statfsSync(fuseRoot).type), 0x65735546, 'real FUSE superblock required');
  report.openclaw = JSON.parse(fs.readFileSync('/app/package.json', 'utf8')).version;
  report.uid = process.getuid(); report.gid = process.getgid();
  provider = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    request.resume();
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end('{"error":{"message":"synthetic provider: model requests forbidden"}}');
  });
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const cases = [prepare(normalRoot, 'ordinary-selected-plugin', true),
  prepare(fuseRoot, 'fuse-disabled-plugin', false), prepare(fuseRoot, 'fuse-selected-plugin', true)];
  assert.deepEqual(cases[0].source, cases[1].source, 'control package trees differ');
  assert.deepEqual(cases[1].source, cases[2].source, 'FUSE package trees differ');
  report.pluginFiles = cases[0].source.filter(entry => entry.sha256).length;
  report.pluginTreeSha256 = digest(JSON.stringify(cases[0].source));
  for (const fixture of cases) await exercise(fixture);
  report.status = 'PASS';
} catch (error) {
  process.exitCode = error.regression ? 1 : 2;
  report.status = error.regression ? 'READINESS_REGRESSION' : 'INFRA_OR_FIXTURE_ERROR';
  report.error = error.message;
  console.error(error.regression ? error.message : `PLUGIN FUSE INFRA ERROR: ${error.stack}`);
} finally {
  try {
    if (active) report.finalShutdown = await stop(active);
    if (provider) await new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); });
    assert.equal(requests.length, 0, 'provider traffic occurred');
    assert(!interrupted, 'observer interrupted');
  } catch (error) {
    process.exitCode = 2; report.status = 'INFRA_OR_FIXTURE_ERROR'; report.cleanupError = error.message;
    console.error(`PLUGIN FUSE INFRA ERROR: ${error.message}`);
  }
  report.providerRequests = requests;
  console.log(JSON.stringify(report));
}
