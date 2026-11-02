// Real Gateway memory_search release gate; generated inputs and loopback-only providers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire('/app/package.json');
const { DatabaseSync } = require('node:sqlite');
const vec = require('sqlite-vec');
const directory = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {
  schema: 'openclaw-gateway-memory-proof/1', status: 'FAIL', scenarios: [],
  limits: [
    'Prepared post-hoc consumer proof; not test-first evidence.',
    'Real shipped Gateway HTTP /tools/invoke and memory_search; no agent/model turn.',
    'Generated 32-file native index and loopback fake embedding transport; not user data or real provider quality.',
    'Sequential single-agent requests, not a parent-scheduler concurrency stress test.',
    'headroom-fallback injects only MemAvailable=0 in native children; not actual OOM or kernel pressure.',
    'Observer adds child preload argv and counters, not application SQL or source changes; timing includes observation overhead.',
    'RSS is sampled; child CPU/resource snapshots may precede final work when native children are SIGKILL-retired.',
    'Bypasses Unraid bootstrap to isolate Gateway consumer; no bootstrap, production, Watchtower, FUSE or release claim.',
  ],
};
let root;
let gateway;
let fake;
let adapterExpected = false;
let modes = [];
const ownedProcesses = new Set();
const tails = new Map();
const bounded = (old, chunk, maximum = 32768) => (old + chunk.toString('utf8')).slice(-maximum);
const processResults = new WeakMap();
function launch(args, env, name) {
  const child = spawn(process.execPath, args, { env, cwd: '/app', stdio: ['ignore', 'pipe', 'pipe'] });
  ownedProcesses.add(child);
  tails.set(child, { name, stdout: '', stderr: '' });
  child.stdout.on('data', value => { tails.get(child).stdout = bounded(tails.get(child).stdout, value); });
  child.stderr.on('data', value => { tails.get(child).stderr = bounded(tails.get(child).stderr, value); });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { ownedProcesses.delete(child); resolve({ code, signal }); });
  });
  // Keep a rejected spawn observable without an unhandled rejection before await.
  completion.catch(() => { });
  processResults.set(child, completion);
  return child;
}
async function waitProcess(child, timeoutMs) {
  let timer;
  try {
    return await Promise.race([processResults.get(child), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${tails.get(child).name} deadline ${timeoutMs}ms`)), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
async function stopProcess(child) {
  if (!child || !ownedProcesses.has(child)) return;
  child.kill('SIGTERM');
  try { await waitProcess(child, 15000); }
  catch (error) {
    child.kill('SIGKILL');
    await waitProcess(child, 5000);
    throw new Error(`${tails.get(child).name} required forced termination: ${error.message}`);
  }
}
function nativeIndexSnapshot(home, queryVectors, adapterExpected) {
  const found = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      assert(!entry.isSymbolicLink(), 'synthetic state traversal must not follow symlinks');
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith('.sqlite')) found.push(full);
    }
  };
  visit(path.join(home, '.openclaw'));
  const indexes = [];
  for (const file of found) {
    const db = new DatabaseSync(file, { readOnly: true, allowExtension: true });
    try {
      vec.load(db);
      db.exec('PRAGMA query_only=ON; BEGIN DEFERRED');
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_index_chunks_vec'").get()) continue;
      const digest = createHash('sha256');
      const rows = db.prepare('SELECT id,path,start_line,end_line,text,source,model,hex(embedding) AS embedding FROM memory_index_chunks ORDER BY id').all();
      digest.update(JSON.stringify(rows));
      let blocks = null;
      if (adapterExpected) {
        blocks = 0;
        for (const row of db.prepare('SELECT _rowid_ AS rid, rowid, vectors FROM memory_index_chunks_vec_vector_chunks00 ORDER BY _rowid_').iterate()) {
          digest.update(JSON.stringify([row.rid, row.rowid]));
          digest.update(row.vectors);
          blocks++;
        }
        for (const table of ['memory_index_chunks_vec_rowids', 'memory_index_chunks_vec_chunks']) {
          for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY 1`).iterate()) {
            for (const value of Object.values(row)) digest.update(value instanceof Uint8Array ? value : JSON.stringify(value));
          }
        }
      } else {
        // Native-only checks do not assume the audited internal block layout.
        for (const row of db.prepare('SELECT id, embedding FROM memory_index_chunks_vec ORDER BY id').iterate()) {
          digest.update(JSON.stringify(row.id));
          digest.update(row.embedding);
        }
      }
      const oracle = Object.fromEntries(Object.entries(queryVectors).map(([query, vector]) => [query, db.prepare('SELECT c.path, c.id, vec_distance_cosine(v.embedding, ?) AS dist FROM memory_index_chunks_vec v CROSS JOIN memory_index_chunks c ON c.id=v.id WHERE c.source=\'memory\' ORDER BY dist,c.id LIMIT 4').all(Buffer.from(Float32Array.from(vector).buffer))]));
      indexes.push({ path: path.relative(home, file), rows: rows.length, models: [...new Set(rows.map(row => row.model))], blocks, digest: digest.digest('hex'), oracle });
    } finally { try { db.exec('ROLLBACK'); } finally { db.close(); } }
  }
  assert.equal(indexes.length, 1, 'exactly one synthetic native vector index required');
  assert.equal(indexes[0].rows, 32, 'native indexing must include every generated file exactly once');
  assert.equal(indexes[0].models.length, 1);
  return indexes[0];
}
function traceFiles(trace, mode) {
  const names = fs.readdirSync(trace);
  const traces = names.filter(name => name.startsWith(`trace-${mode}-`)).map(name => JSON.parse(fs.readFileSync(path.join(trace, name), 'utf8')));
  const lines = prefix => {
    const file = path.join(trace, `${prefix}-${mode}.jsonl`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  return { traces, launches: lines('launches'), replies: lines('replies') };
}
function resultPayload(body) {
  assert.equal(body.ok, true, JSON.stringify(body));
  const result = body.result;
  if (result?.details && Array.isArray(result.details.results)) return result.details;
  const entries = result?.content?.filter(entry => entry.type === 'text') ?? [];
  assert.equal(entries.length, 1, 'native jsonResult must contain one JSON text payload');
  const parsed = JSON.parse(entries[0].text);
  assert(Array.isArray(parsed.results), 'memory_search response must contain actual results');
  return parsed;
}
function normalizeResult(result) {
  assert.equal(typeof result.path, 'string');
  assert.equal(typeof result.snippet, 'string');
  assert(Number.isFinite(result.score));
  return { path: result.path, startLine: result.startLine, endLine: result.endLine, snippet: result.snippet, source: result.source, score: result.score };
}
try {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert.equal(process.getuid(), 1000);
  assert.equal(process.getgid(), 1000);
  assert.deepEqual(fs.readdirSync('/sys/class/net').sort(), ['lo']);
  const version = require('/app/package.json').version;
  assert.equal(typeof version, 'string');
  const provenance = JSON.parse(fs.readFileSync('/usr/local/lib/openclaw-unraid-memory-knn-projection.json', 'utf8'));
  assert(['patched', 'upstream-unmodified'].includes(provenance.mode));
  adapterExpected = provenance.mode === 'patched';
  assert.equal(provenance.repairApplied, adapterExpected);
  assert.equal(provenance.upstreamVersion, version);
  assert.equal(provenance.helperSha256, hash(fs.readFileSync('/usr/local/lib/openclaw-memory-knn-shadow.mjs')));
  assert(Array.isArray(provenance.modules));
  if (adapterExpected) assert.equal(provenance.modules.length, 3);
  for (const module of provenance.modules) {
    assert(module.path.startsWith('/app/dist/'));
    assert.equal(hash(fs.readFileSync(module.path)), adapterExpected ? module.patchedSha256 : module.sourceSha256);
    if (!adapterExpected) assert(!Object.hasOwn(module, 'patchedSha256'));
  }
  modes = adapterExpected ? ['candidate', 'headroom-fallback'] : ['upstream-unmodified'];
  report.identity = { version, uid: process.getuid(), gid: process.getgid(), interfaces: ['lo'], provenance, node: process.version };
  report.optimizationCoverage = adapterExpected ? 'Audited adapter plus actual headroom-guard fallback required' : 'Not applied: unchanged native Gateway search only; no optimization or injected fallback claim';
  root = fs.mkdtempSync('/tmp/memory-gateway-');
  const home = path.join(root, 'home');
  const state = path.join(home, '.openclaw');
  const workspace = path.join(state, 'workspace');
  const trace = path.join(root, 'trace');
  fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(trace, { mode: 0o700 });
  const sourceHashes = {};
  for (const family of ['alpha', 'beta']) {
    for (let rank = 0; rank < 16; rank++) {
      const id = `${family}-${String(rank).padStart(2, '0')}`;
      const content = `# Generated fixture ${id}\nFAMILY=${family.toUpperCase()} RANK=${String(rank).padStart(2, '0')}\nThis is generated synthetic recall evidence, not a user document. Unique payload ${id}.\n`;
      fs.writeFileSync(path.join(workspace, 'memory', `${id}.md`), content, { flag: 'wx', mode: 0o600 });
      sourceHashes[`memory/${id}.md`] = hash(content);
    }
  }
  const queries = { 'question-zircon': [1, ...Array(4095).fill(0)], 'question-obsidian': [0, 1, ...Array(4094).fill(0)] };
  const fakeCounts = { requests: 0, documents: 0, queries: {}, probes: 0, rejected: 0 };
  const fakeErrors = [];
  fake = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/embeddings', 'no chat, model, batch or alternate endpoint is permitted');
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; assert(bytes <= 1024 * 1024); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(input.model, 'synthetic-memory-4096');
      const values = typeof input.input === 'string' ? [input.input] : input.input;
      assert(Array.isArray(values) && values.length > 0 && values.length <= 256);
      const data = values.map((text, index) => {
        assert.equal(typeof text, 'string');
        assert(text.length <= 8192);
        const match = /FAMILY=(ALPHA|BETA) RANK=(\d{2})/.exec(text);
        let embedding;
        if (Object.hasOwn(queries, text)) {
          fakeCounts.queries[text] = (fakeCounts.queries[text] ?? 0) + 1;
          embedding = queries[text];
        } else if (match) {
          fakeCounts.documents++;
          const angle = 0.05 + Number(match[2]) * 0.025;
          embedding = Array(4096).fill(0);
          embedding[match[1] === 'ALPHA' ? 0 : 1] = Math.cos(angle);
          embedding[2] = Math.sin(angle);
        } else {
          fakeCounts.probes++;
          embedding = [0, 0, 1, ...Array(4093).fill(0)];
        }
        return { object: 'embedding', index, embedding };
      });
      fakeCounts.requests++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', model: input.model, data, usage: { prompt_tokens: values.length, total_tokens: values.length } }));
    } catch (error) {
      fakeCounts.rejected++;
      fakeErrors.push(error.message);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'synthetic transport refused request' } }));
    }
  });
  await new Promise((resolve, reject) => { fake.once('error', reject); fake.listen(0, '127.0.0.1', resolve); });
  const embeddingUrl = `http://127.0.0.1:${fake.address().port}/v1`;
  const gatewayToken = `synthetic-${randomUUID()}`;
  const configPath = path.join(state, 'openclaw.json');
  const config = {
    gateway: { mode: 'local', bind: 'loopback', port: 18789, auth: { mode: 'token', token: gatewayToken } },
    agents: { entries: { main: { workspace } } },
    tools: { allow: ['memory_search'] },
    plugins: { allow: ['memory-core', 'openai'], slots: { memory: 'memory-core' }, entries: { 'memory-core': { enabled: true, config: { dreaming: { enabled: false } } }, openai: { enabled: true } } },
    memory: { citations: 'off', search: { enabled: true, rememberAcrossConversations: false, sources: ['memory'], provider: 'openai', model: 'synthetic-memory-4096', outputDimensionality: 4096, fallback: 'none', remote: { baseUrl: embeddingUrl, apiKey: 'synthetic-no-real-credential', batch: { enabled: false } }, store: { vector: { enabled: true } }, cache: { enabled: false }, query: { maxResults: 4, minScore: 0 } } },
  };
  fs.writeFileSync(configPath, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
  const env = {
    PATH: process.env.PATH, HOME: home, OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_DIR: state, OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_WORKSPACE_DIR: workspace, XDG_CACHE_HOME: path.join(root, 'cache'),
    TMPDIR: root, NODE_NO_WARNINGS: '1', OPENCLAW_GATEWAY_TOKEN: gatewayToken,
  };
  report.fixture = { generatedFiles: 32, dimensions: 4096, fakeEmbeddingUrl: embeddingUrl, sources: sourceHashes, queryStringsDoNotAppearInDocuments: true, realCredentials: false };
  // The shipped validator owns the audited contract and provenance schema.
  const provenanceCheck = launch(['/usr/local/lib/build-openclaw-memory-knn-projection.mjs', '--runtime-status', '/usr/local/lib/openclaw-unraid-memory-knn-projection.json'], env, 'memory-provenance');
  const provenanceResult = await waitProcess(provenanceCheck, 10000);
  report.provenanceCheck = { ...provenanceResult, output: tails.get(provenanceCheck) };
  assert.equal(provenanceResult.code, 0, 'image-owned memory provenance validation failed');
  const indexStarted = performance.now();
  const indexing = launch(['/app/dist/index.js', 'memory', 'index', '--agent', 'main', '--force'], env, 'native-index');
  const indexed = await waitProcess(indexing, 180000);
  report.indexing = { ...indexed, elapsedMs: performance.now() - indexStarted, output: tails.get(indexing), fake: structuredClone(fakeCounts) };
  assert.equal(indexed.code, 0, 'native synthetic index creation failed');
  assert(fakeCounts.documents >= 32, 'every generated document must pass native indexing and fake transport');
  const before = nativeIndexSnapshot(home, queries, adapterExpected);
  report.before = before;
  const outputs = {};
  for (const mode of modes) {
    const launchedAt = performance.now();
    gateway = launch(['/app/dist/index.js', 'gateway', '--bind', 'loopback', '--auth', 'token', '--port', '18789'], {
      ...env, NODE_OPTIONS: `--require=${directory}/memory-gateway-observer.cjs`, MEMORY_GATEWAY_MODE: mode, MEMORY_GATEWAY_TRACE: trace,
    }, `gateway-${mode}`);
    const samples = { gatewayRssPeakSampledBytes: null, cgroupMemoryPeakSampledBytes: null, samples: 0 };
    const sample = () => {
      try {
        const status = fs.readFileSync(`/proc/${gateway.pid}/status`, 'utf8');
        const rss = status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1];
        if (rss !== undefined) samples.gatewayRssPeakSampledBytes = Math.max(samples.gatewayRssPeakSampledBytes ?? 0, Number(rss) * 1024);
        if (fs.existsSync('/sys/fs/cgroup/memory.current')) {
          const current = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
          if (Number.isFinite(current)) samples.cgroupMemoryPeakSampledBytes = Math.max(samples.cgroupMemoryPeakSampledBytes ?? 0, current);
        }
        samples.samples++;
      } catch { /* Process lifetime races are not a zero-memory observation. */ }
    };
    const interval = setInterval(sample, 250);
    try {
      let ready = false;
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        assert(ownedProcesses.has(gateway), 'Gateway exited before readiness');
        try {
          const response = await fetch('http://127.0.0.1:18789/readyz', { signal: AbortSignal.timeout(2000) });
          if (response.status === 200) { ready = true; break; }
        } catch { /* Bounded startup observation, never a fabricated ready result. */ }
        await delay(1000);
      }
      assert(ready, 'actual Gateway /readyz did not become ready');
      const startupMs = performance.now() - launchedAt;
      const unauthorized = await fetch('http://127.0.0.1:18789/tools/invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'memory_search', args: { query: 'question-zircon', maxResults: 4, corpus: 'memory' }, sessionKey: 'agent:main:main' }), signal: AbortSignal.timeout(5000) });
      assert.equal(unauthorized.status, 401, 'Gateway must enforce bearer authentication');
      outputs[mode] = {};
      for (const [query, expectedPrefix] of [['question-zircon', 'alpha'], ['question-obsidian', 'beta']]) {
        const started = performance.now();
        const response = await fetch('http://127.0.0.1:18789/tools/invoke', {
          method: 'POST', headers: { authorization: `Bearer ${gatewayToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ tool: 'memory_search', args: { query, maxResults: 4, minScore: 0, corpus: 'memory' }, sessionKey: 'agent:main:main' }),
          signal: AbortSignal.timeout(30000),
        });
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        const payload = resultPayload(body);
        assert.notEqual(payload.disabled, true);
        assert.notEqual(payload.unavailable, true);
        assert.notEqual(payload.partial, true);
        assert.notEqual(payload.stale, true);
        assert.equal(payload.provider, 'openai');
        assert.equal(payload.model, 'synthetic-memory-4096');
        assert.equal(payload.results.length, 4);
        const rows = payload.results.map(normalizeResult);
        assert.deepEqual(rows.map(row => row.path), Array.from({ length: 4 }, (_, rank) => `memory/${expectedPrefix}-${String(rank).padStart(2, '0')}.md`));
        assert.deepEqual(rows.map(row => row.path), before.oracle[query].map(row => row.path));
        for (const row of rows) { assert.equal(row.source, 'memory'); assert(row.snippet.includes(`FAMILY=${expectedPrefix.toUpperCase()}`)); }
        outputs[mode][query] = { elapsedMs: performance.now() - started, result: payload, rows };
      }
      assert.notDeepEqual(outputs[mode]['question-zircon'].rows.map(row => row.path), outputs[mode]['question-obsidian'].rows.map(row => row.path), 'different queries must change observed Gateway results');
      sample();
      const observations = traceFiles(trace, mode);
      if (adapterExpected) {
        assert(observations.launches.length > 0 && observations.traces.length > 0, 'actual Gateway must launch and use the native sqlite-vec child');
        assert(observations.launches.length <= 2, 'bounded single-agent scenario must not accumulate native children');
        assert(observations.replies.length >= 2);
        for (const child of observations.traces) {
          assert.equal(child.uid, 1000); assert.equal(child.gid, 1000);
          assert(child.registrations > 0 && child.calls > 0);
          assert.deepEqual(child.queryOnly, [1]);
          if (mode === 'candidate') { assert.equal(child.nonNull, child.calls); assert.equal(child.null, 0); assert.equal(child.headroomFaultReads, 0); }
          else { assert.equal(child.nonNull, 0); assert.equal(child.null, child.calls); assert(child.headroomFaultReads > 0); }
        }
        for (const reply of observations.replies) {
          assert.equal(reply.status, 'ok'); assert.equal(reply.fallbackScanRequired, false); assert(reply.rows > 0);
          assert.equal(reply.unraidShadowFallback, mode === 'candidate' ? null : 'native-v');
        }
      } else {
        // Native results and the public-vector oracle remain mandatory.
        // A future upstream may move the worker; no adapter activity is claimed.
        for (const child of observations.traces) {
          assert.equal(child.registrations, 0); assert.equal(child.calls, 0);
          assert.equal(child.headroomFaultReads, 0);
        }
        for (const reply of observations.replies) assert.equal(reply.unraidShadowFallback, null);
      }
      report.scenarios.push({ mode, startupMs, unauthorizedStatus: unauthorized.status, outputs: outputs[mode], observations, resources: samples, status: 'PASS' });
    } finally {
      clearInterval(interval);
      await stopProcess(gateway);
      report.gatewayLogs ??= {};
      report.gatewayLogs[mode] = tails.get(gateway);
      gateway = undefined;
    }
    const afterMode = nativeIndexSnapshot(home, queries, adapterExpected);
    assert.equal(afterMode.digest, before.digest, 'Gateway search or fallback changed indexed source/vector bytes');
    report.scenarios.at(-1).indexDigestAfter = afterMode.digest;
  }
  if (adapterExpected) {
    for (const query of Object.keys(queries)) {
      const candidate = outputs.candidate[query].rows;
      const fallback = outputs['headroom-fallback'][query].rows;
      assert.deepEqual(candidate.map(({ score, ...row }) => row), fallback.map(({ score, ...row }) => row));
      for (let i = 0; i < candidate.length; i++) assert(Math.abs(candidate[i].score - fallback[i].score) <= 1e-7);
      assert(fakeCounts.queries[query] >= 2, 'both real Gateway variants must request the synthetic query embedding');
    }
  } else {
    for (const query of Object.keys(queries)) assert(fakeCounts.queries[query] >= 1, 'native Gateway must use the synthetic query embedding');
  }
  assert.equal(fakeCounts.rejected, 0, JSON.stringify(fakeErrors));
  for (const [name, expected] of Object.entries(sourceHashes)) assert.equal(hash(fs.readFileSync(path.join(workspace, name))), expected);
  report.equivalence = { adapterFallbackCompared: adapterExpected, identicalOrderedPathsSnippetsLinesSources: adapterExpected ? true : null, scoreTolerance: adapterExpected ? 1e-7 : null, independentOracle: 'unchanged native virtual v.embedding cosine SQL', sourceAndIndexPreserved: true };
  report.fakeTransport = { ...fakeCounts, errors: fakeErrors, noRealProviderCalls: true };
  report.status = 'PASS';
} catch (error) {
  report.error = { name: error.name, message: error.message, stack: error.stack?.split('\n').slice(0, 8).join('\n') };
  if (report.identity?.provenance.mode === 'upstream-unmodified') report.unresolvedContract = `UNRESOLVED_UPSTREAM_MEMORY_CONSUMER_CONTRACT: ${error.message}`;
  report.processLogs = [...tails.values()];
  if (root) {
    const trace = path.join(root, 'trace');
    if (fs.existsSync(trace)) report.partialObservations = Object.fromEntries(modes.map(mode => [mode, traceFiles(trace, mode)]));
  }
  process.exitCode = 1;
} finally {
  const errors = [];
  for (const child of [...ownedProcesses]) {
    try { await stopProcess(child); } catch (error) { errors.push(error.message); }
  }
  if (fake) {
    fake.closeAllConnections();
    await new Promise(resolve => fake.close(resolve));
  }
  if (root && errors.length === 0) {
    assert(path.dirname(root) === '/tmp' && /^memory-gateway-[A-Za-z0-9]+$/.test(path.basename(root)));
    fs.rmSync(root, { recursive: true, force: false });
  }
  report.cleanup = { ownedProcessesRemaining: ownedProcesses.size, syntheticRootAbsent: root ? !fs.existsSync(root) : true, errors };
  if (errors.length || ownedProcesses.size || !report.cleanup.syntheticRootAbsent) { report.status = 'FAIL'; process.exitCode = 1; }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}