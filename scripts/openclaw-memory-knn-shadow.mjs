/** Image-owned sqlite-vec ABI adapter. Never reads canonical c.embedding or writes state. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SHADOW_CONTRACT = Object.freeze({
  repair: "sqlite-vec-authoritative-shadow-projection",
  extensionVersion: "v0.1.9",
  extensionSha256: "5923730861b86c707cca5602b5f91092f9e52a46706dbc6e269fd4bb9c4498e8",
  schemaSha256: "9d9db4794b8eed070d926798a0bc1433446ee497c261a7e9debb1a27e8e16d5a",
  dimensions: 4096,
  slots: 1024,
});
const MIB = 1024 * 1024;
const CACHE_CAP = 256 * MIB;
const RSS_CAP = 448 * MIB;
const CHILD_OVERHEAD = 192 * MIB;
const SYSTEM_RESERVE = 256 * MIB;
const MAX_CHILDREN = 2;
const TABLE = "memory_index_chunks_vec";
const contexts = new WeakMap();

class IncompatibleShadow extends Error { }

function incompatible() {
  throw new IncompatibleShadow();
}


function optionalText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return undefined; }
}

function memoryNumber(raw, unlimited = false) {
  const text = raw?.trim();
  if (unlimited && text === "max") return Infinity;
  if (!text || !/^\d+$/.test(text)) return undefined;
  const integer = BigInt(text);
  if (unlimited && integer >= (1n << 60n)) return Infinity;
  return integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : undefined;
}

function decodeMount(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function cgroupHeadroom() {
  const memberships = optionalText("/proc/self/cgroup")?.trim().split("\n");
  const mounts = optionalText("/proc/self/mountinfo")?.trim().split("\n");
  if (!memberships || !mounts) return undefined;
  for (const v2 of [true, false]) {
    const membership = memberships.map((line) => line.split(":")).find((parts) => v2 ? parts[0] === "0" && parts[1] === "" : parts[1]?.split(",").includes("memory"));
    if (!membership) continue;
    const mount = mounts.map((line) => line.split(" - ")).find((parts) => {
      const fields = parts[1]?.split(" ");
      return v2 ? fields?.[0] === "cgroup2" : fields?.[0] === "cgroup" && fields[2]?.split(",").includes("memory");
    });
    if (!mount) return undefined;
    const fields = mount[0].split(" ");
    const root = decodeMount(fields[3]);
    const mountPoint = decodeMount(fields[4]);
    const memberPath = membership.slice(2).join(":");
    if (memberPath !== root && !memberPath.startsWith(root === "/" ? "/" : `${root}/`)) return undefined;
    let directory = path.posix.join(mountPoint, path.posix.relative(root, memberPath));
    if (directory !== mountPoint && !directory.startsWith(`${mountPoint}/`)) return undefined;
    let available = Infinity;
    for (; ;) {
      const current = memoryNumber(optionalText(path.join(directory, v2 ? "memory.current" : "memory.usage_in_bytes")));
      const limit = memoryNumber(optionalText(path.join(directory, v2 ? "memory.max" : "memory.limit_in_bytes")), true);
      const high = v2 ? memoryNumber(optionalText(path.join(directory, "memory.high")), true) : Infinity;
      if (current === undefined || limit === undefined || high === undefined) return undefined;
      available = Math.min(available, Math.max(0, Math.min(limit, high) - current));
      if (directory === mountPoint) return available;
      const parent = path.posix.dirname(directory);
      if (parent === directory || !parent.startsWith(mountPoint)) return undefined;
      directory = parent;
    }
  }
  return undefined;
}

function hasHeadroom(remainingPayload, nextAllocation = 0) {
  const host = optionalText("/proc/meminfo")?.match(/^MemAvailable:\s+(\d+)\s+kB$/m)?.[1];
  const hostBytes = memoryNumber(host);
  const cgroupBytes = cgroupHeadroom();
  if (hostBytes === undefined || cgroupBytes === undefined) return false;
  const required = MAX_CHILDREN * (remainingPayload + CHILD_OVERHEAD) + SYSTEM_RESERVE;
  return Math.min(hostBytes * 1024, cgroupBytes) >= required && process.memoryUsage().rss + nextAllocation <= RSS_CAP;
}

function blob(value, bytes) {
  if (!(value instanceof Uint8Array) || value.byteLength !== bytes) incompatible();
  return value;
}

function safeInteger(value) {
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 0) incompatible();
  return value;
}

function schemaHash(db) {
  const rows = db.prepare("SELECT name, sql FROM main.sqlite_schema WHERE name IN (?, ?, ?, ?) ORDER BY name").all(TABLE, `${TABLE}_rowids`, `${TABLE}_chunks`, `${TABLE}_vector_chunks00`);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
function createContext(db, request, extensionPath) {
  if (process.platform !== "linux" || process.arch !== "x64" || request.vectorTable !== TABLE || request.queryVec?.length !== SHADOW_CONTRACT.dimensions) incompatible();
  if (new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] !== 4) incompatible();
  if (typeof extensionPath !== "string") incompatible();
  let extension;
  try { extension = fs.readFileSync(extensionPath); } catch { incompatible(); }
  if (createHash("sha256").update(extension).digest("hex") !== SHADOW_CONTRACT.extensionSha256) incompatible();
  if (db.prepare("SELECT vec_version() AS version").get()?.version !== SHADOW_CONTRACT.extensionVersion || schemaHash(db) !== SHADOW_CONTRACT.schemaSha256) incompatible();
  for (const [name, expected] of [
    [`${TABLE}_rowids`, ["rowid", "id", "chunk_id", "chunk_offset"]],
    [`${TABLE}_chunks`, ["chunk_id", "size", "validity", "rowids"]],
    [`${TABLE}_vector_chunks00`, ["rowid", "vectors"]],
  ]) {
    const actual = db.prepare(`PRAGMA main.table_info(${name})`).all().map((row) => row.name);
    if (actual.join("|") !== expected.join("|")) incompatible();
  }
  const width = SHADOW_CONTRACT.dimensions * 4;
  const blockBytes = SHADOW_CONTRACT.slots * width;
  const counts = db.prepare(`SELECT count(*) AS count, min(length(vectors)) AS low, max(length(vectors)) AS high FROM main.${TABLE}_vector_chunks00`).get();
  const count = safeInteger(counts.count);
  const totalPayload = count * blockBytes;
  if (count === 0 || !Number.isSafeInteger(totalPayload) || totalPayload > CACHE_CAP || counts.low !== blockBytes || counts.high !== blockBytes || !hasHeadroom(totalPayload, blockBytes)) incompatible();
  const mapping = db.prepare(`SELECT rowid AS rid, chunk_id, chunk_offset FROM main.${TABLE}_rowids WHERE id = ?`);
  mapping.setReadBigInts(true);
  const header = db.prepare(`SELECT size, validity, rowids FROM main.${TABLE}_chunks WHERE chunk_id = ?`);
  const vectors = db.prepare(`SELECT _rowid_ AS physical_rowid, rowid AS declared_rowid, vectors FROM main.${TABLE}_vector_chunks00 WHERE _rowid_ = ?`);
  const publicVector = db.prepare(`SELECT embedding FROM main.${TABLE} WHERE id = ?`);
  const cache = new Map();
  let payload = 0;
  let disabled = false;
  const clear = () => { cache.clear(); payload = 0; disabled = true; };
  return {
    clear,
    get fallback() { return disabled; },
    read(id) {
      if (disabled) return null;
      try {
        if (typeof id !== "string") incompatible();
        const row = mapping.get(id);
        if (!row) incompatible();
        const rid = safeInteger(row.rid);
        const chunkId = safeInteger(row.chunk_id);
        const offset = safeInteger(row.chunk_offset);
        if (offset >= SHADOW_CONTRACT.slots) incompatible();
        let block = cache.get(chunkId);
        let fresh = false;
        if (!block) {
          if (payload + blockBytes > CACHE_CAP || !hasHeadroom(Math.max(0, totalPayload - payload), blockBytes)) incompatible();
          const h = header.get(chunkId);
          const v = vectors.get(chunkId);
          if (!h || !v || h.size !== SHADOW_CONTRACT.slots || v.physical_rowid !== chunkId || v.declared_rowid !== chunkId) incompatible();
          block = {
            validity: blob(h.validity, SHADOW_CONTRACT.slots / 8),
            rowids: blob(h.rowids, SHADOW_CONTRACT.slots * 8),
            bytes: blob(v.vectors, blockBytes),
          };
          cache.set(chunkId, block);
          payload += blockBytes;
          fresh = true;
        }
        if (((block.validity[offset >> 3] >> (offset & 7)) & 1) !== 1) incompatible();
        if (new DataView(block.rowids.buffer, block.rowids.byteOffset, block.rowids.byteLength).getBigInt64(offset * 8, true) !== BigInt(rid)) incompatible();
        const result = Buffer.from(block.bytes.buffer, block.bytes.byteOffset + offset * width, width);
        if (fresh) {
          const native = blob(publicVector.get(id)?.embedding, width);
          if (!result.equals(Buffer.from(native.buffer, native.byteOffset, native.byteLength))) incompatible();
        }
        return result;
      } catch (error) {
        if (!(error instanceof IncompatibleShadow)) throw error;
        clear();
        return null;
      }
    },
  };
}

export function installShadowProjection(db) {
  db.function("openclaw_unraid_shadow_v", { deterministic: true }, (id) => contexts.get(db)?.read(id) ?? null);
}

export function withShadowProjection(db, request, extensionPath, query) {
  let transaction = false;
  let context;
  try {
    db.exec("BEGIN DEFERRED");
    transaction = true;
    try { context = createContext(db, request, extensionPath); } catch (error) {
      if (!(error instanceof IncompatibleShadow)) throw error;
    }
    if (context) contexts.set(db, context);
    const result = query(db, request);
    return !context || context.fallback ? { ...result, unraidShadowFallback: "native-v" } : result;
  } finally {
    try {
      if (transaction) db.exec("ROLLBACK");
    } finally {
      context?.clear();
      contexts.delete(db);
    }
  }
}
