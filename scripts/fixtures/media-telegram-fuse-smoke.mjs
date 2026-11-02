import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Container-only: node media-telegram-fuse-smoke.mjs /existing/writable/fuse.
// Use UID 1026:GID 100 in a network namespace containing only loopback, brought
// up by the caller. Never attach production binds, secrets or user state.
// Only Telegram HTTP is simulated. No filesystem/native/handler replacement.
const FUSE_MAGIC = 0x65735546;
const CASE = 'actual-Telegram-remote-PDF-on-real-FUSE';
const STOP = new Error('TELEGRAM_PDF_STOP_BEFORE_DISPATCH');
const SENTINEL_FALLBACK = 'Something went wrong while processing your message. Please try again.';
const abort = new AbortController();
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
const emit = (name, status, detail) => console.log(JSON.stringify({ name, status, ...detail }));
let root;
let rootIdentity;
let server;
let restoreFetch;
let restoreSendMessage;
let restoreRuntime;
let closeState;
let deadline;
let stage = 'preconditions';
let failed = false;
const diagnostics = [];
const warningTexts = [];
let contextMedia;
const calls = { getFile: 0, file: 0, sendMessage: 0, sendChatAction: 0, deleteMyCommands: 0, forbidden: 0 };
let dispatchAttempts = 0;
let contextAttempts = 0;
let verified;
let contextFailure;
let httpFailure;
let blockedHttp = 0;
let stopThrown = false;
let sentinelReported = false;
const messageRequests = [];
const pendingRequests = new Set();
const requestFailures = [];
let processingStop;
let resolveProcessingStop;
const processingStopped = new Promise(resolve => { resolveProcessingStop = resolve; });
function observeProcessingStop(reason) {
  if (processingStop) return;
  processingStop = reason;
  resolveProcessingStop();
}
async function waitForProcessingStop() {
  abort.signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const onAbort = () => reject(abort.signal.reason);
    abort.signal.addEventListener('abort', onAbort, { once: true });
    processingStopped.then(() => {
      abort.signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

// Observe completion without replacing responses or changing returned promises.
// Tracking sendMessage above grammY's throttler includes calls not yet in fetch.
function trackRequest(task, label, onSettled = () => { }) {
  const settled = Promise.resolve(task).then(
    () => { onSettled(); },
    error => { requestFailures.push({ label, message: String(error) }); onSettled(); },
  );
  pendingRequests.add(settled);
  settled.then(() => pendingRequests.delete(settled));
  return task;
}
async function settleRequests() {
  while (pendingRequests.size) await Promise.all([...pendingRequests]);
}

function makePdf() {
  const text = 'BT /F1 12 Tf 72 720 Td (Synthetic Telegram FUSE regression) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  body += `%${'p'.repeat(318000)}\n`;
  const xref = Buffer.byteLength(body);
  return Buffer.from(body + 'xref\n0 6\n0000000000 65535 f \n' +
    offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

// Discover emitted modules, not a particular image version/hash or minifier
// alias. Read only direct regular JS bundles under the installed dist root.
// Use the actual Telegram static dependency graph to distinguish parallel SDK
// bundles. Missing/ambiguous APIs fail closed; never guess a module by ordering.
function installedModules() {
  const dist = '/app/dist';
  const modules = new Map();
  for (const entry of fs.readdirSync(dist, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/\.(?:mjs|js)$/.test(entry.name)) continue;
    const file = path.join(dist, entry.name);
    const source = fs.readFileSync(file, 'utf8');
    const exports = new Map();
    const addExport = (local, alias) => {
      if (!exports.has(local)) exports.set(local, new Set());
      exports.get(local).add(alias);
    };
    for (const match of source.matchAll(/(?:^|\n)export\s*\{([^}]+)\}\s*(?:from\s*["'][^"']+["'])?\s*;?/g)) {
      // Re-export barrels are not implementations of the expected APIs.
      if (/\}\s*from\s/.test(match[0])) continue;
      for (const specifier of match[1].split(',')) {
        const item = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(specifier);
        if (item) addExport(item[1], item[2] ?? item[1]);
      }
    }
    for (const match of source.matchAll(/(?:^|\n)export\s+(?:async\s+)?(?:function|const|let|var)\s+([\w$]+)/g)) addExport(match[1], match[1]);
    const imports = [...source.matchAll(/(?:^|\n)import\s+(?:[^;\n]*?\s+from\s*)?["'](\.[^"']+)["']/g)]
      .map(match => path.resolve(dist, match[1]));
    modules.set(file, { file, exports, imports, sha256: digest(source) });
  }
  const candidates = names => [...modules.values()].filter(module => names.every(name => module.exports.has(name)));
  const exactlyOne = (options, names) => {
    assert.equal(options.length, 1, `expected one installed API bundle for ${names.join(', ')}; found ${JSON.stringify(options.map(module => module.file))}`);
    return options[0];
  };
  const telegram = exactlyOne(candidates(['createTelegramBot']), ['createTelegramBot']);
  const factory = exactlyOne(candidates(['createPluginRuntime']), ['createPluginRuntime']);
  const reachable = new Set();
  const pending = [telegram.file, factory.file];
  while (pending.length) {
    const file = pending.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    pending.push(...(modules.get(file)?.imports ?? []));
  }
  const selected = new Map();
  async function load(names) {
    const options = candidates(names);
    const connected = options.filter(module => reachable.has(module.file));
    const module = exactlyOne(connected.length ? connected : options, names);
    const actual = await import(pathToFileURL(module.file).href);
    const functions = {};
    for (const name of names) {
      const aliases = [...module.exports.get(name)].sort();
      const implementations = aliases.map(alias => {
        assert.equal(typeof actual[alias], 'function', `missing installed callable ${name} (${module.file}, export ${alias})`);
        return actual[alias];
      });
      assert(implementations.every(fn => fn === implementations[0]), `ambiguous installed aliases for ${name} in ${module.file}: ${aliases.join(', ')}`);
      functions[name] = implementations[0];
    }
    selected.set(module.file, { file: module.file, sha256: module.sha256, exports: Object.fromEntries(names.map(name => [name, [...module.exports.get(name)].sort()])) });
    return functions;
  }
  return { load, selected };
}

// Qualify the behavior that triggered the original regression, not just statfs.
function calibrate(pdf) {
  const dir = fs.mkdtempSync(path.join(root, 'calibration-'));
  const source = path.join(dir, 'held-source');
  const target = path.join(dir, 'published-target');
  const fd = fs.openSync(source, 'wx+', 0o600);
  let hidden;
  try {
    fs.writeFileSync(fd, pdf);
    fs.linkSync(source, target);
    fs.unlinkSync(source);
    const held = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(target, { bigint: true });
    assert(sameFile(held, named), 'FUSE calibration lost inode identity');
    assert.equal(named.nlink, 2n, 'FUSE must retain the open-unlinked source link');
    hidden = fs.readdirSync(dir).find(name => name.startsWith('.fuse_hidden') && sameFile(fs.lstatSync(path.join(dir, name), { bigint: true }), held));
    assert(hidden, 'FUSE did not create the deferred-unlink name');
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(fs.lstatSync(target, { bigint: true }).nlink, 1n);
  assert.deepEqual(fs.readdirSync(dir), ['published-target']);
  assert.deepEqual(fs.readFileSync(target), pdf);
  fs.unlinkSync(target);
  fs.rmdirSync(dir);
  emit('real-FUSE-deferred-unlink-calibration', 'PASS', { hiddenNameObserved: true, postUnlinkLinks: 2, afterCloseLinks: 1 });
}

try {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid(), 1026);
  assert.equal(process.getgid(), 100);
  assert(fs.existsSync('/.dockerenv'), 'requires a disposable local Docker container');
  assert.deepEqual(fs.readdirSync('/sys/class/net').sort(), ['lo'], 'only loopback may exist in the test network namespace');
  assert.equal(process.argv.length, 3, 'usage: node media-telegram-fuse-smoke.mjs /existing/writable/fuse');
  assert(path.isAbsolute(process.argv[2]), 'FUSE path must be absolute');
  const base = fs.realpathSync(process.argv[2]);
  assert(base !== '/' && fs.statSync(base).isDirectory(), 'pass an existing FUSE directory');
  assert.equal(fs.statfsSync(base).type, FUSE_MAGIC, 'not a real FUSE filesystem');
  fs.accessSync(base, fs.constants.W_OK | fs.constants.X_OK);
  root = fs.mkdtempSync(path.join(base, 'media-telegram-fuse-'));
  rootIdentity = fs.lstatSync(root, { bigint: true });
  assert.equal(rootIdentity.uid, 1026n);
  assert.equal(fs.statfsSync(root).type, FUSE_MAGIC);
  fs.chmodSync(root, 0o700);

  // Drop inherited application/provider configuration before importing anything
  // shipped. Only process-launch essentials survive; synthetic config is below.
  const launchKeys = new Set(['PATH', 'LANG', 'LC_ALL', 'TZ']);
  for (const key of Object.keys(process.env)) if (!launchKeys.has(key)) delete process.env[key];
  Object.assign(process.env, {
    HOME: root, OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_DIR: root, OPENCLAW_CONFIG_PATH: path.join(root, 'openclaw.json'),
    OPENCLAW_WORKSPACE_DIR: path.join(root, 'workspace'),
    XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, XDG_DATA_HOME: root,
    TMPDIR: root, TMP: root, TEMP: root, OPENCLAW_LOG_LEVEL: 'silent',
  });
  process.chdir(root);
  const pdf = makePdf();
  const maxBytes = 2 * 1024 * 1024;
  calibrate(pdf);
  deadline = setTimeout(() => abort.abort(new Error('Telegram PDF fixture deadline (60 seconds)')), 60000);
  deadline.unref();

  stage = 'synthetic-loopback-Bot-API';
  // Public synthetic identifier; this is never a real credential.
  const token = '123456789:SYNTHETIC_FUSE_REGRESSION_ONLY';
  const senderId = 70001;
  const documentName = 'synthetic-fuse-proof.pdf';
  const remotePath = 'documents/synthetic-fuse-proof.pdf';
  server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.socket.remoteAddress, '127.0.0.1');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === `/file/bot${token}/${remotePath}`) {
        calls.file++;
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length });
        res.end(pdf);
        return;
      }
      const method = url.pathname.startsWith(`/bot${token}/`) ? url.pathname.slice(`/bot${token}/`.length) : '';
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        assert(size < 65536, 'unexpected large Bot API request');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const args = body ? JSON.parse(body) : Object.fromEntries(url.searchParams);
      let result;
      if (method === 'getFile' && args.file_id === 'synthetic-remote-pdf') {
        calls.getFile++;
        result = { file_id: args.file_id, file_unique_id: 'synthetic-unique-pdf', file_size: pdf.length, file_path: remotePath };
      } else if (method === 'deleteMyCommands') {
        calls.deleteMyCommands++;
        result = true;
      } else if (method === 'sendMessage' || method === 'sendChatAction') {
        assert.equal(String(args.chat_id), String(senderId));
        calls[method]++;
        if (method === 'sendMessage') {
          const text = String(args.text ?? '');
          warningTexts.push(text);
          const initiated = messageRequests.find(request => !request.httpObserved && request.text === text);
          assert(initiated, 'sendMessage reached HTTP without an observed API invocation');
          initiated.httpObserved = true;
          // Record a strict test failure, but return the normal synthetic API
          // response so the original warning does not itself alter hydration.
          if (text !== SENTINEL_FALLBACK || !initiated.allowedSentinelFallback) httpFailure ??= new Error(`unexpected Telegram message: ${text}`);
        }
        result = method === 'sendChatAction' ? true : { message_id: 9000 + calls.sendMessage, date: Math.floor(Date.now() / 1000), chat: { id: senderId, type: 'private' }, text: args.text };
      } else {
        calls.forbidden++;
        throw new Error(`unexpected synthetic Bot API method: ${method || req.method}`);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      httpFailure ??= error;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error_code: 500, description: 'synthetic fixture failure' }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const apiRoot = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  const loopbackFetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== apiRoot) {
      blockedHttp++;
      throw new Error('non-fixture HTTP request forbidden');
    }
    return trackRequest(originalFetch(input, init), `HTTP ${url.pathname.replaceAll(token, '<synthetic-token>')}`);
  };
  globalThis.fetch = loopbackFetch;
  restoreFetch = () => { globalThis.fetch = originalFetch; };
  const cfg = {
    agents: { entries: { main: {} }, defaults: { workspace: path.join(root, 'workspace') } },
    commands: { native: false, nativeSkills: false },
    messages: { ackReactionScope: 'off', inbound: { debounceMs: 0 } },
    tools: { media: { audio: { enabled: false }, image: { enabled: false }, video: { enabled: false } } },
    logging: { level: 'silent', consoleLevel: 'silent', file: path.join(root, 'synthetic.log') },
    channels: {
      telegram: {
        enabled: true, botToken: token, apiRoot, dmPolicy: 'allowlist', allowFrom: [String(senderId)],
        commands: { native: false, nativeSkills: false }, historyLimit: 0, dmHistoryLimit: 0,
        network: { dangerouslyAllowPrivateNetwork: true }, threadBindings: { enabled: false },
      }
    },
  };
  fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg), { flag: 'wx', mode: 0o600 });

  stage = 'installed-API-discovery';
  const installed = installedModules();
  const { createTelegramBot } = await installed.load(['createTelegramBot']);
  const { getMediaDir, readMediaBuffer } = await installed.load(['getMediaDir', 'readMediaBuffer']);
  const { withChannelReadAuthority } = await installed.load(['withChannelReadAuthority']);
  const { createEmptyPluginRegistry } = await installed.load(['createEmptyPluginRegistry']);
  const { withPluginRuntimeRegistryScope } = await installed.load(['withPluginRuntimeRegistryScope']);
  const { resolveSelectedPluginCommandRegistry } = await installed.load(['resolveSelectedPluginCommandRegistry']);
  const { createPluginRuntime } = await installed.load(['createPluginRuntime']);
  const { setTelegramRuntime, getOptionalTelegramRuntime } = await installed.load(['setTelegramRuntime', 'getOptionalTelegramRuntime']);
  const { createPluginStateKeyedStore, createPluginStateSyncKeyedStore, closePluginStateDatabaseAsync } = await installed.load(['createPluginStateKeyedStore', 'createPluginStateSyncKeyedStore', 'closePluginStateDatabaseAsync']);
  closeState = closePluginStateDatabaseAsync;
  const requireImage = createRequire('/app/package.json');
  emit('installed-identity', 'INFO', {
    openclaw: requireImage('./package.json').version, uid: process.getuid(), gid: process.getgid(),
    modules: [...installed.selected.values()], payloadBytes: pdf.length, payloadSha256: digest(pdf),
  });
  assert.equal(getMediaDir(), path.join(root, 'media'), 'media store escaped synthetic state');
  const inbound = path.join(root, 'media/inbound');
  fs.mkdirSync(inbound, { recursive: true, mode: 0o700 });
  assert.deepEqual(fs.readdirSync(inbound), []);
  const registry = createEmptyPluginRegistry();
  assert.deepEqual(registry.commands, []);
  assert.deepEqual(registry.plugins, []);
  const withRegistry = run => withPluginRuntimeRegistryScope(registry, () => {
    assert.equal(resolveSelectedPluginCommandRegistry(), registry, 'wrong plugin registry implementation selected');
    return run();
  });
  const prohibitDispatch = () => { dispatchAttempts++; throw new Error('FORBIDDEN_MODEL_OR_DISPATCH_ENTRY'); };
  assert.equal(getOptionalTelegramRuntime(), null, 'refusing to replace an existing Telegram runtime');
  const hostRuntime = createPluginRuntime({ dispatchReplyFromConfig: prohibitDispatch });
  const fixtureEnv = { ...process.env };
  // Same shipped keyed stores and abort authority as the host, explicitly bound
  // to this fixture environment. These are not in-memory/state mocks.
  hostRuntime.state = {
    ...hostRuntime.state,
    openKeyedStore: options => createPluginStateKeyedStore('telegram', { ...options, env: fixtureEnv }, () => abort.signal.throwIfAborted()),
    openSyncKeyedStore: options => createPluginStateSyncKeyedStore('telegram', { ...options, env: fixtureEnv }),
  };
  const stoppedInbound = { ...hostRuntime.channel.inbound, run: prohibitDispatch, runPreparedReply: prohibitDispatch, dispatch: prohibitDispatch, dispatchReply: prohibitDispatch };
  hostRuntime.channel = {
    ...hostRuntime.channel, inbound: stoppedInbound, turn: stoppedInbound,
    reply: { ...hostRuntime.channel.reply, dispatchReplyFromConfig: prohibitDispatch, dispatchReplyWithBufferedBlockDispatcher: prohibitDispatch },
  };
  const forbidden = new Set(['agent', 'llm', 'mediaUnderstanding', 'tts', 'imageGeneration', 'videoGeneration', 'musicGeneration', 'webSearch', 'nodes', 'subagent', 'worktrees', 'system', 'gateway', 'hooks', 'decisions', 'modelAuth']);
  const telegramRuntime = new Proxy(hostRuntime, {
    get(target, property, receiver) {
      if (forbidden.has(property)) return prohibitDispatch();
      return Reflect.get(target, property, receiver);
    },
  });
  setTelegramRuntime(telegramRuntime);
  restoreRuntime = () => setTelegramRuntime(null);
  assert.equal(getOptionalTelegramRuntime(), telegramRuntime);

  stage = 'real-Telegram-bot-construction';
  const bot = await withRegistry(() => createTelegramBot({
    token, config: cfg, accountId: 'default', ownerAgentId: 'main', mediaMaxMb: maxBytes / 1048576,
    botInfo: { id: 123456789, is_bot: true, first_name: 'Synthetic bot', username: 'synthetic_fuse_regression_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false },
    telegramTransport: { fetch: loopbackFetch, sourceFetch: loopbackFetch, dispatcherAttempts: [] },
    fetchAbortSignal: abort.signal, mediaAbortSignal: abort.signal,
    runtime: {
      log() { },
      error: message => {
        const text = String(message);
        diagnostics.push(text);
        if (diagnostics.length > 8) diagnostics.shift();
        // The installed onError logs this deliberate error immediately before
        // initiating its unawaited generic reply. A failed PDF check cannot opt in.
        if (verified && stopThrown && !contextFailure && text.includes('telegram debounce flush failed:') && text.includes(String(STOP))) {
          sentinelReported = true;
          observeProcessingStop('reported-context-sentinel');
        } else if (contextFailure && text.includes('telegram debounce flush failed:') && text.includes(String(contextFailure))) {
          observeProcessingStop('reported-context-failure');
        }
      },
    },
    // Deliberately keep the shipped default Telegram dependencies: authorization,
    // file hydration and handler/storage behavior must not be test substitutes.
    buildContext: async input => {
      contextAttempts++;
      try {
        assert.equal(contextAttempts, 1, 'unexpected extra context');
        assert.equal(input.channel, 'telegram');
        const media = input.media ?? [];
        contextMedia = media.map(item => ({ kind: item.kind ?? null, path: item.path ?? null, contentType: item.contentType ?? null, fileName: item.fileName ?? null }));
        const hydrationDetail = () => JSON.stringify({ media: contextMedia, warningTexts, diagnostics, calls });
        assert.equal(media.length, 1, `real Telegram hydration did not deliver exactly one PDF to the receiving context: ${hydrationDetail()}`);
        const document = media[0];
        assert.equal(typeof document.path, 'string', `PDF has no materialized path at buildContext: ${hydrationDetail()}`);
        assert(document.path.length > 0 && fs.existsSync(document.path), `PDF materialized path is missing at buildContext: ${hydrationDetail()}`);
        assert.equal(document.kind, 'document');
        assert.equal(document.contentType, 'application/pdf');
        assert.equal(document.fileName, documentName);
        assert.equal(path.dirname(document.path), inbound, 'PDF not in fixture inbound');
        assert(document.path.endsWith('.pdf'));
        assert.equal(fs.realpathSync(document.path), document.path, 'PDF path resolved through an alias');
        assert.equal(fs.statfsSync(document.path).type, FUSE_MAGIC);
        const stat = fs.lstatSync(document.path, { bigint: true });
        assert(stat.isFile() && !stat.isSymbolicLink());
        assert.equal(stat.uid, 1026n);
        assert.equal(stat.nlink, 1n);
        assert.equal(Number(stat.size), pdf.length);
        assert.deepEqual(fs.readFileSync(document.path), pdf, 'context cannot read exact PDF bytes');
        const reopened = await readMediaBuffer(path.basename(document.path), 'inbound', maxBytes);
        assert.deepEqual(reopened.buffer, pdf, 'real media-store read rejected or changed the saved PDF');
        assert.equal(calls.getFile, 1);
        assert.equal(calls.file, 1);
        verified = { bytes: pdf.length, sha256: digest(pdf), fileName: document.fileName, contentType: document.contentType, nlink: 1, readableByReceivingContext: true, realStoreReadBeforeSentinel: true };
      } catch (error) {
        contextFailure = error;
        throw error;
      }
      // Never return a context: no real model/session reply can follow this seam.
      stopThrown = true;
      throw STOP;
    },
  }));
  assert.equal(typeof bot.handleUpdate, 'function');
  const originalSendMessage = bot.api.sendMessage;
  bot.api.sendMessage = function(...args) {
    const request = {
      text: String(args[1] ?? ''),
      allowedSentinelFallback: Boolean(verified && stopThrown && sentinelReported && !contextFailure && args[1] === SENTINEL_FALLBACK),
      httpObserved: false,
      settled: false,
    };
    messageRequests.push(request);
    return trackRequest(Reflect.apply(originalSendMessage, this, args), 'Bot API sendMessage', () => { request.settled = true; });
  };
  restoreSendMessage = () => { bot.api.sendMessage = originalSendMessage; };
  stage = CASE;
  const update = {
    update_id: 101,
    message: {
      message_id: 101, date: Math.floor(Date.now() / 1000),
      chat: { id: senderId, type: 'private', first_name: 'Synthetic sender' },
      from: { id: senderId, is_bot: false, first_name: 'Synthetic sender' },
      caption: 'Synthetic Telegram PDF FUSE regression',
      document: { file_id: 'synthetic-remote-pdf', file_unique_id: 'synthetic-unique-pdf', file_name: documentName, mime_type: 'application/pdf', file_size: pdf.length },
    },
  };
  try {
    await withRegistry(() => withChannelReadAuthority(() => abort.signal.throwIfAborted(), () => bot.handleUpdate(update), abort.signal));
  } catch (error) {
    // grammY may report the sentinel through bot.catch or propagate a BotError.
    if (error !== STOP && error.error !== STOP && error.cause !== STOP) {
      observeProcessingStop('propagated-handler-failure');
      throw error;
    }
    observeProcessingStop('propagated-context-sentinel');
  }
  // enqueue may return on admission, before the flush has completed. Observe
  // the actual sentinel/context error reporting (or propagated sentinel) first.
  // The reporter initiates any fallback synchronously after logging; by the
  // continuation below that API call is tracked even if still in the throttler.
  await waitForProcessingStop();
  await settleRequests();
  if (httpFailure) throw httpFailure;
  if (contextFailure) throw contextFailure;
  abort.signal.throwIfAborted();
  assert.equal(calls.getFile, 1, `getFile not reached; diagnostics=${JSON.stringify(diagnostics)}`);
  assert.equal(calls.file, 1, `file download not reached; diagnostics=${JSON.stringify(diagnostics)}`);
  assert.equal(contextAttempts, 1, `buildContext not reached; diagnostics=${JSON.stringify(diagnostics)}`);
  assert(verified, `PDF not saved/read before context stop; diagnostics=${JSON.stringify(diagnostics)}`);
  assert.equal(dispatchAttempts, 0, 'model/dispatch boundary was entered');
  assert.equal(blockedHttp, 0, 'non-fixture HTTP was attempted');
  assert.equal(calls.forbidden, 0);
  assert.equal(requestFailures.length, 0, `synthetic API request failed: ${JSON.stringify(requestFailures)}`);
  assert(messageRequests.every(request => request.allowedSentinelFallback && request.httpObserved && request.settled), `unexpected or unfinished Telegram message: ${JSON.stringify(messageRequests)}`);
  assert.equal(calls.sendMessage, messageRequests.length);
  assert(calls.sendMessage <= 1, 'unexpected repeated sentinel fallback');
  emit(CASE, 'PASS', { ...verified, calls, dispatchAttempts, processingStop, sentinelFallbacks: calls.sendMessage, initiatedRequestsSettled: true, checkedBeforeContextSentinel: true });
} catch (error) {
  failed = true;
  emit(stage, 'FAIL', { code: error.code, message: error.message, diagnostics, warningTexts, contextMedia, calls, contextAttempts, dispatchAttempts, processingStop, messageRequests, requestFailures });
} finally {
  // Keep the abort deadline active until initiated requests have settled.
  try {
    await settleRequests();
    clearTimeout(deadline);
    abort.abort(new Error('fixture teardown'));
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    restoreSendMessage?.();
    restoreFetch?.();
    restoreRuntime?.();
    await closeState?.();
    if (root) {
      process.chdir('/');
      // Delete only the directory created exclusively above, never the mount.
      const current = fs.lstatSync(root, { bigint: true });
      assert(sameFile(current, rootIdentity) && current.isDirectory() && !current.isSymbolicLink(), 'owned root replaced; cleanup refused');
      assert(path.basename(root).startsWith('media-telegram-fuse-'));
      await fsp.rm(root, { recursive: true });
      assert(!fs.existsSync(root), 'fixture-owned root remains');
      emit('cleanup', 'PASS', { ownedRootAbsent: true, callerMountUntouched: true });
    }
  } catch (error) {
    failed = true;
    emit('cleanup', 'FAIL', { message: error.message, retainedOwnedRoot: root });
  }
}
emit('summary', failed ? 'FAIL' : 'PASS', { scenario: CASE, failures: failed ? 1 : 0 });
process.exitCode = failed ? 1 : 0;
