'use strict';
// Test-only observation. No application SQL/source rewriting; one named guard fault.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const mode = process.env.MEMORY_GATEWAY_MODE;
const directory = process.env.MEMORY_GATEWAY_TRACE;
assert(['candidate', 'headroom-fallback', 'upstream-unmodified'].includes(mode));
assert(directory && directory.startsWith('/tmp/memory-gateway-'));
const nativeChild = process.argv.some(arg => /\/extensions\/memory-core\/memory-search-knn\.child\.js$/.test(arg));
const originalRead = fs.readFileSync;
if (nativeChild) {
  const { DatabaseSync } = require('node:sqlite');
  const originalFunction = DatabaseSync.prototype.function;
  const observation = { mode, pid: process.pid, uid: process.getuid(), gid: process.getgid(), registrations: 0, calls: 0, nonNull: 0, null: 0, queryOnly: [], headroomFaultReads: 0, rssPeakAtCallbacksBytes: 0 };
  const persist = () => {
    const usage = process.resourceUsage();
    observation.cpuMicrosAtSnapshot = usage.userCPUTime + usage.systemCPUTime;
    observation.maxRssKiBAtSnapshot = usage.maxRSS;
    observation.rssPeakAtCallbacksBytes = Math.max(observation.rssPeakAtCallbacksBytes, process.memoryUsage().rss);
    fs.writeFileSync(path.join(directory, `trace-${mode}-${process.pid}.json`), JSON.stringify(observation), { mode: 0o600 });
  };
  if (mode === 'headroom-fallback') {
    fs.readFileSync = function(file, ...args) {
      if (file === '/proc/meminfo') {
        observation.headroomFaultReads++;
        const result = 'MemAvailable:          0 kB\n';
        return typeof args[0] === 'string' || args[0]?.encoding ? result : Buffer.from(result);
      }
      return originalRead.call(this, file, ...args);
    };
  }
  DatabaseSync.prototype.function = function(name, options, callback) {
    if (name !== 'openclaw_unraid_shadow_v') return originalFunction.call(this, name, options, callback);
    observation.registrations++;
    const queryOnly = this.prepare('PRAGMA query_only').get().query_only;
    if (!observation.queryOnly.includes(queryOnly)) observation.queryOnly.push(queryOnly);
    persist();
    // Keep arity one: node:sqlite derives the SQL function signature from it.
    return originalFunction.call(this, name, options, function(id) {
      const value = callback.call(this, id);
      observation.calls++;
      if (value == null) observation.null++;
      else {
        assert(value instanceof Uint8Array && value.byteLength === 4096 * 4);
        observation.nonNull++;
      }
      persist();
      return value;
    });
  };
  persist();
  // The parent replaces its data listeners per request. Observe at the child
  // write boundary instead, forwarding every original stdout byte unchanged.
  const originalStdoutWrite = process.stdout.write;
  let pending = '';
  process.stdout.write = function(chunk, encoding, callback) {
    pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    assert(pending.length <= 2 * 1024 * 1024 + 1, 'bounded native reply observation');
    for (; ;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const frame = JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      persist();
      fs.appendFileSync(path.join(directory, `replies-${mode}.jsonl`), JSON.stringify({ pid: process.pid, id: frame.id, status: frame.status, rows: frame.value?.rows?.length, fallbackScanRequired: frame.value?.fallbackScanRequired, unraidShadowFallback: frame.value?.unraidShadowFallback ?? null }) + '\n', { mode: 0o600 });
    }
    return originalStdoutWrite.apply(this, arguments);
  };
  process.on('exit', persist);
  syncBuiltinESMExports();
} else {
  const originalSpawn = cp.spawn;
  cp.spawn = function(command, args, options) {
    if (command !== process.execPath || !Array.isArray(args) || !args.some(arg => /\/extensions\/memory-core\/memory-search-knn\.child\.js$/.test(String(arg)))) {
      return originalSpawn.apply(this, arguments);
    }
    const child = originalSpawn.call(this, command, ['--require', __filename, ...args], {
      ...options,
      env: { ...options?.env, MEMORY_GATEWAY_MODE: mode, MEMORY_GATEWAY_TRACE: directory },
    });
    fs.appendFileSync(path.join(directory, `launches-${mode}.jsonl`), JSON.stringify({ pid: child.pid, argv: args, injectedPreload: __filename }) + '\n', { mode: 0o600 });
    return child;
  };
  syncBuiltinESMExports();
}
