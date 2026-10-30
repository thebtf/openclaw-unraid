#!/usr/bin/env node
/** Keep the native state-reading probe behind this exact bootstrap generation. */
import fs from "node:fs";
import { spawn } from "node:child_process";

const MARKER = "/run/openclaw-unraid-gateway-exec";
const STAGING = `${MARKER}.staging`;
const FORMAT = "openclaw-unraid.gateway-exec.v1";

function processGeneration(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  if (!/^\d+$/.test(fields[19])) throw Error("process generation unavailable");
  return {
    pid,
    startTime: fields[19],
    bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    pidNamespace: fs.readlinkSync("/proc/self/ns/pid"),
  };
}

function checkDirectory() {
  const stat = fs.lstatSync("/run");
  if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || fs.realpathSync("/run") !== "/run") throw Error("unsafe marker directory");
}

function safeStat(file, links = [1]) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.uid !== 0 || !links.includes(stat.nlink) || (stat.mode & 0o022) !== 0 || stat.size > 1024) throw Error("unsafe marker");
  return stat;
}

function sameFile(left, right, afterSiblingUnlink = false) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode && (afterSiblingUnlink || left.nlink === right.nlink && left.ctimeMs === right.ctimeMs);
}

function readMarker(links = [1]) {
  checkDirectory();
  const listed = safeStat(MARKER, links);
  const descriptor = fs.openSync(MARKER, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!sameFile(opened, listed)) throw Error("changed marker");
    const marker = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (marker.format !== FORMAT || !Number.isSafeInteger(marker.pid) || marker.pid <= 0 || typeof marker.startTime !== "string" || !/^\d+$/.test(marker.startTime) || typeof marker.bootId !== "string" || typeof marker.pidNamespace !== "string") throw Error("invalid marker");
    if (!sameFile(opened, safeStat(MARKER, links))) throw Error("changed marker");
    return { marker, identity: opened };
  } finally {
    fs.closeSync(descriptor);
  }
}

function optionalStat(file) {
  try { return safeStat(file, [1, 2]); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function syncDirectory() {
  const descriptor = fs.openSync("/run", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function reset() {
  if (process.getuid() !== 0) throw Error("root required");
  checkDirectory();
  const marker = optionalStat(MARKER);
  const staging = optionalStat(STAGING);
  const paired = marker && staging && marker.dev === staging.dev && marker.ino === staging.ino;
  if ((marker?.nlink === 2 || staging?.nlink === 2) && !(paired && marker.nlink === 2 && staging.nlink === 2)) throw Error("unexpected marker alias");
  // A root-owned empty legacy marker is an interrupted pre-atomic publication.
  // Nonempty unknown payloads and aliases remain protected, never overwritten.
  if (marker && marker.size !== 0 && !sameFile(marker, readMarker([1, 2]).identity)) throw Error("changed marker");
  if (staging) {
    if (!sameFile(staging, safeStat(STAGING, [staging.nlink]))) throw Error("changed staging marker");
    fs.unlinkSync(STAGING);
  }
  if (marker) {
    if (!sameFile(marker, safeStat(MARKER), paired)) throw Error("changed marker");
    fs.unlinkSync(MARKER);
  }
  syncDirectory();
}

function publish() {
  if (process.getuid() !== 0) throw Error("root required");
  checkDirectory();
  const generation = processGeneration(process.ppid);
  const descriptor = fs.openSync(STAGING, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify({ format: FORMAT, ...generation })}\n`);
    fs.fchmodSync(descriptor, 0o644);
    fs.fsyncSync(descriptor);
    if (!sameFile(fs.fstatSync(descriptor), safeStat(STAGING))) throw Error("changed staging marker");
  } finally {
    fs.closeSync(descriptor);
  }
  // link is an atomic no-replace publication of complete bytes. A crash leaves
  // either private staging only or a verified two-name inode that reset owns.
  fs.linkSync(STAGING, MARKER);
  syncDirectory();
  const marker = safeStat(MARKER, [2]);
  if (!sameFile(marker, safeStat(STAGING, [2]))) throw Error("changed marker publication");
  fs.unlinkSync(STAGING);
  syncDirectory();
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--reset") return reset();
  if (process.argv.length === 3 && process.argv[2] === "--publish") return publish();
  if (process.argv.length !== 2) throw Error("unexpected arguments");
  const { marker } = readMarker();
  const current = processGeneration(marker.pid);
  if (current.startTime !== marker.startTime || current.bootId !== marker.bootId || current.pidNamespace !== marker.pidNamespace) throw Error("stale bootstrap generation");
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["/app/dist/docker-healthcheck.js"], { shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code === 0 ? 0 : 1));
  });
  process.exitCode = status;
}

main().catch(() => {
  if (process.argv.length !== 2) process.stderr.write("Container-local bootstrap healthcheck gate refused.\n");
  process.exitCode = 1;
});
