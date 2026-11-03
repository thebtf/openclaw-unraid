import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Availability and startup completion are different contracts. After a real
// loopback TCP connection, require both two consecutive failed HTTP probes and
// at least 10 s without a complete response, measured from the first failed
// probe's start to the current failed probe's end. Any complete response resets
// that interval; responsive 503 is allowed while startup is still pending.
const responseTimeoutMs = 10_000;
const sustainedResponseFailures = 2;
// This is only a bounded eventual-readiness observation, NOT the upstream
// internal 120 s publication timeout or a universal startup latency guarantee.
const readinessMs = 240_000;
// A separate reload phase never extends any startup or HTTP-response deadline.
const reloadMs = 240_000;
// Full CLI observations are paced separately from the 1 s HTTP sampling loop.
const healthPollIntervalMs = 10_000;
const pluginId = 'synthetic-selected-plugin';
const gatewayToken = `synthetic-${randomUUID()}`;
const marker = 'PLUGIN_FUSE_REGISTER ';
const packageName = index => `synthetic-dep-${String(index).padStart(2, '0')}`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const [normalRoot, fuseRoot] = process.argv.slice(2);
const report = {
  responseTimeoutMs, sustainedResponseFailures, readinessMs, reloadMs, scenarios: [],
  limits: [
    'Fresh synthetic state; six configured agents are not six retained agent databases or retained-state admission coverage.',
    'Before release, separately run Real FUSE retained-state external plugin entrypoint readiness with synthetic retained databases; this direct-Gateway fixture does not prove that combined path.',
    'Private TMPDIR and XDG_CACHE_HOME are ordinary non-FUSE storage; state and plugin source retain their scenario filesystem.',
    'Selected-configuration FUSE HTTP unresponsiveness is an availability observation, not proof that the selected plugin caused it; registration may remain unknown on failure.',
    'Reload covers one successful selected-plugin generation on FUSE; failed-reload recovery remains a separate scenario.',
    'Startup also requires public health modelRuntime completion: degraded false, no pending agents and no stage; HTTP 200 alone is not settlement proof.',
  ],
};
let active;
let activeCli;
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
  const run = { child, output: '', registrations: [], runtimeFailures: [], partial: ['', ''] };
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
      if (/Config invalid|SyntaxError|ERR_MODULE_NOT_FOUND|failed to load plugin|error loading plugin|\[plugins\][^\r\n]*\bfailed during load\b/i.test(line)) run.admissionError = true;
      if (/prepared model runtime publication[^\r\n]*timed out|prepared model runtime startup degraded|background model runtime publication failed|agent database remains degraded|main-session startup orphan marking failed|state.database[^\r\n]*(?:failed|unavailable)/i.test(line)) {
        run.runtimeFailures.push(line);
      }
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
async function stopCli(run) {
  if (!run) return;
  clearTimeout(run.timer);
  // Bound CLI cleanup independently; preserve the Gateway shutdown allowance.
  if (signalGroup(run, 0)) signalGroup(run, 'SIGTERM');
  await closeWithin(run, 1000);
  if (signalGroup(run, 0)) signalGroup(run, 'SIGKILL');
  assert(await closeWithin(run, 1000), 'local CLI process/stdio did not close');
  for (let n = 0; n < 10 && signalGroup(run, 0); n++) await delay(50);
  assert(!signalGroup(run, 0), 'local CLI process group remains after cleanup');
}
function launchCli(fixture, args) {
  const child = spawn(process.execPath, ['/app/dist/index.js', ...args], {
    cwd: '/app', env: fixture.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const run = { child, stdout: '', stderr: '' };
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => {
    const text = run[stream] + bytes.toString();
    if (text.length > 65536) run.outputOverflow = true;
    run[stream] = text.slice(-65536);
  });
  run.closed = new Promise(resolve => {
    child.once('error', error => { run.spawnError = error; resolve(); });
    child.once('close', (code, signal) => { run.exit = { code, signal }; resolve(); });
  });
  return run;
}
function launchPublicationHealth(fixture, publication, started, deadline) {
  const remainingMs = Math.max(1, Math.floor(deadline - performance.now()));
  // Public RPC with empty params: inspect health without channel probes. Use
  // the same synthetic environment/token; keep HTTP observation independent.
  const args = ['gateway', 'call', 'health', '--json', '--params', '{}', '--timeout', String(remainingMs)];
  const cli = activeCli = launchCli(fixture, args);
  cli.observation = { beganMs: Math.round(performance.now() - started), state: 'OBSERVING', args };
  publication.observations.push(cli.observation);
  cli.timer = setTimeout(() => {
    if (cli.exit || cli.spawnError) return;
    cli.timedOut = true;
    signalGroup(cli, 'SIGKILL');
  }, remainingMs);
  return cli;
}
function recordPublicationCli(cli, started) {
  Object.assign(cli.observation, {
    elapsedMs: Math.round(performance.now() - started),
    cli: {
      pid: cli.child.pid, exit: cli.exit, timedOut: cli.timedOut === true,
      spawnError: cli.spawnError?.message, stdoutBytes: Buffer.byteLength(cli.stdout),
      stdout: ['COMPLETE', 'INCOMPLETE', 'DEGRADED'].includes(cli.observation.state) ? undefined : cli.stdout,
      stderr: cli.stderr
    },
  });
}
async function collectPublicationHealth(cli, publication, started) {
  const observation = cli.observation;
  observation.state = 'OBSERVATION_FAILED';
  try {
    assert(!cli.spawnError, `health CLI spawn failed: ${cli.spawnError?.message}`);
    assert(!cli.outputOverflow, 'health CLI exceeded bounded output capture');
    if (cli.timedOut) {
      // This is observer-owned deadline cancellation, not a new Gateway
      // publication state or evidence that an earlier health reply failed.
      observation.state = 'CANCELLED_AT_STARTUP_DEADLINE';
      return;
    }
    assert.deepEqual(cli.exit, { code: 0, signal: null }, `health CLI failed: ${cli.stderr}`);
    observation.state = 'UNSUPPORTED';
    const response = JSON.parse(cli.stdout);
    assert(response && typeof response === 'object' && !Array.isArray(response), 'health RPC did not return an object');
    const status = observation.modelRuntime = response.modelRuntime;
    assert(status && typeof status === 'object' && !Array.isArray(status), 'health RPC omitted modelRuntime startup status');
    assert.equal(typeof status.degraded, 'boolean', 'ambiguous modelRuntime degraded status');
    assert(Array.isArray(status.pendingAgents) && status.pendingAgents.every(id => typeof id === 'string' && id.length > 0), 'ambiguous modelRuntime pendingAgents');
    assert(Object.keys(status).every(key => ['degraded', 'pendingAgents', 'stage'].includes(key)), 'unsupported modelRuntime startup status fields');
    const hasStage = Object.hasOwn(status, 'stage');
    if (hasStage) assert(typeof status.stage === 'string' && status.stage.length > 0, 'ambiguous modelRuntime startup stage');
    // In the audited owner, update() always has a stage, even with zero pending
    // agents. Only complete() publishes nondegraded + empty pending + no stage.
    observation.state = status.degraded ? 'DEGRADED' : hasStage || status.pendingAgents.length ? 'INCOMPLETE' : 'COMPLETE';
    publication.state = observation.state;
    if (observation.state === 'COMPLETE') publication.completedMs = Math.round(performance.now() - started);
  } catch (error) {
    observation.error = error.message;
    publication.observationFailure = { state: observation.state, error: observation.error };
    throw Object.assign(new Error(`UNKNOWN: prepared-model health ${observation.state}: ${error.message}`), { unknown: true });
  } finally {
    try { await stopCli(cli); }
    finally { recordPublicationCli(cli, started); }
    activeCli = undefined;
  }
}
// Fresh connections expose an accepting-but-blocked listener even before its
// first HTTP success. TCP refusal before first connect remains startup/UNKNOWN.
function probeGateway(onConnected) {
  return new Promise(resolve => {
    const began = performance.now();
    let connected = false;
    let settled = false;
    let responseTimer;
    let connectTimer;
    let fixtureError;
    const finish = sample => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      resolve({ ...sample, ...(fixtureError ? { fixtureError } : {}), connected, durationMs: Math.round(performance.now() - began) });
    };
    const request = http.request({ host: '127.0.0.1', port: 18789, path: '/readyz', method: 'GET', agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 65536) {
          fixtureError = 'oversized readiness response';
          request.destroy(new Error(fixtureError));
        }
      });
      response.once('end', () => finish(response.complete ? { kind: 'response', status: response.statusCode, body } : { kind: 'response-failure', error: 'INCOMPLETE_HTTP_RESPONSE' }));
      response.once('error', error => finish({ kind: 'response-failure', error: error.code ?? error.message }));
      response.once('aborted', () => finish({ kind: 'response-failure', error: 'RESPONSE_ABORTED' }));
    });
    request.once('socket', socket => {
      if (!(socket instanceof net.Socket)) {
        fixtureError = 'expected actual loopback TCP socket';
        request.destroy(new Error(fixtureError));
        return;
      }
      socket.once('connect', () => {
        connected = true;
        clearTimeout(connectTimer);
        onConnected();
        // An absolute complete-response deadline, not an idle-socket timeout.
        responseTimer = setTimeout(() => request.destroy(Object.assign(new Error('complete HTTP response deadline exceeded'), { code: 'HTTP_RESPONSE_TIMEOUT' })), responseTimeoutMs);
      });
    });
    request.once('error', error => finish({ kind: connected ? 'response-failure' : 'connect-failure', error: error.code ?? error.message }));
    connectTimer = setTimeout(() => request.destroy(Object.assign(new Error('loopback TCP connect deadline exceeded'), { code: 'TCP_CONNECT_TIMEOUT' })), 1000);
    request.end();
  });
}
function validateRegistration(registration) {
  assert.equal(registration.id, pluginId);
  assert.equal(registration.dependencies, 528, 'all 32 imported packages must be used');
  assert.equal(registration.uid, 1026);
  assert.equal(registration.gid, 100);
  assert.match(registration.source, /^file:\/\//);
}
async function exerciseReload(fixture, result) {
  assert(result.readyMs, 'reload requires genuine startup readiness');
  assert(active.registrations.length > 0, 'reload requires startup registration');
  for (const registration of active.registrations) validateRegistration(registration);
  const started = performance.now();
  const deadline = started + reloadMs;
  const gateway = active;
  const phase = result.reload = {
    gatewayPidBefore: gateway.child.pid, registrationCountBefore: gateway.registrations.length,
    samples: [], registrations: [],
  };
  const cli = activeCli = launchCli(fixture, ['plugins', 'reload', pluginId, '--json']);
  // The official non-wait RPC may wait 600 s. Bound this child even while
  // the observer is awaiting an outstanding 10 s HTTP response.
  const cliTimer = setTimeout(() => {
    cli.timedOut = true;
    signalGroup(cli, 'SIGKILL');
  }, Math.max(0, deadline - performance.now()));
  let readySamples = 0;
  let consecutiveFailures = 0;
  let firstFailedProbeStartedAt;
  let lastSample;
  try {
    while (true) {
      assert(!interrupted, 'observer interrupted during reload');
      if (cli.timedOut) throw Object.assign(new Error(`UNKNOWN: reload CLI exceeded its separate ${reloadMs}ms deadline`), { unknown: true });
      assert(!cli.spawnError, `reload CLI spawn failed: ${cli.spawnError?.message}`);
      assert(!cli.outputOverflow, 'reload CLI exceeded bounded output capture');
      assert.equal(active, gateway, 'reload replaced the observed Gateway');
      assert.equal(gateway.child.pid, phase.gatewayPidBefore, 'reload changed the Gateway PID');
      assert(gateway.child.exitCode === null && gateway.child.signalCode === null && !gateway.exit, 'Gateway exited during reload');
      process.kill(gateway.child.pid, 0);
      assert(!gateway.markerError, 'malformed plugin registration marker during reload');
      assert(!gateway.admissionError && gateway.runtimeFailures.length === 0, 'Gateway reported runtime/admission failure during reload');
      assert.equal(requests.length, 0, 'unexpected synthetic provider request during reload');
      if (cli.exit) {
        assert.deepEqual(cli.exit, { code: 0, signal: null }, `reload CLI failed: ${cli.stderr}`);
        if (!phase.response) {
          phase.response = JSON.parse(cli.stdout);
          assert(phase.response && typeof phase.response === 'object' && !Array.isArray(phase.response), 'reload CLI response must be an object');
          assert(phase.response.runtime && typeof phase.response.runtime === 'object', 'reload CLI omitted structured runtime receipt');
          const runtime = phase.response.runtime;
          assert(Number.isSafeInteger(runtime.generation) && runtime.generation >= 0, 'reload CLI omitted a valid runtime generation');
          assert(runtime.selectedEntries && typeof runtime.selectedEntries === 'object' && !Array.isArray(runtime.selectedEntries), 'reload CLI omitted the selected-entry map');
          assert(Object.hasOwn(runtime.selectedEntries, pluginId), 'reload CLI omitted the selected plugin entry');
          assert.equal(typeof runtime.selectedEntries[pluginId], 'string', 'selected plugin entry must be a source path');
          assert(path.isAbsolute(runtime.selectedEntries[pluginId]), 'selected plugin entry must be an absolute source path');
          assert(Array.isArray(runtime.pluginIds) && runtime.pluginIds.includes(pluginId), 'reload receipt omitted the affected plugin');
          assert.notEqual(runtime.restartRequired, true, 'reload receipt requires a restart instead of a live reload');
          assert.notEqual(phase.response.restartRequired, true, 'reload response requires a restart instead of a live reload');
        }
      }
      if (performance.now() >= deadline) throw Object.assign(new Error(`UNKNOWN: reload did not complete CLI receipt, renewed registration and readiness within its separate ${reloadMs}ms bound`), { unknown: true });
      const probeStartedAt = performance.now();
      const sample = await probeGateway(() => { });
      const probeEndedAt = performance.now();
      const elapsedMs = Math.round(probeEndedAt - started);
      const key = JSON.stringify({ ...sample, durationMs: undefined });
      if (key !== lastSample || sample.kind === 'response') phase.samples.push({ probeStartedMs: Math.round(probeStartedAt - started), elapsedMs, ...sample });
      lastSample = key;
      assert(!sample.fixtureError, sample.fixtureError);
      if (sample.kind === 'response') {
        consecutiveFailures = 0;
        firstFailedProbeStartedAt = undefined;
        assert(sample.status === 200 || sample.status === 503, `unexpected reload readiness HTTP status ${sample.status}`);
        const readiness = JSON.parse(sample.body);
        if (readiness.agentDatabases !== undefined) assert(Array.isArray(readiness.agentDatabases), 'invalid post-reload agentDatabases readiness list');
        assert(!readiness.stateDatabase && !readiness.agentDatabases?.some(refusal => refusal.code !== 'agent-database-inspection-pending') &&
          !readiness.failing?.some(reason => reason === 'state-database' || reason === 'internal' || reason.startsWith('agent-database:')), 'post-reload readiness reported an actual runtime failure');
        if (sample.status === 200) {
          assert.equal(readiness.ready, true, 'post-reload HTTP 200 did not mean ready');
          if (Object.hasOwn(readiness, 'coreReady')) assert.equal(readiness.coreReady, true, 'post-reload Gateway core is not ready');
          assert.deepEqual(readiness.failing, [], 'post-reload HTTP 200 contains failing readiness checks');
        }
        // Count only probes started after the complete successful CLI receipt,
        // not healthy responses sampled while replacement is still in flight.
        const fullyReady = phase.response && gateway.registrations.length > phase.registrationCountBefore &&
          sample.status === 200 && (readiness.agentDatabases === undefined || readiness.agentDatabases.length === 0);
        readySamples = fullyReady ? readySamples + 1 : 0;
        if (readySamples >= 2 && performance.now() <= deadline) {
          phase.readyMs = elapsedMs;
          break;
        }
      } else {
        readySamples = 0;
        // TCP acceptance was already proved by startup. Refusal now counts too.
        firstFailedProbeStartedAt ??= probeStartedAt;
        consecutiveFailures++;
        const noCompleteResponseMs = probeEndedAt - firstFailedProbeStartedAt;
        if (consecutiveFailures >= sustainedResponseFailures && noCompleteResponseMs >= responseTimeoutMs) {
          phase.availabilityFailure = {
            detectedMs: elapsedMs, consecutiveFailures, lastError: sample.error, responseTimeoutMs,
            noCompleteResponseStartedMs: Math.round(firstFailedProbeStartedAt - started),
            noCompleteResponseEndedMs: elapsedMs, noCompleteResponseMs: Math.round(noCompleteResponseMs),
          };
          throw new Error('Gateway HTTP unresponsiveness during selected-plugin reload on FUSE; startup controls passed; cause not established');
        }
      }
      await delay(1000);
    }
    phase.registrations = gateway.registrations.slice(phase.registrationCountBefore);
    assert(phase.registrations.length > 0, 'reload did not renew Gateway plugin registration');
    for (const registration of phase.registrations) validateRegistration(registration);
    phase.gatewayPidAfter = gateway.child.pid;
    assert(gateway.child.exitCode === null && gateway.child.signalCode === null && !gateway.exit, 'Gateway exited after reload readiness');
    process.kill(gateway.child.pid, 0);
  } catch (error) {
    phase.error = error.message;
    if (!error.unknown && !interrupted && !cli.spawnError) Object.assign(error, { regression: true, failureKind: 'PLUGIN_RELOAD_FAILURE' });
    throw error;
  } finally {
    clearTimeout(cliTimer);
    phase.elapsedMs = Math.round(performance.now() - started);
    phase.cli = { pid: cli.child.pid, exit: cli.exit, stdout: cli.stdout, stderr: cli.stderr };
    phase.registrations = gateway.registrations.slice(phase.registrationCountBefore);
    await stopCli(cli);
    phase.cli.exit = cli.exit;
    activeCli = undefined;
  }
}
async function exercise(fixture) {
  const result = {
    name: fixture.name, selected: fixture.selected,
    sourceFsType: Number(fs.statfsSync(fixture.plugin).type),
    stateFsType: Number(fs.statfsSync(fixture.env.OPENCLAW_STATE_DIR).type),
    tmpFsType: Number(fs.statfsSync(fixture.env.TMPDIR).type),
    cacheFsType: Number(fs.statfsSync(fixture.env.XDG_CACHE_HOME).type),
    registrations: [], samples: [], runtimeFailures: []
  };
  report.scenarios.push(result);
  const started = performance.now();
  const readinessDeadline = started + readinessMs;
  const publication = result.publication = { state: 'NOT_OBSERVED', pollIntervalMs: healthPollIntervalMs, observations: [] };
  let healthCli;
  let publicationError;
  let nextHealthObservationAt = started;
  active = launch(fixture);
  let readySamples = 0;
  let consecutiveFailures = 0;
  let firstFailedProbeStartedAt;
  let lastSample;
  while (true) {
    assert(!interrupted, 'observer interrupted');
    assert(!active.spawnError, `Gateway spawn failed: ${active.spawnError?.message}`);
    assert(!active.exit, `Gateway exited during observation: ${JSON.stringify(active.exit)}`);
    assert.equal(requests.length, 0, 'unexpected synthetic provider request');
    if (healthCli && (healthCli.exit || healthCli.spawnError || healthCli.timedOut)) {
      try { await collectPublicationHealth(healthCli, publication, started); }
      catch (error) {
        if (!error.unknown) throw error;
        publicationError = error;
      }
      healthCli = undefined;
      if (publicationError) break;
    }
    if (result.availabilityFailure || performance.now() >= readinessDeadline) break;
    const probeStartedAt = performance.now();
    const sample = await probeGateway(() => {
      result.firstTcpConnectedMs ??= Math.round(performance.now() - started);
    });
    const probeEndedAt = performance.now();
    const elapsedMs = Math.round(probeEndedAt - started);
    const key = JSON.stringify({ ...sample, durationMs: undefined });
    if (key !== lastSample || sample.kind === 'response') result.samples.push({ probeStartedMs: Math.round(probeStartedAt - started), elapsedMs, ...sample });
    lastSample = key;
    assert(!sample.fixtureError, sample.fixtureError);
    if (sample.kind === 'response') {
      consecutiveFailures = 0;
      firstFailedProbeStartedAt = undefined;
      assert(sample.status === 200 || sample.status === 503, `unexpected readiness HTTP status ${sample.status}`);
      const readiness = JSON.parse(sample.body);
      if (readiness.agentDatabases !== undefined) assert(Array.isArray(readiness.agentDatabases), 'invalid agentDatabases readiness list');
      if (readiness.stateDatabase || readiness.agentDatabases?.some(refusal => refusal.code !== 'agent-database-inspection-pending') ||
        readiness.failing?.some(reason => reason === 'state-database' || reason === 'internal' || reason.startsWith('agent-database:'))) {
        result.runtimeFailures.push({ elapsedMs, readiness });
      }
      if (sample.status === 200) {
        assert.equal(readiness.ready, true, 'HTTP 200 did not mean ready');
        if (Object.hasOwn(readiness, 'coreReady')) assert.equal(readiness.coreReady, true, 'Gateway core is not ready');
        assert.deepEqual(readiness.failing, [], 'HTTP 200 contains failing readiness checks');
      }
      const fullyReady = sample.status === 200 && (readiness.agentDatabases === undefined || readiness.agentDatabases.length === 0);
      readySamples = fullyReady ? readySamples + 1 : 0;
      if (!result.availabilityFailure && readySamples >= 2 && performance.now() <= readinessDeadline &&
        (!fixture.selected || active.registrations.length > 0)) {
        if (publication.state === 'COMPLETE') {
          result.readyMs = elapsedMs;
          break;
        }
        const now = performance.now();
        // Do not churn full CLI processes per HTTP sample or start one in the
        // last polling window with no useful remaining observation budget.
        if (!healthCli && now >= nextHealthObservationAt && readinessDeadline - now >= healthPollIntervalMs) {
          healthCli = launchPublicationHealth(fixture, publication, started, readinessDeadline);
          nextHealthObservationAt = performance.now() + healthPollIntervalMs;
        }
      }
    } else {
      readySamples = 0;
      if (result.firstTcpConnectedMs !== undefined) {
        firstFailedProbeStartedAt ??= probeStartedAt;
        consecutiveFailures++;
        const noCompleteResponseMs = probeEndedAt - firstFailedProbeStartedAt;
        if (!result.availabilityFailure && consecutiveFailures >= sustainedResponseFailures && noCompleteResponseMs >= responseTimeoutMs) {
          result.availabilityFailure = {
            detectedMs: elapsedMs, consecutiveFailures, lastError: sample.error, responseTimeoutMs,
            // Monotonic offsets from scenario spawn; retain the failed-probe
            // interval, not time since startup or the last successful response.
            noCompleteResponseStartedMs: Math.round(firstFailedProbeStartedAt - started),
            noCompleteResponseEndedMs: elapsedMs,
            noCompleteResponseMs: Math.round(noCompleteResponseMs),
          };
        }
      }
    }
    // Stop on directly observed availability or runtime failure. Registration
    // is mandatory for PASS, not for reporting an accepting-but-blocked server.
    if (result.availabilityFailure || active.runtimeFailures.length || active.admissionError || result.runtimeFailures.length) break;
    await delay(1000);
  }
  if (healthCli) {
    // An earlier availability/runtime failure or the original startup bound
    // can cancel an in-flight observation; retain it, never call it a success.
    healthCli.observation.state = 'CANCELLED_BEFORE_STARTUP_EXIT';
    try { await stopCli(healthCli); }
    finally { recordPublicationCli(healthCli, started); }
    activeCli = undefined;
  }
  if (!result.readyMs && !publicationError && publication.state === 'DEGRADED') {
    result.runtimeFailures.push({ kind: 'prepared-model-publication-degraded', observations: publication.observations.length });
  }
  if (!result.readyMs && !publicationError) publicationError = Object.assign(new Error(`UNKNOWN: prepared-model publication did not complete within the unchanged ${readinessMs}ms startup bound; last health state ${publication.state}`), { unknown: true });
  result.observationEndedMs = Math.round(performance.now() - started);
  // Establish startup failures before the reload can change process state.
  assert(!active.spawnError, `Gateway spawn failed: ${active.spawnError?.message}`);
  assert(!active.exit, `Gateway exited during observation: ${JSON.stringify(active.exit)}`);
  const startupRuntimeFailureCount = result.runtimeFailures.length + active.runtimeFailures.length + (active.admissionError ? 1 : 0);
  let reloadError;
  // Both startup controls have already passed. Never reload an unready case,
  // or let the extra phase hide the original startup failure classification.
  if (fixture.name === 'fuse-selected-plugin' && result.readyMs && !result.availabilityFailure &&
    !result.runtimeFailures.length && !active.runtimeFailures.length && !active.admissionError && !active.markerError) {
    try { await exerciseReload(fixture, result); }
    catch (error) { reloadError = error; }
  }
  const registeredBeforeShutdown = active.registrations.length > 0;
  // A captured reload failure must survive to classification after evidence,
  // cleanup and integrity checks; an exited Gateway can be its direct symptom.
  if (!reloadError) {
    assert(!active.spawnError, `Gateway spawn failed: ${active.spawnError?.message}`);
    assert(!active.exit, `Gateway exited during observation: ${JSON.stringify(active.exit)}`);
  }
  result.gatewayBeforeShutdown = {
    pid: active.child.pid, exitCode: active.child.exitCode,
    signalCode: active.child.signalCode, exit: active.exit ?? null,
  };
  // Snapshot observations before requesting SIGTERM. Later log messages may
  // follow from shutdown (or delayed delivery); do not call them prior faults.
  result.registrations = active.registrations.slice();
  result.pluginRegistration = fixture.selected ? (registeredBeforeShutdown ? 'OBSERVED_BEFORE_SHUTDOWN' : 'UNKNOWN_BEFORE_SHUTDOWN') : 'NOT_SELECTED';
  result.runtimeFailures.push(...active.runtimeFailures);
  if (active.admissionError) result.runtimeFailures.push({ kind: 'plugin-admission-or-configuration-error', observed: 'before-shutdown' });
  const priorRuntimeFailureCount = active.runtimeFailures.length;
  const priorRegistrationCount = active.registrations.length;
  const priorAdmissionError = active.admissionError;
  const priorMarkerError = active.markerError;
  result.preShutdownLogTail = active.output;
  result.shutdownRequestedMs = Math.round(performance.now() - started);
  result.shutdown = await stop(active);
  result.shutdownObservations = {
    scope: 'Observed after SIGTERM request; not evidence of a preexisting startup fault or of shutdown causality.',
    runtimeMessages: active.runtimeFailures.slice(priorRuntimeFailureCount),
    registrations: active.registrations.slice(priorRegistrationCount),
    newAdmissionError: !priorAdmissionError && active.admissionError === true,
    newMalformedMarker: !priorMarkerError && active.markerError === true,
  };
  result.logTail = active.output;
  assert(!priorMarkerError, 'malformed plugin registration marker before shutdown');
  active = undefined;
  assert.equal(requests.length, 0, 'unexpected synthetic provider request');
  assert(fs.readFileSync(fixture.configPath).equals(fixture.configBytes), 'Gateway changed original config bytes');
  assert.deepEqual(inventory(fixture.plugin), fixture.source, 'Gateway changed original plugin source bytes/metadata');
  if (fixture.selected) {
    for (const registration of result.registrations) validateRegistration(registration);
  } else assert.equal(result.registrations.length, 0, 'disabled-plugin control executed the plugin');
  if (result.availabilityFailure) {
    assert(fixture.name === 'fuse-selected-plugin', `control ${fixture.name} was unresponsive; not a qualified selected-plugin RED`);
    const registration = registeredBeforeShutdown ? 'observed before shutdown' : 'unknown before shutdown';
    throw Object.assign(new Error(`PLUGIN FUSE HTTP UNRESPONSIVENESS FAIL: selected configuration on FUSE; plugin registration ${registration}; ${sustainedResponseFailures} or more consecutive failed probes and ${result.availabilityFailure.noCompleteResponseMs}ms without a complete HTTP response after TCP connect; controls passed; cause not established`), { regression: true, failureKind: 'HTTP_UNRESPONSIVENESS_REGRESSION' });
  }
  // Startup faults retain precedence. Runtime messages first seen during a
  // failed reload stay in the evidence without replacing its captured error.
  if (startupRuntimeFailureCount || (!reloadError && result.runtimeFailures.length)) {
    assert(fixture.name === 'fuse-selected-plugin', `control ${fixture.name} reported an actual runtime failure; selected-configuration regression not established`);
    throw Object.assign(new Error(`PLUGIN FUSE GATEWAY RUNTIME FAIL: ${fixture.name} reported actual state/admission/startup-worker failure`), { regression: true, failureKind: 'GATEWAY_RUNTIME_FAILURE' });
  }
  if (fixture.selected && !registeredBeforeShutdown) throw Object.assign(new Error('UNKNOWN: selected plugin registration was not observed before shutdown; PASS is not established'), { unknown: true });
  if (publicationError) throw publicationError;
  if (!result.readyMs) throw Object.assign(new Error(`UNKNOWN: ${fixture.name} did not complete genuine readiness within the ${readinessMs}ms observation bound; this is not the internal publication timeout`), { unknown: true });
  if (reloadError) throw reloadError;
  if (fixture.name === 'fuse-selected-plugin') assert(result.reload?.readyMs, 'selected FUSE scenario did not complete reload coverage');
  assert(result.shutdown.orderly, `ready scenario required non-orderly shutdown: ${JSON.stringify(result.shutdown)}`);
  delete result.logTail;
  delete result.preShutdownLogTail;
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
  report.status = error.regression ? error.failureKind : error.unknown ? 'UNVERIFIED' : 'INFRA_OR_FIXTURE_ERROR';
  report.error = error.message;
  console.error(error.regression ? error.message : error.unknown ? `PLUGIN FUSE UNVERIFIED: ${error.message}` : `PLUGIN FUSE INFRA ERROR: ${error.stack}`);
} finally {
  try {
    try { if (activeCli) await stopCli(activeCli); }
    finally { if (active) report.finalShutdown = await stop(active); }
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
