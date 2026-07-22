#!/usr/bin/env bun
// @bun

// packages/installer/src/cli.ts
import process9 from "process";

// packages/run-workspace/src/errors.ts
class RunWorkspaceError extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.name = "RunWorkspaceError";
    this.code = code;
  }
}

// packages/run-workspace/src/aborted.ts
class RunWorkspaceAbortedError extends RunWorkspaceError {
  signal;
  constructor(message = "Run workspace creation was aborted", signal) {
    super("RUN_WORKSPACE_ABORTED", message);
    this.name = "RunWorkspaceAbortedError";
    this.signal = signal;
  }
}
// packages/run-workspace/src/janitor.ts
import { basename, dirname, join as join4 } from "path";

// packages/run-workspace/src/marker.ts
import { join as join3 } from "path";

// packages/run-workspace/src/platform.ts
import { execFile } from "child_process";
import { constants as constants3, realpathSync } from "fs";
import {
  chmod,
  lstat as lstat2,
  mkdir,
  mkdtemp,
  open as open2,
  opendir as opendir2,
  readdir,
  readFile,
  realpath,
  rename,
  rm
} from "fs/promises";
import { tmpdir } from "os";
import { join as join2, win32 } from "path";
import process2 from "process";
import { promisify } from "util";

// packages/run-workspace/src/usage/directory.ts
import { constants as constants2 } from "fs";
import { lstat, open, opendir } from "fs/promises";
import { join } from "path";

// packages/run-workspace/src/usage/darwin.ts
import { dlopen, FFIType, ptr } from "bun:ffi";
import { constants } from "fs";
import process from "process";
var blockBytes = 512n;
var directoryBufferBytes = 64 * 1024;
var statBytes = 144;
var direntHeaderBytes = 21;
var nanosecondsPerSecond = 1000000000n;
var atSymlinkNoFollow = 32;
var closeOnExec = 16777216;
var seekStart = 0;
var fileTypeMask = 61440;
var directoryMode = 16384;
var regularMode = 32768;
var symlinkMode = 40960;
var unsafeEntryName = /[\\/\0]/u;
var decoder = new TextDecoder("utf-8", { fatal: true });
var definitions = {
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  fstat: {
    args: [FFIType.i32, FFIType.ptr],
    returns: FFIType.i32
  },
  fstatat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32
  },
  __getdirentries64: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.ptr],
    returns: FFIType.i64
  },
  lseek: {
    args: [FFIType.i32, FFIType.i64, FFIType.i32],
    returns: FFIType.i64
  },
  openat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32
  }
};
var library = (() => {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    return dlopen("/usr/lib/libSystem.B.dylib", definitions);
  } catch {
    return;
  }
})();
function safeName(name) {
  return name.length > 0 && name !== "." && name !== ".." && !unsafeEntryName.test(name);
}
function nativeNumber(value) {
  const selected = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(selected)) {
    return;
  }
  return selected;
}
function timeNanoseconds(view, offset) {
  const seconds = view.getBigInt64(offset, true);
  const nanoseconds = view.getBigInt64(offset + 8, true);
  return (seconds * nanosecondsPerSecond + nanoseconds).toString(10);
}
function entryKind(mode) {
  const fileType = mode & fileTypeMask;
  if (fileType === directoryMode) {
    return "directory";
  }
  if (fileType === regularMode) {
    return "file";
  }
  if (fileType === symlinkMode) {
    return "symlink";
  }
  return "other";
}
function parseStat(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const logicalBytes = view.getBigInt64(96, true);
  const blocks = view.getBigInt64(104, true);
  if (logicalBytes < 0n || blocks < 0n) {
    return;
  }
  return {
    kind: entryKind(view.getUint16(4, true)),
    device: view.getInt32(0, true).toString(10),
    inode: view.getBigUint64(8, true).toString(10),
    birthtimeNs: timeNanoseconds(view, 80),
    changeTimeNs: timeNanoseconds(view, 64),
    modifiedTimeNs: timeNanoseconds(view, 48),
    logicalBytes,
    allocatedBytes: blocks * blockBytes
  };
}
function descriptorStat(descriptor) {
  const symbols = library?.symbols;
  if (symbols === undefined) {
    return;
  }
  const bytes = new Uint8Array(statBytes);
  if (symbols.fstat(descriptor, ptr(bytes)) !== 0) {
    return;
  }
  return parseStat(bytes);
}
function childStat(descriptor, name) {
  const symbols = library?.symbols;
  if (symbols === undefined || !safeName(name)) {
    return;
  }
  const bytes = new Uint8Array(statBytes);
  const encoded = Buffer.from(`${name}\x00`, "utf8");
  if (symbols.fstatat(descriptor, ptr(encoded), ptr(bytes), atSymlinkNoFollow) !== 0) {
    return;
  }
  return parseStat(bytes);
}
function directoryNames(descriptor, limit) {
  const symbols = library?.symbols;
  if (symbols === undefined || nativeNumber(symbols.lseek(descriptor, 0n, seekStart)) !== 0) {
    return;
  }
  const names = [];
  const bytes = new Uint8Array(directoryBufferBytes);
  const base = new BigInt64Array(1);
  while (names.length <= limit) {
    const count = nativeNumber(symbols.__getdirentries64(descriptor, ptr(bytes), BigInt(bytes.byteLength), ptr(base)));
    if (count === undefined || count < 0) {
      return;
    }
    if (count === 0) {
      return { names, truncated: false };
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, count);
    let offset = 0;
    while (offset < count) {
      if (offset + direntHeaderBytes > count) {
        return;
      }
      const recordBytes = view.getUint16(offset + 16, true);
      const nameBytes = view.getUint16(offset + 18, true);
      if (recordBytes < direntHeaderBytes || offset + recordBytes > count || nameBytes > recordBytes - direntHeaderBytes) {
        return;
      }
      const name = decoder.decode(bytes.subarray(offset + direntHeaderBytes, offset + direntHeaderBytes + nameBytes));
      if (name !== "." && name !== "..") {
        if (!safeName(name)) {
          return;
        }
        names.push(name);
        if (names.length > limit) {
          return { names: names.slice(0, limit), truncated: true };
        }
      }
      offset += recordBytes;
    }
  }
  return { names: names.slice(0, limit), truncated: true };
}

class DarwinUsageDirectory {
  entry;
  #descriptor;
  #closeDescriptor;
  #closed = false;
  constructor(descriptor, entry, closeDescriptor) {
    this.#descriptor = descriptor;
    this.entry = entry;
    this.#closeDescriptor = closeDescriptor;
  }
  scan(limit) {
    if (this.#closed) {
      return Promise.reject(new Error("Usage directory is closed"));
    }
    const scanned = directoryNames(this.#descriptor, limit);
    if (scanned === undefined) {
      return Promise.reject(new Error("Descriptor enumeration failed"));
    }
    return Promise.resolve(scanned);
  }
  inspect(name) {
    if (this.#closed) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(childStat(this.#descriptor, name));
  }
  open(name) {
    const symbols = library?.symbols;
    if (this.#closed || symbols === undefined || !safeName(name)) {
      return Promise.resolve(undefined);
    }
    const encoded = Buffer.from(`${name}\x00`, "utf8");
    const descriptor = symbols.openat(this.#descriptor, ptr(encoded), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec);
    if (descriptor < 0) {
      return Promise.resolve(undefined);
    }
    const entry = descriptorStat(descriptor);
    if (entry?.kind !== "directory") {
      symbols.close(descriptor);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(new DarwinUsageDirectory(descriptor, entry, async () => {
      if (symbols.close(descriptor) !== 0) {
        throw new Error("Descriptor close failed");
      }
    }));
  }
  stat() {
    if (this.#closed) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(descriptorStat(this.#descriptor));
  }
  async close() {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#closeDescriptor();
  }
}
function openDarwinUsageDirectory(handle) {
  if (library === undefined) {
    return;
  }
  const entry = descriptorStat(handle.fd);
  if (entry?.kind !== "directory") {
    return;
  }
  return new DarwinUsageDirectory(handle.fd, entry, () => handle.close());
}

// packages/run-workspace/src/usage/directory.ts
var blockBytes2 = 512n;
var unsafeEntryName2 = /[\\/\0]/u;
function safeName2(name) {
  return name.length > 0 && name !== "." && name !== ".." && !unsafeEntryName2.test(name);
}
function fromStats(stats) {
  let kind = "other";
  if (stats.isDirectory()) {
    kind = "directory";
  } else if (stats.isFile()) {
    kind = "file";
  } else if (stats.isSymbolicLink()) {
    kind = "symlink";
  }
  const logicalBytes = stats.size;
  const allocatedBytes = stats.blocks * blockBytes2;
  if (logicalBytes < 0n || allocatedBytes < 0n) {
    return;
  }
  return {
    kind,
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    birthtimeNs: stats.birthtimeNs.toString(10),
    changeTimeNs: stats.ctimeNs.toString(10),
    modifiedTimeNs: stats.mtimeNs.toString(10),
    logicalBytes,
    allocatedBytes
  };
}
function sameEntry(left, right) {
  return left.kind === right.kind && left.device === right.device && left.inode === right.inode && left.birthtimeNs === right.birthtimeNs && left.changeTimeNs === right.changeTimeNs && left.modifiedTimeNs === right.modifiedTimeNs && left.logicalBytes === right.logicalBytes && left.allocatedBytes === right.allocatedBytes;
}
function descriptorRoot(platform, descriptor) {
  if (platform === "linux") {
    return `/proc/self/fd/${descriptor}`;
  }
  return;
}
async function scanDescriptor(root, limit) {
  const directory = await opendir(root);
  const names = [];
  try {
    while (names.length <= limit) {
      const entry = await directory.read();
      if (entry === null) {
        return { names, truncated: false };
      }
      names.push(entry.name);
    }
    return { names: names.slice(0, limit), truncated: true };
  } finally {
    await directory.close().catch(() => {
      return;
    });
  }
}

class SystemUsageDirectory {
  entry;
  #handle;
  #root;
  #platform;
  #closed = false;
  constructor(handle, root, platform, entry) {
    this.#handle = handle;
    this.#root = root;
    this.#platform = platform;
    this.entry = entry;
  }
  scan(limit) {
    return scanDescriptor(this.#root, limit);
  }
  inspect(name) {
    if (!safeName2(name) || this.#closed) {
      return Promise.resolve(undefined);
    }
    return lstatSystemUsage(join(this.#root, name));
  }
  open(name) {
    if (!safeName2(name) || this.#closed) {
      return Promise.resolve(undefined);
    }
    return openSystemUsageDirectory(join(this.#root, name), this.#platform);
  }
  async stat() {
    if (this.#closed) {
      return;
    }
    try {
      return fromStats(await this.#handle.stat({ bigint: true }));
    } catch {
      return;
    }
  }
  async close() {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#handle.close();
  }
}
async function lstatSystemUsage(path) {
  try {
    return fromStats(await lstat(path, { bigint: true }));
  } catch {
    return;
  }
}
async function openSystemUsageDirectory(path, platform) {
  if (platform !== "linux" && platform !== "darwin") {
    return;
  }
  let handle;
  try {
    handle = await open(path, constants2.O_RDONLY | constants2.O_DIRECTORY | constants2.O_NOFOLLOW);
    const entry = fromStats(await handle.stat({ bigint: true }));
    if (entry?.kind !== "directory") {
      await handle.close();
      return;
    }
    if (platform === "darwin") {
      const directory = openDarwinUsageDirectory(handle);
      if (directory === undefined || !sameEntry(entry, directory.entry)) {
        await directory?.close().catch(() => {
          return;
        });
        if (directory === undefined) {
          await handle.close();
        }
        return;
      }
      return directory;
    }
    const root = descriptorRoot(platform, handle.fd);
    if (root === undefined) {
      await handle.close();
      return;
    }
    const probe = await opendir(root);
    await probe.close();
    const confirmed = fromStats(await handle.stat({ bigint: true }));
    if (confirmed === undefined || !sameEntry(entry, confirmed)) {
      await handle.close();
      return;
    }
    return new SystemUsageDirectory(handle, root, platform, entry);
  } catch {
    await handle?.close().catch(() => {
      return;
    });
    return;
  }
}

// packages/run-workspace/src/platform.ts
var execFileAsync = promisify(execFile);
var decimalPattern = /^\d+$/u;
var whitespacePattern = /\s+/gu;
var darwinBootPattern = /sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/u;
function errorCode(error) {
  if (typeof error !== "object" || error === null || !("code" in error))
    return;
  return typeof error.code === "string" ? error.code : undefined;
}
function deadline(milliseconds) {
  let timer;
  const elapsed = new Promise((resolve) => {
    timer = setTimeout(() => {
      timer = undefined;
      resolve();
    }, milliseconds);
  });
  return {
    elapsed,
    cancel: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    }
  };
}
async function linuxIdentity(pid) {
  try {
    const [bootId, stat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8")
    ]);
    const startTicks = parseLinuxStartTicks(stat);
    if (startTicks === undefined)
      return;
    return { platform: "linux", token: `${bootId.trim()}:${startTicks}` };
  } catch {
    return;
  }
}
async function darwinIdentity(pid) {
  try {
    const [processResult, bootResult] = await Promise.all([
      execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 2000
      }),
      execFileAsync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
        encoding: "utf8",
        timeout: 2000
      })
    ]);
    const normalized = processResult.stdout.trim().replace(whitespacePattern, " ");
    const bootIdentity = parseDarwinBootTime(bootResult.stdout);
    if (normalized.length === 0)
      return;
    if (bootIdentity === undefined)
      return;
    return { platform: "darwin", token: `${bootIdentity}:${normalized}` };
  } catch {
    return;
  }
}
function parseDarwinBootTime(output) {
  const match = darwinBootPattern.exec(output);
  const seconds = match?.[1];
  const microseconds = match?.[2];
  if (seconds === undefined || microseconds === undefined)
    return;
  return `${seconds}.${microseconds}`;
}
function parseLinuxStartTicks(stat) {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0)
    return;
  const fields = stat.slice(commandEnd + 1).trim().split(whitespacePattern);
  const startTicks = fields[19];
  if (startTicks === undefined || !decimalPattern.test(startTicks))
    return;
  return startTicks;
}
async function windowsIdentity(pid) {
  const systemRoot = process2.env["SystemRoot"];
  if (systemRoot === undefined || systemRoot.length === 0) {
    return;
  }
  const powershell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc()`;
    const result = await execFileAsync(powershell, ["-NoLogo", "-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true
    });
    const token = result.stdout.trim();
    if (!decimalPattern.test(token))
      return;
    return { platform: "win32", token };
  } catch {
    return;
  }
}
function getProcessIdentity(platform, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.resolve(undefined);
  }
  if (platform === "linux") {
    return linuxIdentity(pid);
  }
  if (platform === "darwin") {
    return darwinIdentity(pid);
  }
  if (platform === "win32") {
    return windowsIdentity(pid);
  }
  return Promise.resolve(undefined);
}
async function observeProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return;
  try {
    process2.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH")
      return false;
    if (code === "EPERM")
      return true;
    return;
  }
}
async function fileIdentity(path) {
  try {
    const stats = await lstat2(path, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return;
    }
    return {
      device: stats.dev.toString(10),
      inode: stats.ino.toString(10),
      birthtimeNs: stats.birthtimeNs.toString(10)
    };
  } catch {
    return;
  }
}
async function isRegularFile(path) {
  try {
    const stats = await lstat2(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}
async function pathExists(path) {
  try {
    await lstat2(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      return false;
    return;
  }
}
async function isPrivateDirectory(path) {
  try {
    const stats = await lstat2(path);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      return false;
    if (process2.platform === "win32")
      return true;
    const currentUserId = process2.getuid?.();
    return (stats.mode & 63) === 0 && (currentUserId === undefined || stats.uid === currentUserId);
  } catch {
    return false;
  }
}
async function writeReplacement(path, contents) {
  const temporary = `${path}.next-${crypto.randomUUID()}`;
  await writeSynced(temporary, contents, true);
  try {
    await rename(temporary, path);
    await syncParent(path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {
      return;
    });
    throw error;
  }
}
async function syncParent(path) {
  if (process2.platform === "win32")
    return;
  const directory = await open2(join2(path, ".."), constants3.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function writeSynced(path, contents, exclusive) {
  const flags = exclusive ? constants3.O_CREAT | constants3.O_EXCL | constants3.O_WRONLY : constants3.O_WRONLY;
  const handle = await open2(path, flags, 384);
  try {
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncParent(path);
}
async function readSecureFile(path, maximumBytes) {
  const noFollow = process2.platform === "win32" ? 0 : constants3.O_NOFOLLOW;
  let handle;
  try {
    const pathBefore = await lstat2(path, { bigint: true });
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size > BigInt(maximumBytes) || process2.platform !== "win32" && (Number(pathBefore.mode) & 63) !== 0) {
      return;
    }
    handle = await open2(path, constants3.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || pathBefore.dev !== before.dev || pathBefore.ino !== before.ino || pathBefore.birthtimeNs !== before.birthtimeNs || before.size > BigInt(maximumBytes) || process2.platform !== "win32" && (Number(before.mode) & 63) !== 0) {
      return;
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat2(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs || before.size !== after.size || pathAfter.isSymbolicLink() || after.dev !== pathAfter.dev || after.ino !== pathAfter.ino || after.birthtimeNs !== pathAfter.birthtimeNs) {
      return;
    }
    return contents;
  } catch {
    return;
  } finally {
    await handle?.close().catch(() => {
      return;
    });
  }
}
async function scanDirectory(path, limit) {
  const directory = await opendir2(path);
  const names = [];
  try {
    while (names.length <= limit) {
      const entry = await directory.read();
      if (entry === null)
        return { names, truncated: false };
      names.push(entry.name);
    }
    return { names: names.slice(0, limit), truncated: true };
  } finally {
    try {
      await directory.close();
    } catch {}
  }
}
function systemRuntime() {
  return {
    pid: process2.pid,
    platform: process2.platform,
    now: Date.now,
    deadline,
    temporaryDirectory: () => realpathSync(tmpdir()),
    processIdentity: (pid) => getProcessIdentity(process2.platform, pid),
    processExists: observeProcess,
    mkdir: (path, options) => mkdir(path, options),
    chmod,
    mkdtemp,
    lstatIdentity: fileIdentity,
    lstatUsage: lstatSystemUsage,
    openUsageDirectory: (path) => openSystemUsageDirectory(path, process2.platform),
    isDirectory: async (path) => await fileIdentity(path) !== undefined,
    isPrivateDirectory,
    isFile: isRegularFile,
    pathExists,
    realpath,
    readFile: (path) => readFile(path, "utf8"),
    readSecureFile,
    writeExclusive: (path, contents) => writeSynced(path, contents, true),
    writeReplace: writeReplacement,
    readdir: async (path) => readdir(path),
    scanDirectory,
    rename,
    removeRoot: (path) => rm(path, {
      recursive: true,
      force: false,
      maxRetries: 5,
      retryDelay: 100
    }),
    errorCode
  };
}
var managedDirectoryName = "skizzles-run-workspaces";
var markerName = ".skizzles-run-workspace.json";
function managedParent(runtime) {
  return join2(runtime.temporaryDirectory(), managedDirectoryName);
}

// packages/run-workspace/src/safety.ts
async function inspectCanonicalDirectory(runtime, path) {
  const [identity, canonical] = await Promise.all([
    runtime.lstatIdentity(path),
    runtime.realpath(path).catch(() => {
      return;
    })
  ]);
  if (identity === undefined || canonical !== path)
    return;
  return { identity };
}
async function inspectPrivateDirectory(runtime, path) {
  const [inspected, privateOwner] = await Promise.all([
    inspectCanonicalDirectory(runtime, path),
    runtime.isPrivateDirectory(path)
  ]);
  if (inspected === undefined || !privateOwner)
    return;
  return inspected;
}

// packages/run-workspace/src/marker.ts
var markerSchema = 1;
var decimalPattern2 = /^\d+$/u;
var runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
var maximumReasonLength = 256;
var maximumMarkerBytes = 16 * 1024;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(record, required, optional) {
  const allowed = new Set([...required, ...optional]);
  return Object.keys(record).every((key) => allowed.has(key));
}
function parseFileIdentity(value) {
  if (!isRecord(value)) {
    return;
  }
  if (!exactKeys(value, ["device", "inode", "birthtimeNs"], [])) {
    return;
  }
  const { device, inode, birthtimeNs } = value;
  if (typeof device !== "string" || typeof inode !== "string" || typeof birthtimeNs !== "string" || !decimalPattern2.test(device) || !decimalPattern2.test(inode) || !decimalPattern2.test(birthtimeNs)) {
    return;
  }
  return { device, inode, birthtimeNs };
}
function parseProcessIdentity(value) {
  if (!isRecord(value)) {
    return;
  }
  if (!exactKeys(value, ["platform", "token"], [])) {
    return;
  }
  const { platform, token } = value;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32" || typeof token !== "string" || token.length === 0) {
    return;
  }
  return { platform, token };
}
function parseMarker(contents) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const required = [
    "schema",
    "runId",
    "root",
    "rootIdentity",
    "ownerPid",
    "ownerIdentity",
    "createdAtMs",
    "state"
  ];
  if (!exactKeys(value, required, ["reason"])) {
    return;
  }
  const rootIdentity = parseFileIdentity(value["rootIdentity"]);
  const ownerIdentity = parseProcessIdentity(value["ownerIdentity"]);
  const state = value["state"];
  const schema = value["schema"];
  const runId = value["runId"];
  const root = value["root"];
  const ownerPid = value["ownerPid"];
  const createdAtMs = value["createdAtMs"];
  const reason = value["reason"];
  if (schema !== markerSchema || typeof runId !== "string" || !runIdPattern.test(runId) || typeof root !== "string" || root.length === 0 || rootIdentity === undefined || !Number.isSafeInteger(ownerPid) || typeof ownerPid !== "number" || ownerPid <= 0 || ownerIdentity === undefined || !Number.isSafeInteger(createdAtMs) || typeof createdAtMs !== "number" || createdAtMs < 0 || state !== "open" && state !== "preserved" && state !== "cleanup-failed" && state !== "reaping" || reason !== undefined && typeof reason !== "string") {
    return;
  }
  const marker = {
    schema: markerSchema,
    runId,
    root,
    rootIdentity,
    ownerPid,
    ownerIdentity,
    createdAtMs,
    state,
    ...typeof reason === "string" ? { reason } : {}
  };
  return serializeMarker(marker) === contents ? marker : undefined;
}
function sameFileIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode && left.birthtimeNs === right.birthtimeNs;
}
function sameProcessIdentity(left, right) {
  return left.platform === right.platform && left.token === right.token;
}
function markerPath(root) {
  return join3(root, markerName);
}
function serializeMarker(marker) {
  return `${JSON.stringify(marker, undefined, 2)}
`;
}
async function readMarker(runtime, root) {
  try {
    const contents = await runtime.readSecureFile(markerPath(root), maximumMarkerBytes);
    return contents === undefined ? undefined : parseMarker(contents);
  } catch {
    return;
  }
}
async function verifyMarkedRoot(runtime, root, expectedRunId, transitionalRoot) {
  const [inspected, marker] = await Promise.all([
    inspectPrivateDirectory(runtime, root),
    readMarker(runtime, root)
  ]);
  if (inspected === undefined || marker === undefined) {
    throw new RunWorkspaceError("UNVERIFIED_ROOT", "Refusing to clean an unverified run root");
  }
  const acceptedMarkerPath = marker.root === root || marker.root === transitionalRoot;
  if (!(acceptedMarkerPath && sameFileIdentity(inspected.identity, marker.rootIdentity)) || expectedRunId !== undefined && marker.runId !== expectedRunId) {
    throw new RunWorkspaceError("ROOT_IDENTITY_CHANGED", "Run workspace identity changed");
  }
  return marker;
}
function safeReason(reason) {
  const sanitized = [...reason].map((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  }).join("");
  return sanitized.trim().slice(0, maximumReasonLength);
}

// packages/run-workspace/src/janitor.ts
var defaultMinimumAgeMs = 60 * 60 * 1000;
var defaultScanLimit = 128;
function integerOption(value, fallback, name, maximum) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > maximum) {
    throw new RunWorkspaceError("INVALID_OPTION", `${name} must be an integer from 0 to ${maximum}`);
  }
  return selected;
}
function candidateName(name) {
  return name.startsWith("run-") || name.startsWith("reaping-");
}
function transitionalRoot(runtime, root, marker) {
  if (marker.root === root)
    return;
  const parent = managedParent(runtime);
  if (dirname(root) === parent && dirname(marker.root) === parent && basename(root).startsWith(`reaping-${marker.runId}-`) && candidateName(basename(marker.root))) {
    return marker.root;
  }
  return;
}
async function verifyCandidate(runtime, root, marker) {
  const transition = transitionalRoot(runtime, root, marker);
  if (marker.root !== root && transition === undefined) {
    throw new RunWorkspaceError("ROOT_IDENTITY_CHANGED", "Run workspace identity changed");
  }
  await verifyMarkedRoot(runtime, root, marker.runId, transition);
}
async function classify(runtime, root, minimumAgeMs) {
  if (!await runtime.isFile(markerPath(root)))
    return { clean: false, skip: "unmarked" };
  const marker = await readMarker(runtime, root);
  if (marker === undefined)
    return { clean: false, skip: "malformed-marker" };
  if (marker.state === "preserved")
    return { clean: false, skip: "preserved" };
  if (runtime.now() - marker.createdAtMs < minimumAgeMs)
    return { clean: false, skip: "too-young" };
  try {
    await verifyCandidate(runtime, root, marker);
  } catch {
    return { clean: false, skip: "identity-mismatch" };
  }
  const currentIdentity = await runtime.processIdentity(marker.ownerPid);
  if (currentIdentity !== undefined) {
    if (sameProcessIdentity(currentIdentity, marker.ownerIdentity)) {
      return { clean: false, skip: "live-owner" };
    }
    return { clean: true };
  }
  const exists = await runtime.processExists(marker.ownerPid);
  if (exists === false)
    return { clean: true };
  return { clean: false, skip: "unknown-owner" };
}
async function reap(runtime, root) {
  const marker = await readMarker(runtime, root);
  if (marker === undefined) {
    if (await runtime.pathExists(root) === false)
      return "claimed";
    throw new RunWorkspaceError("MALFORMED_MARKER", "Marker vanished before cleanup");
  }
  try {
    await verifyCandidate(runtime, root, marker);
  } catch (error) {
    if (await runtime.pathExists(root) === false)
      return "claimed";
    throw error;
  }
  const claimed = join4(managedParent(runtime), `reaping-${marker.runId}-${crypto.randomUUID()}`);
  try {
    await runtime.rename(root, claimed);
  } catch (error) {
    if (await runtime.pathExists(root) === false)
      return "claimed";
    throw error;
  }
  const verified = await verifyMarkedRoot(runtime, claimed, marker.runId, marker.root);
  const reapingMarker = {
    ...verified,
    root: claimed,
    state: "reaping"
  };
  await runtime.writeReplace(markerPath(claimed), serializeMarker(reapingMarker));
  await verifyMarkedRoot(runtime, claimed, marker.runId);
  try {
    await runtime.removeRoot(claimed);
  } catch (error) {
    const failedMarker = {
      ...reapingMarker,
      state: "cleanup-failed",
      reason: "CLEANUP_FAILED"
    };
    await runtime.writeReplace(markerPath(claimed), serializeMarker(failedMarker)).catch(() => {
      return;
    });
    throw error;
  }
  return "deleted";
}
async function cleanupStaleWithRuntime(options, runtime) {
  const minimumAgeMs = integerOption(options.minimumAgeMs, defaultMinimumAgeMs, "minimumAgeMs", 365 * 24 * 60 * 60 * 1000);
  const scanLimit = integerOption(options.scanLimit, defaultScanLimit, "scanLimit", 1e4);
  const parent = managedParent(runtime);
  const parentExists = await runtime.pathExists(parent);
  if (parentExists === false) {
    return { deleted: [], skipped: [], failed: [], truncated: false };
  }
  if (await inspectPrivateDirectory(runtime, parent) === undefined) {
    return {
      deleted: [],
      skipped: [],
      failed: [{ rootName: managedDirectoryName, error: "CLEANUP_FAILED" }],
      truncated: false
    };
  }
  let scan;
  try {
    scan = await runtime.scanDirectory(parent, scanLimit);
  } catch (error) {
    if (runtime.errorCode(error) === "ENOENT") {
      return { deleted: [], skipped: [], failed: [], truncated: false };
    }
    return {
      deleted: [],
      skipped: [],
      failed: [{ rootName: managedDirectoryName, error: "CLEANUP_FAILED" }],
      truncated: false
    };
  }
  const selected = scan.names.filter(candidateName).sort();
  const deleted = [];
  const skipped = [];
  const failed = [];
  for (const name of selected) {
    const root = join4(parent, name);
    if (!await runtime.isDirectory(root)) {
      skipped.push({ rootName: name, reason: "unmarked" });
      continue;
    }
    const classification = await classify(runtime, root, minimumAgeMs);
    if (!classification.clean) {
      skipped.push({
        rootName: name,
        reason: classification.skip ?? "unknown-owner"
      });
      continue;
    }
    try {
      const result = await reap(runtime, root);
      if (result === "deleted")
        deleted.push(name);
      else
        skipped.push({ rootName: name, reason: "claimed" });
    } catch {
      failed.push({ rootName: name, error: "CLEANUP_FAILED" });
    }
  }
  return { deleted, skipped, failed, truncated: scan.truncated };
}
function cleanupStale(options = {}) {
  return cleanupStaleWithRuntime(options, systemRuntime());
}
// packages/run-workspace/src/lifecycle.ts
import {
  basename as basename2,
  isAbsolute,
  join as join5,
  relative,
  resolve,
  win32 as win322
} from "path";

// packages/run-workspace/src/children.ts
function observeExit(attempt) {
  let exit;
  try {
    exit = attempt.child.waitForExit();
  } catch {
    return Promise.resolve();
  }
  return exit.then(() => {
    attempt.exited = true;
  }, () => {
    return;
  });
}
function childError(forceFailed) {
  if (forceFailed)
    return "FORCE_STOP_FAILED";
  return "EXIT_UNCONFIRMED";
}
async function waitForChildren(attempts, milliseconds, runtime, escalation) {
  const waiting = Promise.all(attempts.map((attempt) => attempt.wait)).then(() => {
    return;
  });
  const deadline2 = runtime.deadline(milliseconds);
  const contenders = [waiting, deadline2.elapsed];
  if (escalation !== undefined)
    contenders.push(escalation);
  try {
    await Promise.race(contenders);
  } finally {
    deadline2.cancel();
  }
}
function childReport(attempt) {
  const base = {
    label: attempt.child.label,
    stopped: attempt.exited,
    forced: attempt.forced
  };
  const withPid = attempt.child.pid === undefined ? base : { ...base, pid: attempt.child.pid };
  if (attempt.exited)
    return withPid;
  return { ...withPid, error: childError(attempt.forceFailed) };
}
async function stopChildren(options) {
  const attempts = [...options.children].reverse().map((child) => ({
    child,
    exited: false,
    forced: false,
    forceFailed: false,
    wait: Promise.resolve()
  }));
  for (const attempt of attempts) {
    attempt.wait = observeExit(attempt);
    try {
      Promise.resolve(attempt.child.requestStop()).catch(() => {
        return;
      });
    } catch {}
  }
  await waitForChildren(attempts, options.gracefulStopMs, options.runtime, options.escalation);
  const unresolved = attempts.filter((attempt) => !attempt.exited);
  for (const attempt of unresolved) {
    attempt.forced = true;
    try {
      Promise.resolve(attempt.child.forceStop()).catch(() => {
        attempt.forceFailed = true;
      });
    } catch {
      attempt.forceFailed = true;
    }
    attempt.wait = observeExit(attempt);
  }
  await waitForChildren(unresolved, options.forceStopMs, options.runtime);
  return attempts.map(childReport);
}

// packages/run-workspace/src/signals.ts
import process3 from "process";
var targets = new Set;
var listeners = new Map;
function supportedSignals() {
  if (process3.platform === "win32")
    return ["SIGINT", "SIGTERM"];
  return ["SIGHUP", "SIGINT", "SIGTERM"];
}
function install() {
  if (listeners.size > 0)
    return;
  for (const signal of supportedSignals()) {
    const listener = () => {
      const error = new RunWorkspaceAbortedError(`Run workspace interrupted by ${signal}`, signal);
      for (const target of [...targets])
        target.abort(error);
    };
    listeners.set(signal, listener);
    process3.on(signal, listener);
  }
}
function uninstall() {
  if (targets.size > 0)
    return;
  for (const [signal, listener] of listeners)
    process3.off(signal, listener);
  listeners.clear();
}
function coordinateSignals(target) {
  targets.add(target);
  install();
  let active = true;
  return () => {
    if (!active)
      return;
    active = false;
    targets.delete(target);
    uninstall();
  };
}

// packages/run-workspace/src/usage/scan.ts
import { types } from "util";
var maximumScanLimit = 1e6;
var maximumSafeBytes = BigInt(Number.MAX_SAFE_INTEGER);
var limitNames = ["byteLimit", "entryLimit", "scanLimit"];
var limitNameSet = new Set(limitNames);
var unsafeEntryName3 = /[\\/\0]/u;
function integerLimit(value, maximum) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return;
  }
  const selected = Number(value);
  if (selected > maximum) {
    return;
  }
  return selected;
}
function parseUsageLimits(value) {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== limitNames.length || keys.some((key) => typeof key !== "string" || !limitNameSet.has(key))) {
      return;
    }
    const values = new Map;
    for (const name of limitNames) {
      const descriptor = descriptors[name];
      if (descriptor === undefined || !("value" in descriptor)) {
        return;
      }
      values.set(name, descriptor.value);
    }
    const byteLimit = integerLimit(values.get("byteLimit"), Number.MAX_SAFE_INTEGER);
    const entryLimit = integerLimit(values.get("entryLimit"), Number.MAX_SAFE_INTEGER);
    const scanLimit = integerLimit(values.get("scanLimit"), maximumScanLimit);
    if (byteLimit === undefined || entryLimit === undefined || scanLimit === undefined) {
      return;
    }
    return { byteLimit, entryLimit, scanLimit };
  } catch {
    return;
  }
}
function invalidUsage() {
  return {
    state: "unknown",
    code: "INVALID_USAGE_LIMIT",
    logicalBytes: 0,
    allocatedBytes: 0,
    entryCount: 0
  };
}
function boundedNumber(value) {
  if (value > maximumSafeBytes) {
    return;
  }
  return Number(value);
}
function report(state, limits, totals) {
  return {
    state,
    logicalBytes: boundedNumber(totals.logicalBytes) ?? Number.MAX_SAFE_INTEGER,
    allocatedBytes: boundedNumber(totals.allocatedBytes) ?? Number.MAX_SAFE_INTEGER,
    entryCount: totals.entryCount,
    ...limits
  };
}
function unknownUsage(limits, totals = {
  logicalBytes: 0n,
  allocatedBytes: 0n,
  entryCount: 0
}) {
  return report("unknown", limits, totals);
}
function sameEntry2(left, right) {
  return left.kind === right.kind && left.device === right.device && left.inode === right.inode && left.birthtimeNs === right.birthtimeNs && left.changeTimeNs === right.changeTimeNs && left.modifiedTimeNs === right.modifiedTimeNs && left.logicalBytes === right.logicalBytes && left.allocatedBytes === right.allocatedBytes;
}
function identity(entry) {
  return `${entry.device}:${entry.inode}`;
}
function validEntry(entry) {
  return entry.device.length > 0 && entry.inode.length > 0 && entry.birthtimeNs.length > 0 && entry.changeTimeNs.length > 0 && entry.modifiedTimeNs.length > 0 && entry.logicalBytes >= 0n && entry.allocatedBytes >= 0n;
}
function rootMatchesMarker(entry, marker) {
  return entry.kind === "directory" && sameFileIdentity({
    device: entry.device,
    inode: entry.inode,
    birthtimeNs: entry.birthtimeNs
  }, marker.rootIdentity);
}
function addEntry(entry, context) {
  const key = identity(entry);
  const measured = context.measuredIdentities.get(key);
  if (measured !== undefined) {
    return sameEntry2(measured, entry);
  }
  context.measuredIdentities.set(key, entry);
  context.totals.logicalBytes += entry.logicalBytes;
  context.totals.allocatedBytes += entry.allocatedBytes;
  return context.totals.logicalBytes <= maximumSafeBytes && context.totals.allocatedBytes <= maximumSafeBytes;
}
function safeName3(name) {
  return name.length > 0 && name !== "." && name !== ".." && !unsafeEntryName3.test(name);
}
async function closeDirectory(directory) {
  try {
    await directory.close();
    return true;
  } catch {
    return false;
  }
}
async function inspectDirectory(directory, expected, context) {
  if (!validEntry(directory.entry) || !sameEntry2(directory.entry, expected)) {
    return false;
  }
  const remaining = context.limits.scanLimit - context.totals.entryCount;
  const scanned = await directory.scan(remaining);
  if (scanned.truncated || scanned.names.length > remaining) {
    return false;
  }
  const entries = new Map;
  for (const name of scanned.names) {
    if (!safeName3(name) || entries.has(name)) {
      return false;
    }
    const entry = await directory.inspect(name);
    if (entry === undefined || !validEntry(entry)) {
      return false;
    }
    entries.set(name, entry);
    context.totals.entryCount += 1;
    if (!addEntry(entry, context)) {
      return false;
    }
    if (entry.kind === "directory") {
      const key = identity(entry);
      if (context.directoryIdentities.has(key)) {
        return false;
      }
      context.directoryIdentities.add(key);
      const child = await directory.open(name);
      if (child === undefined) {
        return false;
      }
      let childValid = false;
      try {
        childValid = await inspectDirectory(child, entry, context);
      } finally {
        if (!await closeDirectory(child)) {
          childValid = false;
        }
      }
      if (!childValid) {
        return false;
      }
    }
  }
  for (const [name, entry] of entries) {
    const current2 = await directory.inspect(name);
    if (current2 === undefined || !sameEntry2(entry, current2)) {
      return false;
    }
  }
  const current = await directory.stat();
  return current !== undefined && sameEntry2(directory.entry, current);
}
async function inspectWorkspaceUsage(runtime, root, runId, expectedRoot, limits) {
  const totals = {
    logicalBytes: 0n,
    allocatedBytes: 0n,
    entryCount: 0
  };
  try {
    const marker = await verifyMarkedRoot(runtime, root, runId, expectedRoot);
    const rootEntry = await runtime.lstatUsage(root);
    if (rootEntry === undefined || !validEntry(rootEntry) || !rootMatchesMarker(rootEntry, marker)) {
      return unknownUsage(limits, totals);
    }
    const directory = await runtime.openUsageDirectory(root);
    if (directory === undefined) {
      return unknownUsage(limits, totals);
    }
    const context = {
      limits,
      totals,
      measuredIdentities: new Map,
      directoryIdentities: new Set([identity(rootEntry)])
    };
    let valid = false;
    try {
      valid = await inspectDirectory(directory, rootEntry, context);
    } finally {
      if (!await closeDirectory(directory)) {
        valid = false;
      }
    }
    if (!valid) {
      return unknownUsage(limits, totals);
    }
    await verifyMarkedRoot(runtime, root, runId, expectedRoot);
    const logicalBytes = boundedNumber(totals.logicalBytes);
    const allocatedBytes = boundedNumber(totals.allocatedBytes);
    if (logicalBytes === undefined || allocatedBytes === undefined) {
      return unknownUsage(limits, totals);
    }
    const exceeded = logicalBytes > limits.byteLimit || allocatedBytes > limits.byteLimit || totals.entryCount > limits.entryLimit;
    if (exceeded) {
      return report("exceeded", limits, totals);
    }
    return report("within", limits, totals);
  } catch {
    return unknownUsage(limits, totals);
  }
}

// packages/run-workspace/src/lifecycle.ts
var defaultGracefulStopMs = 5000;
var defaultForceStopMs = 5000;
function isAborted(signal) {
  return signal?.aborted === true;
}
function duration(value, fallback, name) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > 300000) {
    throw new RunWorkspaceError("INVALID_OPTION", `${name} must be an integer from 0 to 300000`);
  }
  return selected;
}

class OwnedRunWorkspace {
  signal;
  #runtime;
  #runId;
  #gracefulStopMs;
  #forceStopMs;
  #controller = new AbortController;
  #children = [];
  #forceGate;
  #releaseForceGate;
  #root;
  #marker;
  #state = "open";
  #preserveReason;
  #preservePromise;
  #closePromise;
  #finalReport;
  #removeSignalCoordination;
  #removeExternalAbort;
  #interruptCount = 0;
  constructor(root, marker, runtime, options) {
    this.#root = root;
    this.#marker = marker;
    this.#runtime = runtime;
    this.#runId = marker.runId;
    this.#gracefulStopMs = duration(options.gracefulStopMs, defaultGracefulStopMs, "gracefulStopMs");
    this.#forceStopMs = duration(options.forceStopMs, defaultForceStopMs, "forceStopMs");
    this.signal = this.#controller.signal;
    let releaseForceGate = () => {
      return;
    };
    this.#forceGate = new Promise((resolveGate) => {
      releaseForceGate = resolveGate;
    });
    this.#releaseForceGate = releaseForceGate;
    if (options.handleSignals === true) {
      this.#removeSignalCoordination = coordinateSignals({
        abort: (error) => this.#interrupt(error)
      });
    }
    if (options.signal !== undefined) {
      const externalSignal = options.signal;
      const abort = () => this.#interrupt(new RunWorkspaceAbortedError);
      this.#removeExternalAbort = () => externalSignal.removeEventListener("abort", abort);
      externalSignal.addEventListener("abort", abort, { once: true });
      if (externalSignal.aborted && !this.signal.aborted) {
        this.#interrupt(new RunWorkspaceAbortedError);
      }
    }
  }
  path(...relativeParts) {
    if (this.#state !== "open") {
      throw new RunWorkspaceError("WORKSPACE_CLOSED", "Run workspace is closing or closed");
    }
    for (const part of relativeParts) {
      const segments = part.split(/[\\/]/u);
      if (part.length === 0 || part.includes("\x00") || isAbsolute(part) || win322.isAbsolute(part) || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        throw new RunWorkspaceError("INVALID_PATH", "Run workspace paths must be unambiguous relatives");
      }
    }
    const selected = resolve(this.#root, ...relativeParts);
    const fromRoot = relative(this.#root, selected);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new RunWorkspaceError("INVALID_PATH", "Run workspace path escapes its root");
    }
    return selected;
  }
  inspectUsage(limits) {
    const validated = parseUsageLimits(limits);
    if (validated === undefined) {
      return Promise.resolve(invalidUsage());
    }
    if (this.#state !== "open") {
      return Promise.resolve(unknownUsage(validated));
    }
    return inspectWorkspaceUsage(this.#runtime, this.#root, this.#runId, this.#marker.root, validated);
  }
  registerChild(child) {
    if (this.#state !== "open") {
      throw new RunWorkspaceError("WORKSPACE_CLOSED", "Cannot register a child after close begins");
    }
    if (child.label.trim().length === 0) {
      throw new RunWorkspaceError("INVALID_CHILD", "Owned child label must not be empty");
    }
    if (child.pid !== undefined && (!Number.isSafeInteger(child.pid) || child.pid <= 0)) {
      throw new RunWorkspaceError("INVALID_CHILD", "Owned child pid must be a positive integer");
    }
    this.#children.push(child);
  }
  preserve(reason) {
    if (this.#state !== "open") {
      return Promise.reject(new RunWorkspaceError("WORKSPACE_CLOSED", "Cannot preserve after close begins"));
    }
    const normalized = safeReason(reason);
    if (normalized.length === 0) {
      return Promise.reject(new RunWorkspaceError("INVALID_REASON", "Preservation requires a non-empty reason"));
    }
    if (this.#preservePromise !== undefined)
      return this.#preservePromise;
    const active = this.#publishPreservation(normalized);
    this.#preservePromise = active;
    active.then(() => {
      return;
    }, () => {
      if (this.#preservePromise === active) {
        this.#preservePromise = undefined;
      }
    }).catch(() => {
      return;
    });
    return active;
  }
  async#publishPreservation(normalized) {
    const marker = {
      ...this.#marker,
      state: "preserved",
      reason: normalized
    };
    await verifyMarkedRoot(this.#runtime, this.#root, this.#runId);
    await this.#runtime.writeReplace(markerPath(this.#root), serializeMarker(marker));
    await verifyMarkedRoot(this.#runtime, this.#root, this.#runId);
    this.#marker = marker;
    this.#preserveReason = normalized;
  }
  close() {
    if (this.#finalReport !== undefined)
      return Promise.resolve(this.#finalReport);
    if (this.#closePromise !== undefined)
      return this.#closePromise;
    this.#state = "closing";
    const active = this.#close();
    this.#closePromise = active;
    active.then((report2) => {
      if (report2.state === "cleanup-failed") {
        this.#state = "cleanup-failed";
        this.#closePromise = undefined;
      } else {
        this.#state = "closed";
        this.#finalReport = report2;
        this.#removeSignalCoordination?.();
      }
    }).catch(() => {
      return;
    });
    return active;
  }
  #interrupt(error) {
    this.#interruptCount += 1;
    if (!this.#controller.signal.aborted)
      this.#controller.abort(error);
    if (this.#interruptCount > 1)
      this.#releaseForceGate();
    this.close().catch(() => {
      return;
    });
  }
  async#markFailure(children, error) {
    const marker = {
      ...this.#marker,
      root: this.#root,
      state: "cleanup-failed",
      reason: error
    };
    try {
      await verifyMarkedRoot(this.#runtime, this.#root, this.#runId, this.#marker.root);
      await this.#runtime.writeReplace(markerPath(this.#root), serializeMarker(marker));
      this.#marker = marker;
    } catch {}
    return {
      state: "cleanup-failed",
      runId: this.#runId,
      rootName: basename2(this.#root),
      children,
      error
    };
  }
  async#deleteRoot() {
    const marker = await verifyMarkedRoot(this.#runtime, this.#root, this.#runId, this.#marker.root);
    const source = this.#root;
    const claimed = join5(managedParent(this.#runtime), `reaping-${this.#runId}-${crypto.randomUUID()}`);
    await this.#runtime.rename(source, claimed);
    this.#root = claimed;
    const reapingMarker = {
      ...marker,
      root: claimed,
      state: "reaping"
    };
    await verifyMarkedRoot(this.#runtime, claimed, this.#runId, source);
    await this.#runtime.writeReplace(markerPath(claimed), serializeMarker(reapingMarker));
    this.#marker = reapingMarker;
    await verifyMarkedRoot(this.#runtime, claimed, this.#runId);
    await this.#runtime.removeRoot(claimed);
  }
  async#close() {
    this.#removeExternalAbort?.();
    const preservation = this.#preservePromise;
    const children = await stopChildren({
      children: this.#children,
      runtime: this.#runtime,
      gracefulStopMs: this.#gracefulStopMs,
      forceStopMs: this.#forceStopMs,
      escalation: this.#forceGate
    });
    if (preservation !== undefined) {
      try {
        await preservation;
      } catch {
        return this.#markFailure(children, "CLEANUP_FAILED");
      }
    }
    if (children.some((child) => !child.stopped) && this.#preserveReason !== undefined) {
      return {
        state: "cleanup-failed",
        runId: this.#runId,
        rootName: basename2(this.#root),
        children,
        error: "CHILD_UNCONFIRMED"
      };
    }
    if (children.some((child) => !child.stopped))
      return this.#markFailure(children, "CHILD_UNCONFIRMED");
    if (this.#preserveReason !== undefined) {
      return {
        state: "preserved",
        runId: this.#runId,
        rootName: basename2(this.#root),
        children
      };
    }
    try {
      await this.#deleteRoot();
      return {
        state: "deleted",
        runId: this.#runId,
        rootName: basename2(this.#marker.root),
        children
      };
    } catch {
      return this.#markFailure(children, "CLEANUP_FAILED");
    }
  }
}
async function prepareParent(runtime) {
  const parent = managedParent(runtime);
  await runtime.mkdir(parent, { recursive: true, mode: 448 });
  if (await inspectCanonicalDirectory(runtime, parent) === undefined) {
    throw new RunWorkspaceError("UNSAFE_PARENT", "Managed temporary parent is not a real directory");
  }
  await runtime.chmod(parent, 448);
  if (await inspectPrivateDirectory(runtime, parent) === undefined) {
    throw new RunWorkspaceError("UNSAFE_PARENT", "Managed temporary parent is not owner-private");
  }
  return parent;
}
async function hasInitializationAuthority(runtime, root, marker, markerPublished) {
  if (marker === undefined)
    return false;
  const inspected = await inspectCanonicalDirectory(runtime, root);
  if (inspected === undefined || !sameFileIdentity(inspected.identity, marker.rootIdentity)) {
    return false;
  }
  if (!markerPublished)
    return true;
  const persisted = await readMarker(runtime, root);
  return persisted !== undefined && persisted.runId === marker.runId && persisted.root === root && sameFileIdentity(persisted.rootIdentity, marker.rootIdentity);
}
async function createWithRuntime(options, runtime) {
  if (isAborted(options.signal))
    throw new RunWorkspaceAbortedError;
  const ownerIdentity = await runtime.processIdentity(runtime.pid);
  if (ownerIdentity === undefined) {
    throw new RunWorkspaceError("UNKNOWN_PROCESS_IDENTITY", "Current process start identity is unavailable");
  }
  const parent = await prepareParent(runtime);
  const root = await runtime.mkdtemp(join5(parent, "run-"));
  const runId = crypto.randomUUID();
  let marker;
  let markerPublished = false;
  let workspace;
  try {
    const inspected = await inspectCanonicalDirectory(runtime, root);
    if (inspected === undefined) {
      throw new RunWorkspaceError("UNSAFE_ROOT", "Created run workspace is not a real directory");
    }
    marker = {
      schema: 1,
      runId,
      root,
      rootIdentity: inspected.identity,
      ownerPid: runtime.pid,
      ownerIdentity,
      createdAtMs: runtime.now(),
      state: "open"
    };
    await runtime.writeExclusive(markerPath(root), serializeMarker(marker));
    markerPublished = true;
    await runtime.chmod(root, 448);
    if (await inspectPrivateDirectory(runtime, root) === undefined) {
      throw new RunWorkspaceError("UNSAFE_ROOT", "Created run workspace is not owner-private");
    }
    if (isAborted(options.signal))
      throw new RunWorkspaceAbortedError;
    workspace = new OwnedRunWorkspace(root, marker, runtime, options);
    if (workspace.signal.aborted) {
      const report2 = await workspace.close();
      if (report2.state === "cleanup-failed") {
        throw new RunWorkspaceError("INITIALIZATION_FAILED", "Aborted run workspace cleanup must be retried");
      }
      throw new RunWorkspaceAbortedError;
    }
    return workspace;
  } catch (error) {
    if (workspace !== undefined)
      throw error;
    if (!await hasInitializationAuthority(runtime, root, marker, markerPublished)) {
      throw new RunWorkspaceError("INITIALIZATION_FAILED", "Run workspace initialization cleanup authority was lost", { cause: error });
    }
    try {
      await runtime.removeRoot(root);
    } catch (removalError) {
      if (marker !== undefined && await hasInitializationAuthority(runtime, root, marker, markerPublished)) {
        const failed = {
          ...marker,
          state: "cleanup-failed",
          reason: "INITIALIZATION_FAILED"
        };
        await runtime.writeReplace(markerPath(root), serializeMarker(failed)).catch(() => {
          return;
        });
      }
      throw new RunWorkspaceError("INITIALIZATION_FAILED", "Run workspace initialization failed and cleanup must be retried", { cause: removalError });
    }
    throw error;
  }
}
function create(options = {}) {
  return createWithRuntime(options, systemRuntime());
}
// packages/installer/src/cli-arguments.ts
import { isAbsolute as isAbsolute2, resolve as resolve2 } from "path";
import process4 from "process";
var FLAG_NAMES = {
  "--codex-home": "codexHome",
  "--codex-binary": "codexBinary",
  "--orchestration": "orchestration",
  "--instructions": "instructions",
  "--home": "home",
  "--source-root": "sourceRoot",
  "--transfer": "transfer",
  "--mode": "transfer",
  "--surface": "surface",
  "--dry-run": "dryRun"
};
function usage() {
  console.error("usage: skizzles-installer install --surface <skills|harness> [--codex-home PATH|--home PATH] [--source-root PATH] [--transfer link|copy] [--dry-run] | uninstall --surface <skills|harness> [--codex-home PATH|--home PATH] [--dry-run] | configure --codex-home PATH --codex-binary PATH --orchestration <aggressive|passive> [--instructions <native|skizzles>] [--source-root PATH] [--dry-run] | unconfigure --codex-home PATH --codex-binary PATH [--dry-run] | prompt-policy apply --codex-home PATH --codex-binary ABSOLUTE_PATH --source-root PATH [--dry-run] | prompt-policy restore --codex-home PATH --codex-binary ABSOLUTE_PATH [--dry-run] | doctor --home PATH --codex-home PATH");
  process4.exit(2);
}
function parseInstallerCommand(argv) {
  const remaining = [...argv];
  const command = remaining.shift();
  switch (command) {
    case "install":
      return parseInstall(remaining);
    case "uninstall":
      return parseUninstall(remaining);
    case "doctor":
      return parseDoctor(remaining);
    case "configure":
      return parseConfigure(remaining);
    case "unconfigure":
      return parseUnconfigure(remaining);
    case "prompt-policy":
      return parsePromptPolicy(remaining);
    default:
      return usage();
  }
}
function parseInstall(argv) {
  const flags = parseFlags(argv, allowed("surface", "codexHome", "home", "sourceRoot", "transfer", "dryRun"));
  const surface = parseSurface(required(flags.surface));
  const sourceRoot = resolve2(flags.sourceRoot ?? defaultSourceRoot());
  const transfer = parseTransfer(flags.transfer ?? "link");
  if (surface === "skills") {
    if (flags.home !== undefined) {
      usage();
    }
    return {
      command: "install",
      surface,
      codexHome: resolve2(required(flags.codexHome)),
      sourceRoot,
      transfer,
      dryRun: flags.dryRun
    };
  }
  if (flags.codexHome !== undefined) {
    usage();
  }
  return {
    command: "install",
    surface,
    home: resolve2(required(flags.home)),
    sourceRoot,
    transfer,
    dryRun: flags.dryRun
  };
}
function parseUninstall(argv) {
  const flags = parseFlags(argv, allowed("surface", "codexHome", "home", "dryRun"));
  const surface = parseSurface(required(flags.surface));
  if (surface === "skills") {
    if (flags.home !== undefined) {
      usage();
    }
    return {
      command: "uninstall",
      surface,
      codexHome: resolve2(required(flags.codexHome)),
      dryRun: flags.dryRun
    };
  }
  if (flags.codexHome !== undefined) {
    usage();
  }
  return {
    command: "uninstall",
    surface,
    home: resolve2(required(flags.home)),
    dryRun: flags.dryRun
  };
}
function parseDoctor(argv) {
  const flags = parseFlags(argv, allowed("home", "codexHome"));
  return {
    command: "doctor",
    home: resolve2(required(flags.home)),
    codexHome: resolve2(required(flags.codexHome))
  };
}
function parseConfigure(argv) {
  const flags = parseFlags(argv, allowed("codexHome", "codexBinary", "orchestration", "instructions", "sourceRoot", "dryRun"));
  const instructions = flags.instructions === undefined ? undefined : parseInstructionMode(flags.instructions);
  if (instructions === "skizzles" && flags.sourceRoot === undefined) {
    usage();
  }
  if (instructions !== "skizzles" && flags.sourceRoot !== undefined) {
    usage();
  }
  return {
    command: "configure",
    codexHome: resolve2(required(flags.codexHome)),
    codexBinary: required(flags.codexBinary),
    orchestration: parseOrchestration(required(flags.orchestration)),
    ...instructions === undefined ? {} : { instructions },
    ...flags.sourceRoot === undefined ? {} : { sourceRoot: resolve2(flags.sourceRoot) },
    dryRun: flags.dryRun
  };
}
function parseUnconfigure(argv) {
  const flags = parseFlags(argv, allowed("codexHome", "codexBinary", "dryRun"));
  return {
    command: "unconfigure",
    codexHome: resolve2(required(flags.codexHome)),
    codexBinary: required(flags.codexBinary),
    dryRun: flags.dryRun
  };
}
function parsePromptPolicy(argv) {
  const action = argv.shift();
  if (action === "apply") {
    const flags = parseFlags(argv, allowed("codexHome", "codexBinary", "sourceRoot", "dryRun"));
    return {
      command: "prompt-policy",
      action,
      codexHome: resolve2(required(flags.codexHome)),
      codexBinary: absoluteBinary(required(flags.codexBinary)),
      sourceRoot: resolve2(required(flags.sourceRoot)),
      dryRun: flags.dryRun
    };
  }
  if (action === "restore") {
    const flags = parseFlags(argv, allowed("codexHome", "codexBinary", "dryRun"));
    return {
      command: "prompt-policy",
      action,
      codexHome: resolve2(required(flags.codexHome)),
      codexBinary: absoluteBinary(required(flags.codexBinary)),
      dryRun: flags.dryRun
    };
  }
  return usage();
}
function parseFlags(argv, allowedFlags) {
  const parsed = { dryRun: false };
  const seen = new Set;
  while (argv.length > 0) {
    const spelling = argv.shift();
    const flag = spelling === undefined ? undefined : FLAG_NAMES[spelling];
    if (flag === undefined || !allowedFlags.has(flag) || seen.has(flag)) {
      usage();
    }
    seen.add(flag);
    if (flag === "dryRun") {
      parsed.dryRun = true;
    } else {
      parsed[flag] = required(argv.shift());
    }
  }
  return parsed;
}
function allowed(...flags) {
  return new Set(flags);
}
function required(value) {
  return value ?? usage();
}
function parseSurface(value) {
  if (value === "skills" || value === "harness") {
    return value;
  }
  return usage();
}
function parseTransfer(value) {
  if (value === "link" || value === "copy") {
    return value;
  }
  return usage();
}
function parseOrchestration(value) {
  if (value === "aggressive" || value === "passive") {
    return value;
  }
  return usage();
}
function parseInstructionMode(value) {
  if (value === "native" || value === "skizzles") {
    return value;
  }
  return usage();
}
function absoluteBinary(value) {
  if (!isAbsolute2(value)) {
    usage();
  }
  return value;
}
function defaultSourceRoot() {
  return resolve2(import.meta.dir, "../../..");
}

// packages/installer/src/config.ts
import { existsSync as existsSync3, rmSync as rmSync3 } from "fs";
import { join as join9, resolve as resolve6 } from "path";

// packages/installer/src/codex-config.ts
import { chmodSync as chmodSync4, mkdirSync as mkdirSync4, realpathSync as realpathSync3 } from "fs";
import { join as join8 } from "path";

// packages/installer/src/codex-config/preview.ts
import {
  chmodSync as chmodSync2,
  closeSync,
  constants as constants4,
  fstatSync,
  lstatSync as lstatSync3,
  mkdirSync as mkdirSync2,
  openSync,
  readFileSync as readFileSync2,
  writeFileSync
} from "fs";
import { dirname as dirname2, isAbsolute as isAbsolute4, join as join7, relative as relative2, resolve as resolve5, sep } from "path";

// packages/installer/src/managed-files.ts
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync
} from "fs";
import { join as join6, resolve as resolve3 } from "path";
function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
function copyDirectoryExclusive(source, target, copyEntry = (from, to) => cpSync(from, to, { recursive: true })) {
  mkdirSync(target);
  try {
    chmodSync(target, lstatSync(source).mode & 4095);
    for (const name of readdirSync(source)) {
      if (name === ".DS_Store") {
        continue;
      }
      copyEntry(join6(source, name), join6(target, name));
    }
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
function assertManagedParentsAreReal(rootInput, managedParents) {
  const root = resolve3(rootInput);
  for (const path of [
    root,
    ...managedParents.map((parent) => join6(root, parent))
  ]) {
    if (pathEntryExists(path) && lstatSync(path).isSymbolicLink()) {
      throw new Error(`refusing to manage through a symlinked parent: ${path}`);
    }
  }
}
function sameTree(left, right) {
  if (!(existsSync(left) && existsSync(right))) {
    return false;
  }
  const leftStat = lstatSync(left);
  const rightStat = lstatSync(right);
  if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink()) {
    return false;
  }
  if (leftStat.isDirectory() !== rightStat.isDirectory()) {
    return false;
  }
  if ((leftStat.mode & 4095) !== (rightStat.mode & 4095)) {
    return false;
  }
  if (leftStat.isDirectory()) {
    const leftNames = readdirSync(left).filter((name) => name !== ".DS_Store").sort();
    const rightNames = readdirSync(right).filter((name) => name !== ".DS_Store").sort();
    if (leftNames.join("\x00") !== rightNames.join("\x00")) {
      return false;
    }
    return leftNames.every((name) => sameTree(join6(left, name), join6(right, name)));
  }
  return readFileSync(left).equals(readFileSync(right));
}
function rollbackStagedMoves(moved) {
  for (const item of [...moved].reverse()) {
    if (pathEntryExists(item.to) && !pathEntryExists(item.from)) {
      renameSync(item.to, item.from);
    }
  }
}

// packages/installer/src/codex-config/rpc.ts
import { mkdir as mkdir2 } from "fs/promises";
import processRuntime from "process";

// packages/installer/src/codex-config/supervisor.ts
import process5 from "process";
var EXIT_TIMEOUT_MS = 2000;
var POLL_MS = 10;
var SOURCE = String.raw`
process.on("SIGTERM", () => undefined);
const command = JSON.parse(Bun.argv[1]);
const publish = (value) => process.send?.(value);
try {
  const tool = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  publish({ type: "ready" });
  tool.exited.then(
    (exitCode) => publish({ type: "exited", exitCode }),
    () => publish({ type: "tool-error" }),
  );
} catch {
  publish({ type: "spawn-error" });
}
setInterval(() => undefined, 2147483647);
`;
function spawnRpcSupervisor(command, environment) {
  let state = "pending";
  let protocolFailure;
  let child;
  child = Bun.spawn([process5.execPath, "--eval", SOURCE, JSON.stringify(command)], {
    env: environment,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
    ipc(message) {
      const next = protocolMessage(message, state);
      if (next instanceof Error) {
        protocolFailure ??= next;
      } else {
        state = next;
      }
    }
  });
  const waitFor = async (accepted, timeoutMs) => {
    const deadline2 = Date.now() + timeoutMs;
    while (Date.now() < deadline2) {
      if (protocolFailure !== undefined)
        throw protocolFailure;
      if (accepted.has(state))
        return state;
      const event = await Promise.race([
        child.exited.then(() => "exited"),
        Bun.sleep(POLL_MS).then(() => "pending")
      ]);
      if (event === "exited")
        throw new Error("Codex app-server supervisor exited unexpectedly");
    }
    return;
  };
  return {
    process: child,
    scope: supervisorScope(child),
    waitUntilReady: async () => {
      const result = await waitFor(new Set(["ready", "exited", "spawn-error", "tool-error"]), EXIT_TIMEOUT_MS);
      if (result !== "ready") {
        throw new Error("Codex app-server could not start");
      }
    },
    waitForToolExit: async (timeoutMs) => await waitFor(new Set(["exited", "spawn-error", "tool-error"]), timeoutMs) === "exited"
  };
}
function protocolMessage(value, current) {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return new Error("Codex app-server supervisor protocol is invalid");
  }
  const keys = Object.keys(value);
  if (value.type === "ready" && keys.length === 1 && current === "pending")
    return "ready";
  if (value.type === "exited" && keys.length === 2 && "exitCode" in value && Number.isSafeInteger(value.exitCode) && current === "ready")
    return "exited";
  if ((value.type === "spawn-error" || value.type === "tool-error") && keys.length === 1)
    return value.type;
  return new Error("Codex app-server supervisor protocol is invalid");
}
function supervisorScope(child) {
  const signal = (value) => {
    signalOwnedSupervisor(child.exitCode !== null, child.pid, value);
  };
  return {
    label: "Codex app-server supervisor",
    pid: child.pid,
    requestStop: () => signal("SIGTERM"),
    forceStop: () => signal("SIGKILL"),
    waitForExit: async () => {
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(EXIT_TIMEOUT_MS).then(() => false)
      ]);
      if (!exited)
        throw new Error("Codex app-server supervisor did not exit");
      const deadline2 = Date.now() + EXIT_TIMEOUT_MS;
      while (Date.now() < deadline2) {
        try {
          process5.kill(-child.pid, 0);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ESRCH")
            return;
          if (!(error instanceof Error && ("code" in error) && error.code === "EPERM"))
            throw error;
        }
        await Bun.sleep(POLL_MS);
      }
      throw new Error("Codex app-server process scope exit could not be verified");
    }
  };
}
function signalOwnedSupervisor(supervisorExited, pid, signal, kill = process5.kill) {
  if (supervisorExited)
    return false;
  try {
    kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

// packages/installer/src/codex-config/rpc.ts
var CONFIG_WRITE_ERROR_CODES = new Set([
  "configLayerReadonly",
  "configVersionConflict",
  "configValidationError",
  "configPathNotFound",
  "configSchemaUnknownKey",
  "userLayerNotFound"
]);
var SAFE_METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_./-]{0,63}$/u;

class ConfigRpcError extends Error {
  kind;
  code;
  constructor(kind, message, code, options) {
    super(message, options);
    this.name = "ConfigRpcError";
    this.kind = kind;
    this.code = code;
  }
}
function isConfigVersionConflict(error) {
  return error instanceof ConfigRpcError && error.kind === "conflict";
}
function safeConfigWriteError(error) {
  if (isConfigVersionConflict(error)) {
    return new ConfigRpcError("conflict", "Codex config version conflict; no config write was committed", "configVersionConflict");
  }
  if (error instanceof ConfigRpcError) {
    return error;
  }
  return new ConfigRpcError("transport", "Codex config write outcome is ambiguous; pending recovery evidence was retained");
}

class AppServerRpc {
  process;
  supervisor;
  nextId = 1;
  pending = new Map;
  constructor(supervisor) {
    this.supervisor = supervisor;
    this.process = supervisor.process;
  }
  static async create(codexHome, codexBinary, workspace) {
    assertAppServerPlatform(processRuntime.platform);
    const processTemp = workspace.path("process-temp", "codex-app-server");
    await mkdir2(processTemp, { recursive: true, mode: 448 });
    const supervisor = spawnRpcSupervisor([codexBinary, "app-server"], {
      ...Bun.env,
      CODEX_HOME: codexHome,
      TEMP: processTemp,
      TMP: processTemp,
      TMPDIR: processTemp
    });
    const rpc = new AppServerRpc(supervisor);
    try {
      workspace.registerChild(supervisor.scope);
    } catch (error) {
      await supervisor.scope.forceStop();
      await supervisor.scope.waitForExit();
      throw error;
    }
    rpc.consumeStdout();
    rpc.consumeStderr();
    try {
      await supervisor.waitUntilReady();
      await rpc.request("initialize", {
        clientInfo: {
          name: "skizzles_installer",
          title: "Skizzles Installer",
          version: "0.1.0"
        },
        capabilities: { experimentalApi: true }
      });
      rpc.send({ method: "initialized" });
      return rpc;
    } catch (error) {
      try {
        await rpc.close();
      } catch (cleanup) {
        throw new ConfigRpcError("transport", "Codex app-server cleanup failed after startup failure", undefined, { cause: new AggregateError([cleanup, error]) });
      }
      throw error;
    }
  }
  async read() {
    return parseConfigReadResponse(await this.request("config/read", { includeLayers: true, cwd: null }));
  }
  async batchWrite(params) {
    return parseConfigWriteResponse(await this.request("config/batchWrite", params));
  }
  async close() {
    this.process.stdin.end();
    if (!await this.supervisor.waitForToolExit(2000)) {
      await this.supervisor.scope.requestStop();
      await Bun.sleep(100);
    }
    await this.supervisor.scope.forceStop();
    await this.supervisor.scope.waitForExit();
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new ConfigRpcError("transport", `Codex app-server request timed out (${safeMethodName(method)})`));
      }, 15000);
      this.pending.set(id, { resolve: resolvePromise, reject, timeout });
      this.send({ method, id, params });
    });
  }
  send(message) {
    this.process.stdin.write(`${JSON.stringify(message)}
`);
    this.process.stdin.flush();
  }
  async consumeStdout() {
    const reader = this.process.stdout.getReader();
    const decoder2 = new TextDecoder;
    let buffered = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder2.decode(value, { stream: true });
      const lines = buffered.split(`
`);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        this.receive(line);
      }
    }
    const error = new ConfigRpcError("transport", "Codex app-server closed unexpectedly");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
  receive(line) {
    if (!line.trim()) {
      return;
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (!isPlainObject(value) || typeof value["id"] !== "number") {
      return;
    }
    const id = value["id"];
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    const protocolError = value["error"];
    if (isPlainObject(protocolError)) {
      pending.reject(classifyProtocolError(protocolError));
    } else {
      pending.resolve(value["result"]);
    }
  }
  async consumeStderr() {
    const reader = this.process.stderr.getReader();
    const decoder2 = new TextDecoder;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      decoder2.decode(value, { stream: true });
    }
  }
}
function assertAppServerPlatform(platform) {
  if (platform === "win32") {
    throw new ConfigRpcError("transport", "Codex app-server process scopes require Windows Job Object support");
  }
}
function classifyProtocolError(error) {
  const safeCode = configWriteErrorCode(error.data);
  if (safeCode === "configVersionConflict") {
    return new ConfigRpcError("conflict", "Codex config version conflict; no config write was committed", "configVersionConflict");
  }
  return new ConfigRpcError("protocol", safeCode ? `Codex app-server rejected the request (${safeCode})` : "Codex app-server rejected the request", safeCode);
}
function configWriteErrorCode(data) {
  if (!isPlainObject(data)) {
    return;
  }
  const value = data["config_write_error_code"];
  return typeof value === "string" && CONFIG_WRITE_ERROR_CODES.has(value) ? value : undefined;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseConfigReadResponse(value) {
  if (!isPlainObject(value)) {
    throw invalidConfigResponse();
  }
  const layersValue = value["layers"];
  if (layersValue !== null && !Array.isArray(layersValue)) {
    throw invalidConfigResponse();
  }
  const layers = layersValue === null ? null : layersValue.map(parseConfigLayerResponse);
  const configValue = value["config"];
  if (configValue === undefined) {
    return { layers };
  }
  if (!isJsonValue(configValue)) {
    throw invalidConfigResponse();
  }
  return { config: configValue, layers };
}
function parseConfigLayerResponse(value) {
  if (!(isPlainObject(value) && isPlainObject(value["name"]))) {
    throw invalidConfigResponse();
  }
  const nameValue = value["name"];
  const type = nameValue["type"];
  const file = nameValue["file"];
  const profile = nameValue["profile"];
  const version = value["version"];
  const config = value["config"];
  if (typeof type !== "string" || file !== undefined && typeof file !== "string" || profile !== undefined && profile !== null && typeof profile !== "string" || typeof version !== "string" || !isJsonValue(config)) {
    throw invalidConfigResponse();
  }
  const name = { type };
  if (typeof file === "string") {
    name.file = file;
  }
  if (profile === null || typeof profile === "string") {
    name.profile = profile;
  }
  return { name, version, config };
}
function parseConfigWriteResponse(value) {
  if (!isPlainObject(value) || typeof value["status"] !== "string" || typeof value["version"] !== "string" || typeof value["filePath"] !== "string") {
    throw invalidConfigResponse();
  }
  return {
    status: value["status"],
    version: value["version"],
    filePath: value["filePath"]
  };
}
function isJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}
function invalidConfigResponse() {
  return new ConfigRpcError("protocol", "Codex app-server returned an invalid config response");
}
function safeMethodName(method) {
  return SAFE_METHOD_PATTERN.test(method) ? method : "unknown method";
}

// packages/installer/src/codex-config/values.ts
import { existsSync as existsSync2, lstatSync as lstatSync2, realpathSync as realpathSync2 } from "fs";
import { isAbsolute as isAbsolute3, resolve as resolve4 } from "path";
function canonicalExistingPath(path) {
  const absolute = resolve4(path);
  return existsSync2(absolute) ? realpathSync2(absolute) : absolute;
}
function validateCodexBinary(codexBinary) {
  if (!isAbsolute3(codexBinary)) {
    throw new Error("--codex-binary must be an absolute path");
  }
  const binary = resolve4(codexBinary);
  if (!existsSync2(binary)) {
    throw new Error(`Codex binary is missing: ${binary}`);
  }
  const metadata = lstatSync2(binary);
  if (!(metadata.isFile() || metadata.isSymbolicLink())) {
    throw new Error(`Codex binary is not a file: ${binary}`);
  }
  return binary;
}
function configValueAt(root, keyPath) {
  let current = root;
  for (const segment of keyPath.split(".")) {
    if (current === null || Array.isArray(current) || typeof current !== "object" || !(segment in current)) {
      return { present: false, value: null };
    }
    const next = current[segment];
    if (next === undefined) {
      return { present: false, value: null };
    }
    current = next;
  }
  return { present: true, value: current };
}
function sameConfigValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function selectedUserLayer(read, configPath) {
  const expected = canonicalExistingPath(configPath);
  const layer = read.layers?.find(({ name }) => name.type === "user" && name.profile === null && name.file !== undefined && canonicalExistingPath(name.file) === expected);
  if (!layer) {
    throw new Error(`Codex did not report the selected user config layer: ${expected}`);
  }
  return layer;
}
function snapshotConfigValues(config, edits) {
  return edits.map(({ keyPath, value }) => {
    const before = configValueAt(config, keyPath);
    return {
      keyPath,
      beforePresent: before.present,
      before: before.value,
      after: value
    };
  });
}
function valuesMatchBefore(config, values) {
  return values.every(({ keyPath, beforePresent, before }) => {
    const current = configValueAt(config, keyPath);
    return current.present === beforePresent && (!beforePresent || sameConfigValue(current.value, before));
  });
}
function valuesMatchAfter(config, values) {
  return values.every(({ keyPath, after }) => {
    const current = configValueAt(config, keyPath);
    return current.present && sameConfigValue(current.value, after);
  });
}
function restoreConfigEdits(values) {
  return values.map(({ keyPath, beforePresent, before }) => ({
    keyPath,
    value: beforePresent ? before : null,
    mergeStrategy: "replace"
  }));
}

// packages/installer/src/codex-config/preview.ts
var PREVIEW_PROMPT_FILE_KEYS = [
  "model_instructions_file",
  "experimental_compact_prompt_file",
  "model_catalog_json"
];
var PREVIEW_NESTED_TOML_KEYS = new Set(["config_file"]);
var MAX_PREVIEW_FILE_BYTES = 16 * 1024 * 1024;
var MAX_PREVIEW_TOTAL_BYTES = 64 * 1024 * 1024;
var MAX_PREVIEW_REFERENCED_FILES = 256;
var MAX_PREVIEW_NESTED_CONFIG_DEPTH = 16;
function snapshotStat(stat) {
  const mtimeNs = statNanoseconds(stat.mtimeNs, stat.mtimeMs);
  const ctimeNs = statNanoseconds(stat.ctimeNs, stat.ctimeMs);
  return {
    path: "",
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs,
    ctimeNs
  };
}
function statNanoseconds(nanoseconds, milliseconds) {
  if (nanoseconds !== undefined) {
    return nanoseconds;
  }
  return typeof milliseconds === "bigint" ? milliseconds * 1000000n : BigInt(Math.round(milliseconds * 1e6));
}
function createConfigPreviewSnapshot(selectedHome, previewHome) {
  const configPath = join7(selectedHome, "config.toml");
  if (!pathEntryExists(configPath)) {
    return;
  }
  const configBytes = copyPrivateSnapshotFile(selectedHome, configPath, join7(previewHome, "config.toml"), "selected Codex config", MAX_PREVIEW_TOTAL_BYTES);
  const budget = {
    bytes: configBytes,
    copied: new Set([canonicalExistingPath(configPath)]),
    referencedFiles: 0
  };
  copyRelativeConfigInputs(configPath, selectedHome, previewHome, budget, 0);
}
function copyRelativeConfigInputs(documentPath, selectedHome, previewHome, budget, depth) {
  const contents = readFileSync2(join7(previewHome, safeSnapshotRelativePath(selectedHome, documentPath)), "utf8");
  let parsed;
  try {
    parsed = Bun.TOML.parse(contents);
  } catch {
    return;
  }
  for (const reference of configFileReferences(parsed)) {
    if (isAbsolute4(reference.value) || isHomeRelative(reference.value)) {
      continue;
    }
    const source = resolve5(dirname2(documentPath), reference.value);
    const relativePath = safeSnapshotRelativePath(selectedHome, source);
    const sourceKey = canonicalExistingPath(source);
    if (budget.copied.has(sourceKey)) {
      continue;
    }
    if (budget.referencedFiles >= MAX_PREVIEW_REFERENCED_FILES) {
      throw new Error("dry-run snapshot referenced-file limit exceeded");
    }
    if (PREVIEW_NESTED_TOML_KEYS.has(reference.key) && depth >= MAX_PREVIEW_NESTED_CONFIG_DEPTH) {
      throw new Error("dry-run snapshot nested-config depth limit exceeded");
    }
    budget.referencedFiles += 1;
    const destination = join7(previewHome, relativePath);
    const copiedBytes = copyPrivateSnapshotFile(selectedHome, source, destination, reference.key, Math.min(MAX_PREVIEW_FILE_BYTES, MAX_PREVIEW_TOTAL_BYTES - budget.bytes));
    budget.bytes += copiedBytes;
    budget.copied.add(sourceKey);
    if (PREVIEW_NESTED_TOML_KEYS.has(reference.key)) {
      copyRelativeConfigInputs(source, selectedHome, previewHome, budget, depth + 1);
    }
  }
}
function configFileReferences(value) {
  const references = [];
  if (!isPlainObject2(value)) {
    return references;
  }
  addPromptFileReferences(value, references);
  const profiles = value["profiles"];
  if (isPlainObject2(profiles)) {
    for (const profile of Object.values(profiles)) {
      if (isPlainObject2(profile)) {
        addPromptFileReferences(profile, references);
      }
    }
  }
  const agents = value["agents"];
  if (isPlainObject2(agents)) {
    for (const agent of Object.values(agents)) {
      if (isPlainObject2(agent) && typeof agent["config_file"] === "string") {
        references.push({ key: "config_file", value: agent["config_file"] });
      }
    }
  }
  return references;
}
function addPromptFileReferences(config, references) {
  for (const key of PREVIEW_PROMPT_FILE_KEYS) {
    const value = config[key];
    if (typeof value === "string") {
      references.push({ key, value });
    }
  }
}
function snapshotSourceIdentities(selectedHome, source, label) {
  const relativePath = safeSnapshotRelativePath(selectedHome, source);
  const identities = [];
  let current = selectedHome;
  for (const segment of ["", ...relativePath.split(sep)]) {
    if (segment) {
      current = join7(current, segment);
    }
    let metadata;
    try {
      metadata = lstatSync3(current, { bigint: true });
    } catch {
      throw new Error(`${label} is missing from the selected Codex home`);
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} may not traverse a symlink`);
    }
    const identity2 = snapshotStat(metadata);
    identities.push({ ...identity2, path: current });
  }
  if (!lstatSync3(source, { bigint: true }).isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  return identities;
}
function safeSnapshotRelativePath(selectedHome, source) {
  const relativePath = relative2(selectedHome, source);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute4(relativePath)) {
    throw new Error("selected Codex config-relative input escapes the selected home");
  }
  return relativePath;
}
function copyPrivateSnapshotFile(selectedHome, source, destination, label, maxBytes) {
  const identities = snapshotSourceIdentities(selectedHome, source, label);
  const expectedFile = identities.at(-1);
  if (!expectedFile) {
    throw new Error("config snapshot identity is empty");
  }
  const descriptor = openSync(source, constants4.O_RDONLY | constants4.O_NOFOLLOW);
  let bytes;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assertSnapshotStat(opened, expectedFile, label);
    if (opened.size > BigInt(maxBytes)) {
      throw new Error("selected Codex config-relative input exceeds the dry-run snapshot limit");
    }
    assertSnapshotIdentities(identities, label);
    bytes = readFileSync2(descriptor);
    const rereadDescriptor = openSync(source, constants4.O_RDONLY | constants4.O_NOFOLLOW);
    try {
      const rereadStat = fstatSync(rereadDescriptor, { bigint: true });
      assertSnapshotStat(rereadStat, expectedFile, label);
      const reread = readFileSync2(rereadDescriptor);
      if (!reread.equals(bytes)) {
        throw new Error(`${label} changed during dry-run snapshot`);
      }
    } finally {
      closeSync(rereadDescriptor);
    }
    assertSnapshotIdentities(identities, label);
  } finally {
    closeSync(descriptor);
  }
  mkdirSync2(dirname2(destination), { recursive: true, mode: 448 });
  chmodSync2(dirname2(destination), 448);
  writeFileSync(destination, bytes, { flag: "wx", mode: 384 });
  chmodSync2(destination, 384);
  return bytes.byteLength;
}
function metadataNanoseconds(stat, field) {
  const ns = field === "mtime" ? stat.mtimeNs : stat.ctimeNs;
  const ms = field === "mtime" ? stat.mtimeMs : stat.ctimeMs;
  return statNanoseconds(ns, ms);
}
function assertSnapshotStat(actual, expected, label) {
  if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size || metadataNanoseconds(actual, "mtime") !== expected.mtimeNs || metadataNanoseconds(actual, "ctime") !== expected.ctimeNs) {
    throw new Error(`${label} changed during dry-run snapshot`);
  }
}
function assertSnapshotIdentities(identities, label) {
  for (const expected of identities) {
    let actual;
    try {
      actual = lstatSync3(expected.path, { bigint: true });
    } catch {
      throw new Error(`${label} changed during dry-run snapshot`);
    }
    if (actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size || metadataNanoseconds(actual, "mtime") !== expected.mtimeNs || metadataNanoseconds(actual, "ctime") !== expected.ctimeNs) {
      throw new Error(`${label} changed during dry-run snapshot`);
    }
  }
}
function isHomeRelative(path) {
  return path === "~" || path.startsWith(`~${sep}`) || path.startsWith("~/");
}

class PreviewConfigRpc {
  inner;
  previewHome;
  selectedHome;
  constructor(inner, previewHome, selectedHome) {
    this.inner = inner;
    this.previewHome = previewHome;
    this.selectedHome = selectedHome;
  }
  async read() {
    const read = await this.inner.read();
    return parseConfigReadResponse(remapPreviewValue(read, this.previewHome, this.selectedHome));
  }
  batchWrite(_params) {
    return Promise.reject(new ConfigRpcError("transport", "dry-run preview may not write Codex configuration"));
  }
  close() {
    return this.inner.close();
  }
}
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function remapPreviewValue(value, previewHome, selectedHome) {
  if (typeof value === "string") {
    if (value === previewHome) {
      return selectedHome;
    }
    if (value.startsWith(`${previewHome}${sep}`)) {
      return join7(selectedHome, relative2(previewHome, value));
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => remapPreviewValue(item, previewHome, selectedHome));
  }
  if (!isPlainObject2(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    remapPreviewValue(child, previewHome, selectedHome)
  ]));
}

// packages/installer/src/codex-config/private-files.ts
import {
  chmodSync as chmodSync3,
  lstatSync as lstatSync4,
  mkdirSync as mkdirSync3,
  readFileSync as readFileSync3,
  renameSync as renameSync2,
  rmSync as rmSync2,
  writeFileSync as writeFileSync2
} from "fs";
import { dirname as dirname3 } from "path";
function ensurePrivateDirectory(path) {
  if (pathEntryExists(path) && lstatSync4(path).isSymbolicLink()) {
    throw new Error(`refusing to manage through a symlinked directory: ${path}`);
  }
  mkdirSync3(path, { recursive: true, mode: 448 });
  chmodSync3(path, 448);
}
function writePrivateJson(path, value, exclusive = false) {
  ensurePrivateDirectory(dirname3(path));
  const contents = `${JSON.stringify(value, null, 2)}
`;
  if (exclusive) {
    writeFileSync2(path, contents, { flag: "wx", mode: 384 });
    chmodSync3(path, 384);
    return;
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync2(temporary, contents, { flag: "wx", mode: 384 });
  try {
    chmodSync3(temporary, 384);
    renameSync2(temporary, path);
    chmodSync3(path, 384);
  } catch (error) {
    rmSync2(temporary, { force: true });
    throw error;
  }
}
function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync3(path, "utf8"));
  } catch {
    throw new Error(`invalid ${label}: ${path}`);
  }
}

// packages/installer/src/codex-config.ts
async function openConfigRpcSession(options) {
  const selectedHome = canonicalExistingPath(options.codexHome);
  const configPath = join8(selectedHome, "config.toml");
  const owned = options.workspace === undefined && options.rpcFactory === undefined ? await createOwnedWorkspace() : undefined;
  const workspace = options.workspace ?? owned;
  if (!options.dryRun || options.rpcFactory) {
    try {
      const rpc = options.rpcFactory ? await options.rpcFactory(selectedHome, options.codexBinary) : await AppServerRpc.create(selectedHome, options.codexBinary, requiredWorkspace(workspace));
      return {
        rpc,
        configPath,
        cleanup: () => closeOwnedWorkspace(owned)
      };
    } catch (error) {
      await closeOwnedWorkspace(owned, { error });
      throw error;
    }
  }
  try {
    const previewPath = requiredWorkspace(workspace).path("config-preview");
    mkdirSync4(previewPath, { recursive: true, mode: 448 });
    const previewHome = realpathSync3(previewPath);
    chmodSync4(previewHome, 448);
    createConfigPreviewSnapshot(selectedHome, previewHome);
    const inner = await AppServerRpc.create(previewHome, options.codexBinary, requiredWorkspace(workspace));
    return {
      rpc: new PreviewConfigRpc(inner, previewHome, selectedHome),
      configPath,
      cleanup: () => closeOwnedWorkspace(owned)
    };
  } catch (error) {
    await closeOwnedWorkspace(owned, { error });
    throw error;
  }
}
function requiredWorkspace(workspace) {
  if (workspace === undefined) {
    throw new Error("installer operation requires a run workspace");
  }
  return workspace;
}
async function createOwnedWorkspace() {
  const stale = await cleanupStale();
  if (stale.failed.length > 0 || stale.truncated) {
    throw new Error("installer stale workspace cleanup failed");
  }
  return await create();
}
async function closeOwnedWorkspace(workspace, operation) {
  if (workspace === undefined)
    return;
  let report2;
  try {
    report2 = await workspace.close();
  } catch (cleanup) {
    throw new Error("installer temporary cleanup failed", {
      cause: operation === undefined ? cleanup : new AggregateError([cleanup, operation.error], "workspace cleanup and config RPC acquisition both failed")
    });
  }
  if (report2.state === "cleanup-failed") {
    const cleanup = new Error(`installer temporary cleanup failed: ${report2.error ?? "CLEANUP_FAILED"}`);
    throw new Error(cleanup.message, {
      cause: operation === undefined ? cleanup : new AggregateError([cleanup, operation.error], "workspace cleanup and config RPC acquisition both failed")
    });
  }
}

// packages/installer/src/config.ts
var aggressiveModeHint = "Proactive complexity-aware delegation is active. Follow $fourth-wall whenever orchestration would materially improve speed or quality.";
var rootHint = "Fourth Wall applies. Read and follow $fourth-wall before this task's first orchestration action.";
var subagentHint = "Fourth Wall applies. Read and follow $fourth-wall and the behavioral role resource named in your assignment.";
var agentDescriptions = {
  default: "General Skizzles subagent with a compact developer-focused execution contract.",
  triage: "Focused read-only codebase research, diagnosis, and current-shape mapping.",
  worker: "Bounded implementation ownership through focused validation and evidence.",
  designer: "Frontend and product UI implementation with visual and accessibility proof.",
  qa: "Runtime piloting and evidence-rich product verification without silent fixes.",
  review: "Independent adversarial review, verification, and acceptance assessment.",
  deployment: "Authorized deployment and production-adjacent procedures with rollback discipline."
};
var agentRoles = [
  "default",
  "triage",
  "worker",
  "designer",
  "qa",
  "review",
  "deployment"
];
function resolveInstructionAssets(sourceRootInput) {
  const sourceRoot = canonicalExistingPath(sourceRootInput);
  const rootInstructions = join9(sourceRoot, "assets", "skizzles_instructions.md");
  const subagentInstructions = join9(sourceRoot, "assets", "skizzles_subagent_instructions.md");
  const agentConfigs = {
    default: join9(sourceRoot, "assets", "agents/default.toml"),
    triage: join9(sourceRoot, "assets", "agents/triage.toml"),
    worker: join9(sourceRoot, "assets", "agents/worker.toml"),
    designer: join9(sourceRoot, "assets", "agents/designer.toml"),
    qa: join9(sourceRoot, "assets", "agents/qa.toml"),
    review: join9(sourceRoot, "assets", "agents/review.toml"),
    deployment: join9(sourceRoot, "assets", "agents/deployment.toml")
  };
  const required2 = [
    rootInstructions,
    subagentInstructions,
    ...Object.values(agentConfigs)
  ];
  if (required2.some((path) => !existsSync3(path))) {
    throw new Error("Skizzles instruction assets are incomplete");
  }
  return Object.freeze({
    sourceRoot,
    rootInstructions,
    agentConfigs: Object.freeze(agentConfigs)
  });
}
function configReceiptPath(codexHome) {
  return join9(canonicalExistingPath(codexHome), ".skizzles", "config-receipt.json");
}
function desiredConfigEdits(orchestration, instructionAssets, currentConfig = {}) {
  const edits = [
    { keyPath: "features.hooks", value: true, mergeStrategy: "replace" }
  ];
  if (instructionAssets !== undefined) {
    edits.push({
      keyPath: "model_instructions_file",
      value: instructionAssets.rootInstructions,
      mergeStrategy: "replace"
    });
    const configuredRoles = {};
    for (const role of agentRoles) {
      configuredRoles[role] = {
        description: agentDescriptions[role],
        config_file: instructionAssets.agentConfigs[role]
      };
    }
    const agents = configValueAt(currentConfig, "agents");
    if (!agents.present || !isJsonObject(agents.value)) {
      edits.push({
        keyPath: "agents",
        value: configuredRoles,
        mergeStrategy: "replace"
      });
    } else {
      for (const role of agentRoles) {
        const roleConfig = {
          description: agentDescriptions[role],
          config_file: instructionAssets.agentConfigs[role]
        };
        const existing = configValueAt(agents.value, role);
        if (!existing.present || !isJsonObject(existing.value)) {
          edits.push({
            keyPath: `agents.${role}`,
            value: roleConfig,
            mergeStrategy: "replace"
          });
        } else {
          edits.push({
            keyPath: `agents.${role}.description`,
            value: agentDescriptions[role],
            mergeStrategy: "replace"
          }, {
            keyPath: `agents.${role}.config_file`,
            value: instructionAssets.agentConfigs[role],
            mergeStrategy: "replace"
          });
        }
      }
    }
  }
  if (orchestration === "aggressive") {
    edits.push({
      keyPath: "features.multi_agent_v2.enabled",
      value: true,
      mergeStrategy: "replace"
    }, {
      keyPath: "features.multi_agent_v2.max_concurrent_threads_per_session",
      value: 7,
      mergeStrategy: "replace"
    }, {
      keyPath: "features.multi_agent_v2.multi_agent_mode_hint_text",
      value: aggressiveModeHint,
      mergeStrategy: "replace"
    }, {
      keyPath: "features.multi_agent_v2.root_agent_usage_hint_text",
      value: rootHint,
      mergeStrategy: "replace"
    }, {
      keyPath: "features.multi_agent_v2.subagent_usage_hint_text",
      value: subagentHint,
      mergeStrategy: "replace"
    });
  }
  return edits;
}
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readReceipt(codexHome) {
  const path = configReceiptPath(codexHome);
  if (!existsSync3(path)) {
    throw new Error(`Skizzles config receipt is missing: ${path}`);
  }
  const parsed = readJsonFile(path, "Skizzles config receipt");
  const receipt = objectValue(parsed);
  if (receipt?.["version"] !== 1 || !isReceiptState(receipt["state"]) || !isOrchestrationMode(receipt["orchestration"]) || typeof receipt["codexBinary"] !== "string" || typeof receipt["configPath"] !== "string" || !Array.isArray(receipt["values"])) {
    throw new Error(`invalid Skizzles config receipt: ${path}`);
  }
  const values = receipt["values"].map((value) => {
    const owned = objectValue(value);
    if (typeof owned?.["keyPath"] !== "string" || typeof owned["beforePresent"] !== "boolean" || !isJsonValue2(owned["before"]) || !isJsonValue2(owned["after"])) {
      throw new Error(`invalid Skizzles config receipt: ${path}`);
    }
    return {
      keyPath: owned["keyPath"],
      beforePresent: owned["beforePresent"],
      before: owned["before"],
      after: owned["after"]
    };
  });
  const instructions = receipt["instructions"];
  if (instructions !== undefined && !isInstructionMode(instructions)) {
    throw new Error(`invalid Skizzles config receipt: ${path}`);
  }
  const sourceRoot = receipt["sourceRoot"];
  if (sourceRoot !== undefined && typeof sourceRoot !== "string") {
    throw new Error(`invalid Skizzles config receipt: ${path}`);
  }
  return {
    version: 1,
    state: receipt["state"],
    orchestration: receipt["orchestration"],
    ...instructions === undefined ? {} : { instructions },
    ...sourceRoot === undefined ? {} : { sourceRoot },
    codexBinary: receipt["codexBinary"],
    configPath: receipt["configPath"],
    values
  };
}
function isReceiptState(value) {
  return value === "pending" || value === "active" || value === "restoring";
}
function isOrchestrationMode(value) {
  return value === "aggressive" || value === "passive";
}
function isInstructionMode(value) {
  return value === "native" || value === "skizzles";
}
function objectValue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}
function isJsonValue2(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue2);
  }
  const object = objectValue(value);
  return object !== undefined && Object.values(object).every(isJsonValue2);
}
function validateReceiptTarget(receipt, codexHome, codexBinary) {
  if (resolve6(receipt.codexBinary) !== codexBinary) {
    throw new Error(`use the Codex binary recorded by the config receipt: ${receipt.codexBinary}`);
  }
  if (resolve6(receipt.configPath) !== join9(codexHome, "config.toml")) {
    throw new Error("config receipt points outside the selected CODEX_HOME");
  }
}
function receiptConfigEdits(receipt) {
  return receipt.values.map(({ keyPath, after }) => ({
    keyPath,
    value: after,
    mergeStrategy: "replace"
  }));
}
function pendingConfigureReceipt(receiptPath, codexHome, codexBinary, orchestration) {
  if (!pathEntryExists(receiptPath)) {
    return;
  }
  const receipt = readReceipt(codexHome);
  validateReceiptTarget(receipt, codexHome, codexBinary);
  if (receipt.state === "active") {
    throw new Error(`Skizzles config receipt already exists: ${receiptPath}`);
  }
  if (receipt.state === "restoring") {
    throw new Error("Skizzles config restoration is pending; run unconfigure before configuring again");
  }
  if (receipt.orchestration !== orchestration) {
    throw new Error("pending config recovery uses a different orchestration mode; use the recorded mode or run unconfigure");
  }
  return receipt;
}
async function writeConfigBatch(rpc, edits, filePath, expectedVersion, conflictReceiptPath) {
  try {
    await rpc.batchWrite({
      edits,
      filePath,
      expectedVersion,
      reloadUserConfig: true
    });
  } catch (error) {
    if (conflictReceiptPath && isConfigVersionConflict(error)) {
      rmSync3(conflictReceiptPath, { force: true });
    }
    throw safeConfigWriteError(error);
  }
}
async function recoverPendingConfigure(receipt, receiptPath, config, expectedVersion, rpc, dryRun) {
  const atAfter = valuesMatchAfter(config, receipt.values);
  const atBefore = valuesMatchBefore(config, receipt.values);
  if (!(atAfter || atBefore)) {
    throw new Error("refusing to recover pending configuration after owned keys drifted");
  }
  if (dryRun) {
    return receipt;
  }
  if (!atAfter) {
    await writeConfigBatch(rpc, receiptConfigEdits(receipt), receipt.configPath, expectedVersion);
  }
  receipt.state = "active";
  writePrivateJson(receiptPath, receipt);
  return receipt;
}
async function configureCodex(options) {
  const codexHome = canonicalExistingPath(options.codexHome);
  const codexBinary = validateCodexBinary(options.codexBinary);
  const instructions = options.instructions ?? "native";
  if (instructions === "native" && options.sourceRoot !== undefined) {
    throw new Error("--source-root requires --instructions skizzles");
  }
  let instructionAssets;
  if (instructions === "skizzles") {
    const sourceRoot = options.sourceRoot;
    if (sourceRoot === undefined) {
      throw new Error("--source-root is required with --instructions skizzles");
    }
    instructionAssets = resolveInstructionAssets(sourceRoot);
  }
  assertManagedParentsAreReal(codexHome, [".skizzles"]);
  const receiptPath = configReceiptPath(codexHome);
  const existingReceipt = pendingConfigureReceipt(receiptPath, codexHome, codexBinary, options.orchestration);
  const configPath = join9(codexHome, "config.toml");
  const rpcSession = await openConfigRpcSession({
    codexHome,
    codexBinary,
    dryRun: options.dryRun,
    rpcFactory: options.rpcFactory,
    workspace: options.workspace
  });
  const { rpc } = rpcSession;
  try {
    const layer = selectedUserLayer(await rpc.read(), rpcSession.configPath);
    if (existingReceipt) {
      return recoverPendingConfigure(existingReceipt, receiptPath, layer.config, layer.version, rpc, options.dryRun);
    }
    const edits = desiredConfigEdits(options.orchestration, instructionAssets, layer.config);
    const receipt = {
      version: 1,
      state: "pending",
      orchestration: options.orchestration,
      instructions,
      ...instructionAssets === undefined ? {} : { sourceRoot: instructionAssets.sourceRoot },
      codexBinary,
      configPath,
      values: snapshotConfigValues(layer.config, edits)
    };
    if (options.dryRun) {
      return receipt;
    }
    writePrivateJson(receiptPath, receipt, true);
    await writeConfigBatch(rpc, edits, configPath, layer.version, receiptPath);
    receipt.state = "active";
    writePrivateJson(receiptPath, receipt);
    return receipt;
  } finally {
    try {
      await rpc.close();
    } finally {
      await rpcSession.cleanup();
    }
  }
}
async function unconfigureCodex(options) {
  const codexHome = canonicalExistingPath(options.codexHome);
  assertManagedParentsAreReal(codexHome, [".skizzles"]);
  const receiptPath = configReceiptPath(codexHome);
  const receipt = readReceipt(codexHome);
  const codexBinary = validateCodexBinary(options.codexBinary);
  validateReceiptTarget(receipt, codexHome, codexBinary);
  const rpcSession = await openConfigRpcSession({
    codexHome,
    codexBinary,
    dryRun: options.dryRun,
    rpcFactory: options.rpcFactory,
    workspace: options.workspace
  });
  const { rpc } = rpcSession;
  try {
    const layer = selectedUserLayer(await rpc.read(), rpcSession.configPath);
    const atBefore = valuesMatchBefore(layer.config, receipt.values);
    const atAfter = valuesMatchAfter(layer.config, receipt.values);
    if (atBefore && (receipt.state === "pending" || receipt.state === "restoring")) {
      if (!options.dryRun) {
        rmSync3(receiptPath);
      }
      return receipt;
    }
    if (!atAfter) {
      throw new Error("refusing to restore drifted config keys");
    }
    if (options.dryRun) {
      return receipt;
    }
    receipt.state = "restoring";
    writePrivateJson(receiptPath, receipt);
    try {
      await rpc.batchWrite({
        edits: restoreConfigEdits(receipt.values),
        filePath: receipt.configPath,
        expectedVersion: layer.version,
        reloadUserConfig: true
      });
    } catch (error) {
      throw safeConfigWriteError(error);
    }
    rmSync3(receiptPath);
    return receipt;
  } finally {
    try {
      await rpc.close();
    } finally {
      await rpcSession.cleanup();
    }
  }
}

// packages/installer/src/doctor.ts
import {
  accessSync,
  constants as constants5,
  existsSync as existsSync6,
  lstatSync as lstatSync7,
  mkdirSync as mkdirSync7,
  readFileSync as readFileSync6
} from "fs";
import { delimiter, join as join12, resolve as resolve9 } from "path";
import process7 from "process";
// packages/container-lab/assets/integrations/container-lab.json
var container_lab_default = {
  id: "codex-container-lab",
  integrationContract: 1,
  configuredRuntime: "0.1.0",
  supportedRuntime: ">=0.1.0 <0.2.0",
  versionVerification: "contract-fingerprint-only",
  locations: {
    canonicalWorkspace: "packages/container-lab/assets/integrations/container-lab.json",
    packagedPlugin: "integrations/container-lab.json"
  },
  ownership: {
    runtimeOwner: "skizzles",
    canonicalSource: "packages/container-lab",
    provenanceCommit: "a2f44416ef467d9f54b3cb228e3bd050987a3c4c"
  },
  bundled: {
    operationalEntrypoint: "packages/container-lab/src/cli.ts",
    reaperEntrypoint: "packages/container-lab/src/reaper-cli.ts",
    launcher: "skills/codex-container-lab/scripts/codex-container-lab",
    launchAgentTemplate: "packages/container-lab/install/com.openai.codex-container-lab-reaper.plist",
    documentation: [
      "packages/container-lab/docs/architecture.md",
      "packages/container-lab/docs/completion-contract.md",
      "packages/container-lab/docs/installation.md",
      "packages/container-lab/docs/manifest.md",
      "packages/container-lab/docs/safety.md"
    ]
  },
  binaries: {
    operational: "codex-container-lab",
    reaper: "codex-container-lab-reaper"
  },
  execution: {
    adminProtocol: "single-json-v1",
    adminMaxBytes: 16384,
    runProtocol: "attached-raw-v1",
    runMustBeOutermost: true,
    ownerEnvironment: "CODEX_THREAD_ID"
  },
  environmentBoundary: {
    dockerClient: "fixed-allowlist-v1",
    composeSource: "immutable-raw-model-v1",
    composeEnvironment: "manifest-compose-environment-v1",
    composeSecrets: "up-only-v1",
    localGit: "no-ambient-or-executable-config-v1"
  },
  reaper: {
    outputMaxBytes: 1536,
    lifecycleOwner: "skizzles-explicit-host-wiring",
    launchAgentLabel: "com.openai.codex-container-lab-reaper"
  }
};

// packages/installer/src/harness.ts
import {
  existsSync as existsSync4,
  lstatSync as lstatSync5,
  mkdirSync as mkdirSync5,
  readFileSync as readFileSync4,
  readlinkSync,
  renameSync as renameSync3,
  rmSync as rmSync4,
  symlinkSync,
  writeFileSync as writeFileSync3
} from "fs";
import { dirname as dirname4, join as join10, resolve as resolve7 } from "path";
function harnessReceiptPath(home) {
  return join10(resolve7(home), ".skizzles", "harness-receipt.json");
}
function pluginEntry() {
  return {
    name: "skizzles",
    source: { source: "local", path: "./plugins/skizzles" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Developer Tools"
  };
}
function marketplaceWithSkizzles() {
  const marketplace = {
    name: "personal",
    interface: { displayName: "Personal" },
    plugins: []
  };
  marketplace.plugins.push(pluginEntry());
  return `${JSON.stringify(marketplace, null, 2)}
`;
}
function readReceipt2(home) {
  const path = harnessReceiptPath(home);
  if (!existsSync4(path)) {
    throw new Error(`Skizzles harness receipt is missing: ${path}`);
  }
  const parsed = JSON.parse(readFileSync4(path, "utf8"));
  const receipt = objectValue2(parsed);
  if (receipt?.["version"] !== 1 || receipt["transfer"] !== "link" && receipt["transfer"] !== "copy" || typeof receipt["sourceRoot"] !== "string" || typeof receipt["pluginTarget"] !== "string" || typeof receipt["marketplacePath"] !== "string" || typeof receipt["marketplaceAfter"] !== "string") {
    throw new Error(`invalid Skizzles harness receipt: ${path}`);
  }
  return {
    version: 1,
    sourceRoot: receipt["sourceRoot"],
    transfer: receipt["transfer"],
    pluginTarget: receipt["pluginTarget"],
    marketplacePath: receipt["marketplacePath"],
    marketplaceAfter: receipt["marketplaceAfter"]
  };
}
function objectValue2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}
function installHarness(options) {
  const home = resolve7(options.home);
  const sourceRoot = resolve7(options.sourceRoot);
  const pluginSource = join10(sourceRoot, "plugins", "skizzles");
  const pluginTarget = join10(home, "plugins", "skizzles");
  const marketplacePath = join10(home, ".agents", "plugins", "marketplace.json");
  const receiptPath = harnessReceiptPath(home);
  assertManagedParentsAreReal(home, [
    "plugins",
    ".agents",
    ".agents/plugins",
    ".skizzles"
  ]);
  if (!existsSync4(join10(pluginSource, ".codex-plugin", "plugin.json"))) {
    throw new Error(`generated plugin is missing: ${pluginSource}`);
  }
  if (pathEntryExists(pluginTarget)) {
    throw new Error(`refusing to replace existing plugin: ${pluginTarget}`);
  }
  if (pathEntryExists(receiptPath)) {
    throw new Error(`Skizzles harness receipt already exists: ${receiptPath}`);
  }
  if (pathEntryExists(marketplacePath)) {
    throw new Error(`isolated harness requires an absent marketplace: ${marketplacePath}`);
  }
  const marketplaceAfter = marketplaceWithSkizzles();
  const receipt = {
    version: 1,
    sourceRoot,
    transfer: options.transfer,
    pluginTarget,
    marketplacePath,
    marketplaceAfter
  };
  if (options.dryRun) {
    return receipt;
  }
  try {
    mkdirSync5(dirname4(pluginTarget), { recursive: true });
    if (options.transfer === "link") {
      symlinkSync(pluginSource, pluginTarget, "dir");
    } else {
      copyDirectoryExclusive(pluginSource, pluginTarget);
    }
    mkdirSync5(dirname4(marketplacePath), { recursive: true });
    writeFileSync3(marketplacePath, marketplaceAfter, { flag: "wx" });
    mkdirSync5(dirname4(receiptPath), { recursive: true });
    writeFileSync3(receiptPath, `${JSON.stringify(receipt, null, 2)}
`, {
      flag: "wx"
    });
  } catch (error) {
    rmSync4(pluginTarget, { recursive: true, force: true });
    rmSync4(marketplacePath, { force: true });
    throw error;
  }
  return receipt;
}
function uninstallHarness(homeInput, dryRun = false, move = renameSync3) {
  const home = resolve7(homeInput);
  assertManagedParentsAreReal(home, [
    "plugins",
    ".agents",
    ".agents/plugins",
    ".skizzles"
  ]);
  const receipt = readReceipt2(home);
  const expectedTarget = join10(home, "plugins", "skizzles");
  const expectedMarketplace = join10(home, ".agents", "plugins", "marketplace.json");
  if (resolve7(receipt.pluginTarget) !== expectedTarget || resolve7(receipt.marketplacePath) !== expectedMarketplace) {
    throw new Error("harness receipt targets are outside the selected HOME");
  }
  if (!pathEntryExists(receipt.pluginTarget)) {
    throw new Error("owned plugin target is missing");
  }
  const pluginSource = join10(receipt.sourceRoot, "plugins", "skizzles");
  if (receipt.transfer === "link") {
    if (!lstatSync5(receipt.pluginTarget).isSymbolicLink()) {
      throw new Error("owned plugin link changed type");
    }
    const actual = resolve7(dirname4(receipt.pluginTarget), readlinkSync(receipt.pluginTarget));
    if (actual !== resolve7(pluginSource)) {
      throw new Error("owned plugin link target drifted");
    }
  } else if (!sameTree(pluginSource, receipt.pluginTarget)) {
    throw new Error("owned copied plugin drifted");
  }
  if (!existsSync4(receipt.marketplacePath) || readFileSync4(receipt.marketplacePath, "utf8") !== receipt.marketplaceAfter) {
    throw new Error("marketplace changed after Skizzles installation");
  }
  if (dryRun) {
    return receipt;
  }
  const quarantine = join10(home, ".skizzles", `harness-uninstall-${crypto.randomUUID()}`);
  mkdirSync5(quarantine);
  const moved = [];
  try {
    for (const [from, name] of [
      [receipt.marketplacePath, "marketplace.json"],
      [receipt.pluginTarget, "plugin"],
      [harnessReceiptPath(home), "receipt.json"]
    ]) {
      const to = join10(quarantine, name);
      move(from, to);
      moved.push({ from, to });
    }
  } catch (error) {
    rollbackStagedMoves(moved);
    rmSync4(quarantine, { recursive: true, force: true });
    throw error;
  }
  try {
    rmSync4(quarantine, { recursive: true, force: true });
  } catch {}
  return receipt;
}

// packages/installer/src/skills.ts
import {
  existsSync as existsSync5,
  lstatSync as lstatSync6,
  mkdirSync as mkdirSync6,
  readdirSync as readdirSync2,
  readFileSync as readFileSync5,
  readlinkSync as readlinkSync2,
  renameSync as renameSync4,
  rmSync as rmSync5,
  symlinkSync as symlinkSync2,
  writeFileSync as writeFileSync4
} from "fs";
import { dirname as dirname5, join as join11, relative as relative3, resolve as resolve8 } from "path";
import process6 from "process";
var receiptName = "skills-receipt.json";
function skillsReceiptPath(codexHome) {
  return join11(resolve8(codexHome), ".skizzles", receiptName);
}
function publicSkills(sourceRoot) {
  const root = join11(resolve8(sourceRoot), "skills");
  if (!existsSync5(root)) {
    throw new Error(`canonical skills directory is missing: ${root}`);
  }
  return readdirSync2(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync5(join11(root, entry.name, "SKILL.md"))).map((entry) => ({ name: entry.name, source: join11(root, entry.name) })).sort((left, right) => left.name.localeCompare(right.name));
}
function readReceipt3(codexHome) {
  const path = skillsReceiptPath(codexHome);
  if (!existsSync5(path)) {
    throw new Error(`Skizzles skills receipt is missing: ${path}`);
  }
  const parsed = JSON.parse(readFileSync5(path, "utf8"));
  const value = objectValue3(parsed);
  if (value?.["version"] !== 1 || value["transfer"] !== "link" && value["transfer"] !== "copy" || typeof value["sourceRoot"] !== "string" || !Array.isArray(value["skills"])) {
    throw new Error(`invalid Skizzles skills receipt: ${path}`);
  }
  const skills = [];
  for (const item of value["skills"]) {
    const skill = objectValue3(item);
    if (typeof skill?.["name"] !== "string" || typeof skill["target"] !== "string") {
      throw new Error(`invalid Skizzles skills receipt: ${path}`);
    }
    skills.push({ name: skill["name"], target: skill["target"] });
  }
  return {
    version: 1,
    sourceRoot: value["sourceRoot"],
    transfer: value["transfer"],
    skills
  };
}
function objectValue3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}
function installSkills(options) {
  const codexHome = resolve8(options.codexHome);
  const sourceRoot = resolve8(options.sourceRoot);
  assertManagedParentsAreReal(codexHome, ["skills", ".skizzles"]);
  const receiptPath = skillsReceiptPath(codexHome);
  if (pathEntryExists(receiptPath)) {
    throw new Error(`Skizzles skills receipt already exists: ${receiptPath}`);
  }
  const skills = publicSkills(sourceRoot).map(({ name, source }) => ({
    name,
    source,
    target: join11(codexHome, "skills", name)
  }));
  if (skills.length === 0) {
    throw new Error("no public skills were found");
  }
  const conflict = skills.find(({ target }) => pathEntryExists(target));
  if (conflict) {
    throw new Error(`refusing to replace existing skill: ${conflict.target}`);
  }
  const receipt = {
    version: 1,
    sourceRoot,
    transfer: options.transfer,
    skills: skills.map(({ name, target }) => ({ name, target }))
  };
  if (options.dryRun) {
    return receipt;
  }
  mkdirSync6(join11(codexHome, "skills"), { recursive: true });
  const created = [];
  try {
    for (const skill of skills) {
      if (options.transfer === "link") {
        symlinkSync2(skill.source, skill.target, "dir");
      } else {
        copyDirectoryExclusive(skill.source, skill.target);
      }
      created.push(skill.target);
    }
    mkdirSync6(dirname5(receiptPath), { recursive: true });
    writeFileSync4(receiptPath, `${JSON.stringify(receipt, null, 2)}
`, {
      flag: "wx"
    });
  } catch (error) {
    for (const target of created.reverse()) {
      rmSync5(target, { recursive: true, force: true });
    }
    throw error;
  }
  return receipt;
}
function uninstallSkills(codexHomeInput, dryRun = false, move = renameSync4) {
  const codexHome = resolve8(codexHomeInput);
  assertManagedParentsAreReal(codexHome, ["skills", ".skizzles"]);
  const receipt = readReceipt3(codexHome);
  for (const skill of receipt.skills) {
    const target = resolve8(skill.target);
    const expectedParent = join11(codexHome, "skills");
    if (dirname5(target) !== expectedParent || !pathEntryExists(target)) {
      throw new Error(`owned skill target is missing or outside CODEX_HOME: ${target}`);
    }
    const source = join11(receipt.sourceRoot, "skills", skill.name);
    if (receipt.transfer === "link") {
      if (!lstatSync6(target).isSymbolicLink()) {
        throw new Error(`owned link changed type: ${target}`);
      }
      const actual = resolve8(dirname5(target), readlinkSync2(target));
      if (actual !== resolve8(source)) {
        throw new Error(`owned link target drifted: ${target}`);
      }
    } else if (!sameTree(source, target)) {
      throw new Error(`owned copied skill drifted: ${target}`);
    }
  }
  if (dryRun) {
    return receipt;
  }
  const quarantine = join11(codexHome, ".skizzles", `uninstall-${crypto.randomUUID()}`);
  mkdirSync6(quarantine);
  const moved = [];
  try {
    for (const skill of receipt.skills) {
      const destination = join11(quarantine, skill.name);
      move(skill.target, destination);
      moved.push({ from: skill.target, to: destination });
    }
    const receiptPath = skillsReceiptPath(codexHome);
    const receiptDestination = join11(quarantine, receiptName);
    move(receiptPath, receiptDestination);
    moved.push({ from: receiptPath, to: receiptDestination });
  } catch (error) {
    rollbackStagedMoves(moved);
    rmSync5(quarantine, { recursive: true, force: true });
    throw error;
  }
  try {
    rmSync5(quarantine, { recursive: true, force: true });
  } catch {}
  return receipt;
}
function receiptSummary(receipt) {
  return {
    surface: "skills",
    transfer: receipt.transfer,
    sourceRoot: receipt.sourceRoot,
    skills: receipt.skills.map(({ name, target }) => ({
      name,
      target: relative3(process6.cwd(), target) || target
    }))
  };
}

// packages/installer/src/doctor.ts
var COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
var LINE_PATTERN = /\r?\n/u;
function contract(descriptorPath) {
  const value = descriptorPath === undefined ? container_lab_default : JSON.parse(readFileSync6(descriptorPath, "utf8"));
  const root = objectValue4(value);
  const binaries = objectValue4(root?.["binaries"]);
  const execution = objectValue4(root?.["execution"]);
  const locations = objectValue4(root?.["locations"]);
  const ownership = objectValue4(root?.["ownership"]);
  const bundled = objectValue4(root?.["bundled"]);
  const configuredRuntime = nonEmptyString(root?.["configuredRuntime"]);
  const operational = nonEmptyString(binaries?.["operational"]);
  const reaper = nonEmptyString(binaries?.["reaper"]);
  const adminMaxBytes = execution?.["adminMaxBytes"];
  const canonicalWorkspace = locations?.["canonicalWorkspace"];
  const packagedPlugin = locations?.["packagedPlugin"];
  const canonicalSource = ownership?.["canonicalSource"];
  const provenanceCommit = ownership?.["provenanceCommit"];
  const operationalEntrypoint = bundled?.["operationalEntrypoint"];
  const reaperEntrypoint = bundled?.["reaperEntrypoint"];
  const launcher = bundled?.["launcher"];
  const launchAgentTemplate = bundled?.["launchAgentTemplate"];
  const documentation = bundled?.["documentation"];
  if (configuredRuntime === undefined || operational === undefined || reaper === undefined || !Number.isSafeInteger(adminMaxBytes) || typeof adminMaxBytes !== "number" || adminMaxBytes <= 0 || !relativePath(canonicalWorkspace) || !relativePath(packagedPlugin) || ownership?.["runtimeOwner"] !== "skizzles" || !relativePath(canonicalSource) || typeof provenanceCommit !== "string" || !COMMIT_PATTERN.test(provenanceCommit) || !relativePath(operationalEntrypoint) || !relativePath(reaperEntrypoint) || !relativePath(launcher) || !relativePath(launchAgentTemplate) || !Array.isArray(documentation) || documentation.length === 0 || !documentation.every(relativePath)) {
    throw new Error("Skizzles Container Lab descriptor is invalid");
  }
  return {
    configuredRuntime,
    binaries: { operational, reaper },
    execution: { adminMaxBytes },
    locations: { canonicalWorkspace, packagedPlugin },
    ownership: {
      runtimeOwner: "skizzles",
      canonicalSource,
      provenanceCommit
    },
    bundled: {
      operationalEntrypoint,
      reaperEntrypoint,
      launcher,
      launchAgentTemplate,
      documentation
    }
  };
}
function objectValue4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function relativePath(value) {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.split("/").includes("..");
}
function executable(name, pathValue) {
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = resolve9(directory, name);
    try {
      accessSync(candidate, constants5.X_OK);
      return candidate;
    } catch {}
  }
  return;
}
function adminJson(command, args, environment, maximumBytes, timeoutMs) {
  const spawned = Bun.spawnSync({
    cmd: [...command, ...args],
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    maxBuffer: maximumBytes + 1
  });
  const output = spawned.stdout.toString();
  const errorOutput = spawned.stderr.toString();
  if (Buffer.byteLength(output, "utf8") > maximumBytes || Buffer.byteLength(errorOutput, "utf8") > maximumBytes) {
    throw new Error("external command exceeded its public output limit");
  }
  if (spawned.signalCode !== undefined && spawned.signalCode !== null) {
    throw new Error("external command exceeded its time or output limit");
  }
  if (spawned.exitCode !== 0) {
    throw new Error("external command failed");
  }
  const lines = output.trim().split(LINE_PATTERN).filter(Boolean);
  const line = lines[0];
  if (lines.length !== 1 || line === undefined) {
    throw new Error("external command did not return one JSON record");
  }
  const value = JSON.parse(line);
  const record = objectValue4(value);
  if (record === undefined) {
    throw new Error("external command returned invalid JSON");
  }
  return record;
}
function inspectContainerLab(operational, reaper, descriptor, pathValue, timeoutMs, workspace) {
  const base = {
    version: `configured-${descriptor.configuredRuntime}-unverified`
  };
  const root = workspace.path("container-lab-doctor");
  mkdirSync7(root, { recursive: true, mode: 448 });
  try {
    const processTemp = join12(root, "tmp");
    mkdirSync7(processTemp, { recursive: true, mode: 448 });
    const environment = {
      PATH: pathValue,
      HOME: join12(root, "home"),
      TEMP: processTemp,
      TMP: processTemp,
      TMPDIR: processTemp
    };
    const help = adminJson(operational, ["--help"], environment, descriptor.execution.adminMaxBytes, timeoutMs);
    const reaperHelp = adminJson(reaper, ["--help"], environment, descriptor.execution.adminMaxBytes, timeoutMs);
    if (typeof help["help"] !== "string" || !help["help"].includes("run --lab") || typeof reaperHelp["help"] !== "string" || !reaperHelp["help"].includes("codex-container-lab-reaper")) {
      return {
        ...base,
        installed: true,
        compatible: false,
        ready: false,
        reason: "Container Lab command fingerprint did not match"
      };
    }
    const health = adminJson(operational, [
      "--owner",
      `skizzles-doctor-${crypto.randomUUID()}`,
      "--state-root",
      join12(root, "state"),
      "--runtime-root",
      join12(root, "runtime"),
      "health"
    ], environment, descriptor.execution.adminMaxBytes, timeoutMs);
    if (health["ok"] !== true || typeof health["dockerAvailable"] !== "boolean" || typeof health["labs"] !== "number") {
      return {
        ...base,
        installed: true,
        compatible: false,
        ready: false,
        reason: "Container Lab health contract did not match"
      };
    }
    return {
      ...base,
      installed: true,
      compatible: true,
      ready: health["dockerAvailable"],
      dockerAvailable: health["dockerAvailable"],
      ...health["dockerAvailable"] ? {} : { reason: "installed but Docker is not ready" }
    };
  } catch (error) {
    const reason = error instanceof SyntaxError ? "Container Lab returned malformed JSON" : error instanceof Error ? error.message : "Container Lab doctor failed";
    return {
      ...base,
      installed: true,
      compatible: false,
      ready: false,
      reason
    };
  }
}
function doctorContainerLab(pathValue = process7.env["PATH"] ?? "", descriptorPath, timeoutMs = 5000, workspace) {
  const descriptor = contract(descriptorPath);
  const operational = executable(descriptor.binaries.operational, pathValue);
  const reaper = executable(descriptor.binaries.reaper, pathValue);
  const base = {
    version: `configured-${descriptor.configuredRuntime}-unverified`
  };
  if (!(operational && reaper)) {
    return {
      ...base,
      installed: false,
      compatible: false,
      ready: false,
      reason: "optional Container Lab PATH convenience binaries are missing"
    };
  }
  return inspectContainerLab([operational], [reaper], descriptor, pathValue, timeoutMs, requiredWorkspace2(workspace));
}
function doctor(home, codexHome, pathValue = process7.env["PATH"] ?? "", workspace) {
  const containerLab = doctorContainerLab(pathValue, undefined, 5000, workspace);
  let skills = "absent";
  let harness = "absent";
  if (existsSync6(skillsReceiptPath(codexHome))) {
    try {
      uninstallSkills(codexHome, true);
      skills = "healthy";
    } catch {
      skills = "drifted";
    }
  }
  if (existsSync6(harnessReceiptPath(home))) {
    try {
      uninstallHarness(home, true);
      harness = "healthy";
    } catch {
      harness = "drifted";
    }
  }
  return {
    ok: (skills === "healthy" || harness === "healthy") && skills !== "drifted" && harness !== "drifted",
    installs: { skills, harness },
    containerLab
  };
}
function requiredWorkspace2(workspace) {
  if (workspace === undefined) {
    throw new Error("Container Lab doctor requires a run workspace");
  }
  return workspace;
}

// packages/installer/src/lifecycle.ts
var systemLifecycle = { cleanupStale, create };
async function runInstallerOperation(operation) {
  return await runInstallerOperationWithLifecycle(operation, systemLifecycle);
}
async function runInstallerOperationWithLifecycle(operation, lifecycle) {
  const stale = await lifecycle.cleanupStale();
  if (stale.failed.length > 0 || stale.truncated) {
    throw new Error("installer stale workspace cleanup failed");
  }
  const workspace = await lifecycle.create({ handleSignals: true });
  let outcome;
  try {
    const interrupted = new Promise((_resolve, reject) => {
      const abort = () => reject(workspace.signal.reason);
      workspace.signal.addEventListener("abort", abort, { once: true });
      if (workspace.signal.aborted)
        abort();
    });
    outcome = {
      ok: true,
      value: await Promise.race([operation(workspace), interrupted])
    };
  } catch (error) {
    outcome = { ok: false, error };
  }
  let report2;
  try {
    report2 = await workspace.close();
  } catch (error) {
    throw new Error("installer temporary cleanup failed", {
      cause: outcome.ok ? error : new AggregateError([error, outcome.error], "workspace cleanup and installer operation both failed")
    });
  }
  if (report2.state === "cleanup-failed") {
    const cleanupError = new Error(`installer temporary cleanup failed: ${report2.error ?? "CLEANUP_FAILED"}`);
    throw new Error(cleanupError.message, {
      cause: outcome.ok ? cleanupError : new AggregateError([cleanupError, outcome.error], "workspace cleanup and installer operation both failed")
    });
  }
  if (workspace.signal.reason instanceof RunWorkspaceAbortedError) {
    throw workspace.signal.reason;
  }
  if (!outcome.ok)
    throw outcome.error;
  return outcome.value;
}

// packages/installer/src/prompt-policy.ts
import { existsSync as existsSync10, lstatSync as lstatSync11 } from "fs";
import { isAbsolute as isAbsolute7, join as join15, resolve as resolve13 } from "path";

// packages/prompt-layer/src/lifecycle/contract.ts
var PROMPT_LAYER_SOURCE_PATHS = {
  manifest: "packages/prompt-layer/assets/manifest.json",
  baseline: "packages/prompt-layer/assets/upstream/default.md",
  license: "packages/prompt-layer/assets/upstream/LICENSE",
  notice: "packages/prompt-layer/assets/upstream/NOTICE",
  patch: "packages/prompt-layer/assets/skizzles-base.patch",
  applied: "packages/prompt-layer/assets/instructions/skizzles-base.md",
  provenance: "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
  developer: "packages/prompt-layer/assets/instructions/developer-instructions.md",
  compact: "packages/prompt-layer/assets/instructions/compact-prompt.md",
  descriptor: "packages/prompt-layer/assets/integrations/prompt-policy.json",
  shippedLanguagePolicy: "packages/prompt-layer/assets/evaluations/shipped-language-policy.v2.json"
};
var PROMPT_POLICY_DESCRIPTOR_PATHS = {
  canonicalWorkspacePath: PROMPT_LAYER_SOURCE_PATHS.descriptor,
  packagedPath: "integrations/prompt-policy.json"
};
var SHIPPED_LANGUAGE_POLICY_PATHS = {
  canonicalWorkspacePath: PROMPT_LAYER_SOURCE_PATHS.shippedLanguagePolicy,
  packagedPath: "evaluations/shipped-language-policy.v2.json"
};
var PROMPT_LAYER_PACKAGE_FILES = [
  [PROMPT_LAYER_SOURCE_PATHS.applied, "instructions/skizzles-base.md"],
  [
    PROMPT_LAYER_SOURCE_PATHS.provenance,
    "instructions/skizzles-base.provenance.json"
  ],
  [
    PROMPT_LAYER_SOURCE_PATHS.developer,
    "instructions/developer-instructions.md"
  ],
  [PROMPT_LAYER_SOURCE_PATHS.compact, "instructions/compact-prompt.md"],
  [
    SHIPPED_LANGUAGE_POLICY_PATHS.canonicalWorkspacePath,
    SHIPPED_LANGUAGE_POLICY_PATHS.packagedPath
  ],
  [
    PROMPT_POLICY_DESCRIPTOR_PATHS.canonicalWorkspacePath,
    PROMPT_POLICY_DESCRIPTOR_PATHS.packagedPath
  ],
  [PROMPT_LAYER_SOURCE_PATHS.license, "third_party/openai-codex/LICENSE"],
  [PROMPT_LAYER_SOURCE_PATHS.notice, "third_party/openai-codex/NOTICE"]
];
var MANIFEST_PATH = PROMPT_LAYER_SOURCE_PATHS.manifest;
var BASELINE_PATH = PROMPT_LAYER_SOURCE_PATHS.baseline;
var LICENSE_PATH = PROMPT_LAYER_SOURCE_PATHS.license;
var NOTICE_PATH = PROMPT_LAYER_SOURCE_PATHS.notice;
var PATCH_PATH = PROMPT_LAYER_SOURCE_PATHS.patch;
var OUTPUT_PATH = PROMPT_LAYER_SOURCE_PATHS.applied;
var PROVENANCE_PATH = PROMPT_LAYER_SOURCE_PATHS.provenance;
var TRANSACTION_PATH = "packages/prompt-layer/assets/.transaction";
var TRANSACTION_JOURNAL_PATH = `${TRANSACTION_PATH}/journal.json`;
var LOCK_PATH = "packages/prompt-layer/assets/.mutation-lock";
var LOCK_OWNER_PATH = `${LOCK_PATH}/owner.json`;
var TRANSACTION_PATHS = {
  build: [OUTPUT_PATH, PROVENANCE_PATH],
  author: [PATCH_PATH, MANIFEST_PATH, OUTPUT_PATH, PROVENANCE_PATH],
  rebase: [
    BASELINE_PATH,
    LICENSE_PATH,
    NOTICE_PATH,
    PATCH_PATH,
    MANIFEST_PATH,
    OUTPUT_PATH,
    PROVENANCE_PATH
  ]
};
var CANONICAL_PATHS = [
  ...TRANSACTION_PATHS.rebase,
  SHIPPED_LANGUAGE_POLICY_PATHS.canonicalWorkspacePath
];

// packages/prompt-layer/src/shipped-language/policy.ts
var MAX_POLICY_BYTES = 64 * 1024;

// packages/prompt-layer/src/lifecycle/workspace.ts
import { mkdir as mkdir3 } from "fs/promises";
class OwnedPromptWorkspace {
  signal;
  #workspace;
  #sequence = 0;
  constructor(workspace) {
    this.#workspace = workspace;
    this.signal = workspace.signal;
  }
  async directory(purpose) {
    this.throwIfAborted();
    const sequence = this.#sequence;
    this.#sequence += 1;
    const path = this.#workspace.path(`${purpose}-${sequence}`);
    await mkdir3(path, { recursive: false, mode: 448 });
    this.throwIfAborted();
    return path;
  }
  throwIfAborted() {
    this.signal.throwIfAborted();
  }
}
// packages/prompt-layer/src/cli.ts
if (false) {}

// packages/installer/src/prompt-policy/lock.ts
import { createHash, randomUUID } from "crypto";
import {
  chmodSync as chmodSync5,
  existsSync as existsSync7,
  lstatSync as lstatSync8,
  mkdirSync as mkdirSync8,
  readdirSync as readdirSync3,
  readFileSync as readFileSync7,
  realpathSync as realpathSync4,
  renameSync as renameSync5,
  rmdirSync,
  rmSync as rmSync6,
  statSync,
  writeFileSync as writeFileSync5
} from "fs";
import { tmpdir as tmpdir2 } from "os";
import { basename as basename3, dirname as dirname6, join as join13, resolve as resolve10 } from "path";
import process8 from "process";
var LOCK_SCHEMA = "skizzles.prompt-policy-lock";
var LOCK_VERSION2 = 1;
var OWNER_NAME = "owner.json";
var DEFAULT_INCOMPLETE_GRACE_MS = 5000;
var TOKEN_PATTERN = /^[0-9a-f-]{36}$/;
var ORPHAN_NAME_PATTERN = /^(?:stale|release|failed)-[0-9a-f-]{36}$/;
var CREATED_AT_UNIX_MS_FIELD = "createdAtUnixMs";
var LINE_BREAK_PATTERN = /[\r\n]/;
var WHITESPACE_PATTERN = /\s+/;
var DARWIN_PS_LSTART = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/;
var DARWIN_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var DARWIN_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];
function promptPolicyLockPath(codexHome, lockParent = defaultLockParent()) {
  const absolute = resolve10(codexHome);
  const canonical = existsSync7(absolute) ? realpathSync4(absolute) : absolute;
  const key = createHash("sha256").update(canonical).digest("hex");
  return join13(resolve10(lockParent), key);
}
async function withPromptPolicyLock(codexHome, operation, options, work) {
  const lock = await acquireLock(codexHome, operation, options);
  try {
    await options?.afterAcquire?.(lock.path);
    verifyOwnedLock(lock, "before operation preflight");
    return await work();
  } finally {
    await options?.beforeRelease?.(lock.path);
    releaseLock(lock);
  }
}
function acquireLock(codexHome, operation, options) {
  const parent = resolve10(options?.lockParent ?? defaultLockParent());
  ensureSafeParent(parent);
  const processStartIdentity = (options?.processStartIdentity ?? defaultProcessStartIdentity)(process8.pid);
  if (!validProcessStartIdentity2(processStartIdentity)) {
    throw new Error("cannot establish process-start identity for prompt-policy lifecycle lock");
  }
  const owner = {
    schema: LOCK_SCHEMA,
    version: LOCK_VERSION2,
    operation,
    pid: process8.pid,
    processStartIdentity,
    token: randomUUID(),
    createdAtUnixMs: Date.now()
  };
  const path = promptPolicyLockPath(codexHome, parent);
  cleanupLockOrphans(parent, path, options);
  const created = createLock(parent, path, owner);
  if (created) {
    return created;
  }
  return reclaimStaleLock(parent, path, owner, options);
}
function cleanupLockOrphans(parent, lockPath, options) {
  const prefix = `${basename3(lockPath)}.`;
  const grace = options?.incompleteGraceMs ?? DEFAULT_INCOMPLETE_GRACE_MS;
  for (const name of readdirSync3(parent).sort()) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const suffix = name.slice(prefix.length);
    if (!ORPHAN_NAME_PATTERN.test(suffix)) {
      throw new Error("prompt-policy lock parent contains malformed orphan state");
    }
    const path = join13(parent, name);
    const metadata = lstatSync8(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("prompt-policy lock orphan is not a safe directory");
    }
    if ((metadata.mode & 511) !== 448) {
      throw new Error("prompt-policy lock orphan must have mode 0700");
    }
    const identity2 = fileIdentity3(path);
    const entries = readdirSync3(path).sort();
    if (entries.length > 1 || entries.length === 1 && entries[0] !== OWNER_NAME) {
      throw new Error("prompt-policy lock orphan contains unexpected entries");
    }
    const owner = entries.length === 1 ? readOwner(path) : undefined;
    if (owner) {
      assertStaleOwner(owner, options?.processStartIdentity);
    } else if (Date.now() - metadata.mtimeMs < grace) {
      throw new Error("prompt-policy lock orphan is inside its grace period");
    }
    assertIdentity(path, identity2, "prompt-policy lock orphan was replaced");
    if (owner && !sameOwner(readOwner(path), owner)) {
      throw new Error("prompt-policy lock orphan ownership changed");
    }
    removeQuarantine(path, identity2, owner !== undefined);
  }
}
function createLock(parent, path, owner) {
  try {
    mkdirSync8(path, { mode: 448 });
  } catch (error) {
    if (isNodeError2(error) && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
  chmodSync5(path, 448);
  const identity2 = fileIdentity3(path);
  try {
    writeFileSync5(join13(path, OWNER_NAME), `${JSON.stringify(owner, null, 2)}
`, {
      flag: "wx",
      mode: 384
    });
    chmodSync5(join13(path, OWNER_NAME), 384);
    const handle = { parent, path, identity: identity2, owner };
    verifyOwnedLock(handle, "initialization");
    return handle;
  } catch (error) {
    removeOwnedLockDirectory2({ parent, path, identity: identity2, owner });
    throw error;
  }
}
async function reclaimStaleLock(parent, path, replacement, options) {
  const grace = options?.incompleteGraceMs ?? DEFAULT_INCOMPLETE_GRACE_MS;
  if (!Number.isSafeInteger(grace) || grace < 0) {
    throw new Error("prompt-policy lock grace must be a non-negative integer");
  }
  const metadata = lstatSync8(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("prompt-policy lifecycle lock is not a safe directory");
  }
  if ((metadata.mode & 511) !== 448) {
    throw new Error("prompt-policy lifecycle lock must have mode 0700");
  }
  const identity2 = fileIdentity3(path);
  const entries = readdirSync3(path).sort();
  if (entries.length > 1 || entries.length === 1 && entries[0] !== OWNER_NAME) {
    throw new Error("prompt-policy lifecycle lock contains unexpected entries");
  }
  const owner = entries.length === 1 ? readOwner(path) : undefined;
  if (owner) {
    assertStaleOwner(owner, options?.processStartIdentity);
  } else if (Date.now() - metadata.mtimeMs < grace) {
    throw new Error("prompt-policy lifecycle lock initialization is incomplete within its grace period");
  }
  await options?.beforeStaleQuarantine?.(path);
  assertIdentity(path, identity2, "prompt-policy lock changed during stale reclaim");
  if (owner) {
    const current = readOwner(path);
    if (!sameOwner(current, owner)) {
      throw new Error("prompt-policy lock ownership changed during stale reclaim");
    }
    assertStaleOwner(current, options?.processStartIdentity);
  } else if (readdirSync3(path).length > 0) {
    throw new Error("prompt-policy orphan lock acquired an owner during reclaim");
  }
  const quarantine = `${path}.stale-${replacement.token}`;
  renameSync5(path, quarantine);
  assertIdentity(quarantine, identity2, "prompt-policy stale-lock quarantine identity changed");
  const acquired = createLock(parent, path, replacement);
  if (!acquired) {
    removeQuarantine(quarantine, identity2, owner !== undefined);
    throw new Error("another prompt-policy operation acquired the lifecycle lock");
  }
  try {
    removeQuarantine(quarantine, identity2, owner !== undefined);
  } catch (error) {
    releaseLock(acquired);
    throw error;
  }
  return acquired;
}
function releaseLock(lock) {
  verifyOwnedLock(lock, "release");
  const quarantine = `${lock.path}.release-${lock.owner.token}`;
  renameSync5(lock.path, quarantine);
  assertIdentity(quarantine, lock.identity, "prompt-policy release quarantine identity changed");
  removeQuarantine(quarantine, lock.identity, true);
  removeParentIfEmpty(lock.parent);
}
function removeOwnedLockDirectory2(lock) {
  try {
    verifyOwnedLock(lock, "failed initialization cleanup");
  } catch {
    return;
  }
  const quarantine = `${lock.path}.failed-${lock.owner.token}`;
  renameSync5(lock.path, quarantine);
  removeQuarantine(quarantine, lock.identity, true);
  removeParentIfEmpty(lock.parent);
}
function removeQuarantine(path, identity2, ownerExpected) {
  assertIdentity(path, identity2, "prompt-policy lock quarantine was replaced");
  const entries = readdirSync3(path).sort();
  const expected = ownerExpected ? [OWNER_NAME] : [];
  if (entries.join("\x00") !== expected.join("\x00")) {
    throw new Error("prompt-policy lock quarantine contains unexpected entries");
  }
  if (ownerExpected) {
    rmSync6(join13(path, OWNER_NAME));
  }
  rmdirSync(path);
}
function verifyOwnedLock(lock, phase) {
  assertIdentity(lock.path, lock.identity, `prompt-policy lifecycle lock changed during ${phase}`);
  const metadata = lstatSync8(lock.path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 511) !== 448) {
    throw new Error(`prompt-policy lifecycle lock became unsafe during ${phase}`);
  }
  if (readdirSync3(lock.path).sort().join("\x00") !== OWNER_NAME) {
    throw new Error(`prompt-policy lifecycle lock gained unexpected entries during ${phase}`);
  }
  const owner = readOwner(lock.path);
  if (!sameOwner(owner, lock.owner)) {
    throw new Error(`prompt-policy lock ownership changed during ${phase}`);
  }
}
function readOwner(lockPath) {
  const path = join13(lockPath, OWNER_NAME);
  const metadata = lstatSync8(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("prompt-policy lock owner is not a regular file");
  }
  if ((metadata.mode & 511) !== 384) {
    throw new Error("prompt-policy lock owner must have mode 0600");
  }
  let value;
  try {
    value = JSON.parse(readFileSync7(path, "utf8"));
  } catch {
    throw new Error("prompt-policy lock owner is invalid JSON");
  }
  if (!isObject(value)) {
    throw new Error("prompt-policy lock owner is invalid");
  }
  const keys = Object.keys(value).sort();
  const expected = [
    "schema",
    "version",
    "operation",
    "pid",
    "processStartIdentity",
    "token",
    CREATED_AT_UNIX_MS_FIELD
  ].sort();
  if (keys.join("\x00") !== expected.join("\x00")) {
    throw new Error("prompt-policy lock owner has unexpected fields");
  }
  const operation = value["operation"];
  const pid = value["pid"];
  const processStartIdentity = value["processStartIdentity"];
  const token = value["token"];
  const createdAtUnixMs = value[CREATED_AT_UNIX_MS_FIELD];
  if (value["schema"] !== LOCK_SCHEMA || value["version"] !== LOCK_VERSION2 || operation !== "apply" && operation !== "restore" || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1 || !validProcessStartIdentity2(processStartIdentity) || typeof token !== "string" || !TOKEN_PATTERN.test(token) || typeof createdAtUnixMs !== "number" || !Number.isSafeInteger(createdAtUnixMs) || createdAtUnixMs < 1) {
    throw new Error("prompt-policy lock owner fields are invalid");
  }
  return {
    schema: LOCK_SCHEMA,
    version: LOCK_VERSION2,
    operation,
    pid,
    processStartIdentity,
    token,
    createdAtUnixMs
  };
}
function assertStaleOwner(owner, provider = defaultProcessStartIdentity) {
  if (!processExists(owner.pid)) {
    return;
  }
  const actual = provider(owner.pid);
  if (!validProcessStartIdentity2(actual)) {
    throw new Error(`cannot verify prompt-policy lock process identity for pid ${owner.pid}`);
  }
  if (actual === owner.processStartIdentity) {
    throw new Error(`prompt-policy lifecycle is owned by live pid ${owner.pid} (${owner.operation})`);
  }
}
function defaultProcessStartIdentity(pid) {
  if (process8.platform === "linux") {
    try {
      const stat = readFileSync7(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) {
        return;
      }
      const fields = stat.slice(commandEnd + 1).trim().split(WHITESPACE_PATTERN);
      const startTicks = fields[19];
      return startTicks ? `linux:${startTicks}` : undefined;
    } catch {
      return;
    }
  }
  if (process8.platform === "darwin") {
    const result = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)], {
      env: { ...process8.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
      stdout: "pipe",
      stderr: "ignore"
    });
    if (result.exitCode !== 0) {
      return;
    }
    return normalizeDarwinProcessStart(result.stdout.toString());
  }
  return;
}
function normalizeDarwinProcessStart(output) {
  const match = DARWIN_PS_LSTART.exec(output.trim().replace(/\s+/g, " "));
  if (!match) {
    return;
  }
  const weekday = DARWIN_WEEKDAYS.indexOf(match[1] ?? "");
  const month = DARWIN_MONTHS.indexOf(match[2] ?? "");
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const year = Number(match[7]);
  if (weekday < 0 || month < 0) {
    return;
  }
  const epochMs = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(epochMs);
  if (!Number.isFinite(epochMs) || date.getUTCDay() !== weekday || date.getUTCMonth() !== month || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second || date.getUTCFullYear() !== year) {
    return;
  }
  return `darwin:${epochMs / 1000}`;
}
function processExists(pid) {
  try {
    process8.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError2(error) && error.code === "EPERM") {
      return true;
    }
    if (isNodeError2(error) && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
function validProcessStartIdentity2(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !LINE_BREAK_PATTERN.test(value);
}
function sameOwner(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function fileIdentity3(path) {
  const metadata = lstatSync8(path);
  return { dev: metadata.dev, ino: metadata.ino };
}
function assertIdentity(path, expected, message) {
  let actual;
  try {
    actual = fileIdentity3(path);
  } catch {
    throw new Error(message);
  }
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(message);
  }
}
function ensureSafeParent(parent) {
  const ancestor = dirname6(parent);
  const ancestorMetadata = statSync(ancestor);
  if (!ancestorMetadata.isDirectory()) {
    throw new Error("prompt-policy lock parent ancestor is not a directory");
  }
  try {
    const metadata = lstatSync8(parent);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("prompt-policy lock parent is not a safe directory");
    }
  } catch (error) {
    if (!isNodeError2(error) || error.code !== "ENOENT") {
      throw error;
    }
    mkdirSync8(parent, { mode: 448 });
  }
  chmodSync5(parent, 448);
}
function removeParentIfEmpty(parent) {
  try {
    if (readdirSync3(parent).length === 0) {
      rmdirSync(parent);
    }
  } catch (error) {
    if (isNodeError2(error) && (error.code === "ENOENT" || error.code === "ENOTEMPTY")) {
      return;
    }
    throw error;
  }
}
function defaultLockParent(temporaryDirectory = tmpdir2()) {
  const uid = typeof process8.getuid === "function" ? process8.getuid() : process8.pid;
  const systemTemp = realpathSync4(temporaryDirectory);
  return join13(systemTemp, `skizzles-prompt-policy-locks-${uid}`);
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNodeError2(error) {
  return error instanceof Error && "code" in error;
}

// packages/installer/src/prompt-policy/managed-state.ts
import {
  chmodSync as chmodSync6,
  existsSync as existsSync9,
  lstatSync as lstatSync10,
  mkdirSync as mkdirSync9,
  readdirSync as readdirSync4,
  readFileSync as readFileSync9,
  rmdirSync as rmdirSync2,
  rmSync as rmSync7,
  writeFileSync as writeFileSync6
} from "fs";
import { dirname as dirname8, isAbsolute as isAbsolute6, resolve as resolve12 } from "path";

// packages/installer/src/prompt-policy/source.ts
import { createHash as createHash2 } from "crypto";
import { existsSync as existsSync8, lstatSync as lstatSync9, readFileSync as readFileSync8, realpathSync as realpathSync5 } from "fs";
import { dirname as dirname7, isAbsolute as isAbsolute5, join as join14, relative as relative4, resolve as resolve11 } from "path";
var MACHINE_PATH_PATTERNS = [
  /\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/,
  /\/home\/[A-Za-z0-9._-]+(?:\/|\b)/,
  /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|\b)/i
];
var IMMUTABLE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
var SHA256_PATTERN = /^[0-9a-f]{64}$/;
function readPolicySource(sourceRootInput, descriptorPathInput) {
  if (!isAbsolute5(sourceRootInput)) {
    throw new Error("--source-root must be an absolute path");
  }
  const requestedRoot = resolve11(sourceRootInput);
  if (!existsSync8(requestedRoot)) {
    throw new Error(`prompt-policy source root is missing: ${requestedRoot}`);
  }
  if (lstatSync9(requestedRoot).isSymbolicLink()) {
    throw new Error(`prompt-policy source root may not use symlinked parents: ${requestedRoot}`);
  }
  if (!lstatSync9(requestedRoot).isDirectory()) {
    throw new Error(`prompt-policy source root is not a directory: ${requestedRoot}`);
  }
  const sourceRoot = realpathSync5(requestedRoot);
  const descriptorPath = portableRelativePath(descriptorPathInput, "prompt-policy descriptor path");
  const packagedDescriptorPath = PROMPT_POLICY_DESCRIPTOR_PATHS.packagedPath;
  const descriptorSuffix = `/${packagedDescriptorPath}`;
  const sourcePrefix = descriptorPath === packagedDescriptorPath ? "" : descriptorPath.endsWith(descriptorSuffix) ? descriptorPath.slice(0, -descriptorSuffix.length) : undefined;
  if (sourcePrefix === undefined) {
    throw new Error(`prompt-policy descriptor path must end in ${packagedDescriptorPath}`);
  }
  const descriptorAbsolute = resolveContainedFile(sourceRoot, descriptorPath, "prompt-policy descriptor");
  const descriptorBytes = readFileSync8(descriptorAbsolute);
  validateText2(descriptorBytes, "prompt-policy descriptor");
  rejectMachinePaths2(descriptorBytes, "prompt-policy descriptor");
  const descriptor = record2(readJsonFile(descriptorAbsolute, "prompt-policy descriptor"), "prompt-policy descriptor");
  exactKeys2(descriptor, ["schema", "version", "base", "developerInstructions", "compactPrompt"], "prompt-policy descriptor");
  if (descriptor["schema"] !== "skizzles.prompt-policy" || descriptor["version"] !== 1) {
    throw new Error("unsupported prompt-policy descriptor schema or version");
  }
  const base = record2(descriptor["base"], "prompt-policy base");
  exactKeys2(base, ["role", "applied", "provenance", "upstream", "legal"], "prompt-policy base");
  const role = stringValue2(base["role"], "prompt-policy base role");
  const applied = parseFileFact(base["applied"], "base applied prompt");
  const provenance = parseFileFact(base["provenance"], "base provenance");
  const upstream = parseUpstreamFact(base["upstream"]);
  const legal = record2(base["legal"], "prompt-policy legal inputs");
  exactKeys2(legal, ["license", "notice"], "prompt-policy legal inputs");
  const license = parseLegalFact(legal["license"], "prompt-policy LICENSE");
  const notice = parseLegalFact(legal["notice"], "prompt-policy NOTICE");
  assertCanonicalLegalMappings(license, notice);
  const developerInstructions = parseFileFact(descriptor["developerInstructions"], "developer instructions");
  const compactPrompt = parseFileFact(descriptor["compactPrompt"], "compact prompt");
  const facts = {
    descriptor: {
      path: descriptorPath,
      ...digest(descriptorBytes)
    },
    role,
    applied,
    provenance,
    upstream,
    license,
    notice,
    developerInstructions,
    compactPrompt
  };
  const appliedBytes = readFactFile(sourceRoot, sourcePrefix, applied, "applied base prompt");
  const provenanceBytes2 = readFactFile(sourceRoot, sourcePrefix, provenance, "base provenance");
  const developerBytes = readFactFile(sourceRoot, sourcePrefix, developerInstructions, "developer instructions");
  const compactBytes = readFactFile(sourceRoot, sourcePrefix, compactPrompt, "compact prompt");
  readLegalFile(sourceRoot, license, "LICENSE");
  readLegalFile(sourceRoot, notice, "NOTICE");
  for (const [bytes, label] of [
    [appliedBytes, "applied base prompt"],
    [provenanceBytes2, "base provenance"],
    [developerBytes, "developer instructions"],
    [compactBytes, "compact prompt"]
  ]) {
    validateText2(bytes, label);
    rejectMachinePaths2(bytes, label);
  }
  validateProvenance(provenanceBytes2, facts);
  return {
    facts,
    applied: appliedBytes,
    developerInstructions: developerBytes.toString("utf8"),
    compactPrompt: compactBytes.toString("utf8")
  };
}
function parseFileFact(value, label) {
  const object = record2(value, label);
  exactKeys2(object, ["path", "sha256", "bytes"], label);
  const path = portableRelativePath(object["path"], `${label} path`);
  return {
    path,
    sha256: sha256Value(object["sha256"], `${label} sha256`),
    bytes: bytesValue(object["bytes"], `${label} bytes`)
  };
}
function parseLegalFact(value, label) {
  const object = record2(value, label);
  exactKeys2(object, ["sourcePath", "packagedPath", "sha256", "bytes"], label);
  return {
    sourcePath: portableRelativePath(object["sourcePath"], `${label} sourcePath`),
    packagedPath: portableRelativePath(object["packagedPath"], `${label} packagedPath`),
    sha256: sha256Value(object["sha256"], `${label} sha256`),
    bytes: bytesValue(object["bytes"], `${label} bytes`)
  };
}
function assertCanonicalLegalMappings(license, notice) {
  const canonicalSourceRoot = dirname7(dirname7(PROMPT_POLICY_DESCRIPTOR_PATHS.canonicalWorkspacePath));
  if (license.sourcePath !== `${canonicalSourceRoot}/upstream/LICENSE` || license.packagedPath !== "third_party/openai-codex/LICENSE" || notice.sourcePath !== `${canonicalSourceRoot}/upstream/NOTICE` || notice.packagedPath !== "third_party/openai-codex/NOTICE") {
    throw new Error("prompt-policy legal paths must use the exact canonical LICENSE and NOTICE mappings");
  }
}
function parseUpstreamFact(value) {
  const object = record2(value, "prompt-policy upstream");
  exactKeys2(object, ["repository", "commit", "path", "sha256", "bytes"], "prompt-policy upstream");
  const repository = stringValue2(object["repository"], "upstream repository");
  if (repository !== "https://github.com/openai/codex") {
    throw new Error("prompt-policy upstream repository must be official OpenAI Codex");
  }
  const commit = stringValue2(object["commit"], "upstream commit");
  if (!IMMUTABLE_COMMIT_PATTERN.test(commit)) {
    throw new Error("upstream commit must be immutable lowercase SHA-1");
  }
  return {
    repository,
    commit,
    path: portableRelativePath(object["path"], "upstream path"),
    sha256: sha256Value(object["sha256"], "upstream sha256"),
    bytes: bytesValue(object["bytes"], "upstream bytes")
  };
}
function readFactFile(root, sourcePrefix, fact, label) {
  const path = sourcePrefix ? join14(sourcePrefix, fact.path) : fact.path;
  const bytes = readFileSync8(resolveContainedFile(root, path, label));
  assertDigest(bytes, fact, label);
  return bytes;
}
function readLegalFile(root, fact, label) {
  const candidates = [fact.sourcePath, fact.packagedPath].filter((path) => existsSync8(resolve11(root, path)));
  if (candidates.length === 0) {
    throw new Error(`${label} is missing from source and packaged policy paths`);
  }
  let selected;
  for (const path of candidates) {
    const bytes = readFileSync8(resolveContainedFile(root, path, label));
    assertDigest(bytes, fact, label);
    selected ??= bytes;
  }
  if (!selected) {
    throw new Error(`${label} has no readable policy input`);
  }
  return selected;
}
function validateProvenance(bytes, facts) {
  const provenance = record2(JSON.parse(bytes.toString("utf8")), "base provenance");
  if (provenance["schema"] !== "skizzles.prompt-layer" || provenance["version"] !== 1 || provenance["baselineRole"] !== facts.role) {
    throw new Error("base provenance schema, version, or role does not match prompt-policy descriptor");
  }
  const upstream = record2(provenance["upstream"], "base provenance upstream");
  for (const key of [
    "repository",
    "commit",
    "path",
    "sha256",
    "bytes"
  ]) {
    if (upstream[key] !== facts.upstream[key]) {
      throw new Error(`base provenance upstream ${key} does not match prompt-policy descriptor`);
    }
  }
  const output = record2(provenance["output"], "base provenance output");
  if (output["sha256"] !== facts.applied.sha256 || output["bytes"] !== facts.applied.bytes) {
    throw new Error("base provenance output does not match applied prompt descriptor");
  }
  const legal = record2(provenance["legal"], "base provenance legal");
  for (const [name, fact] of [
    ["license", facts.license],
    ["notice", facts.notice]
  ]) {
    const item = record2(legal[name], `base provenance ${name}`);
    if (item["sha256"] !== fact.sha256 || item["bytes"] !== fact.bytes) {
      throw new Error(`base provenance ${name} does not match prompt-policy descriptor`);
    }
  }
}
function resolveContainedFile(root, path, label) {
  const portable = portableRelativePath(path, `${label} path`);
  const absolute = resolve11(root, portable);
  const containment = relative4(root, absolute);
  if (containment.startsWith("..") || isAbsolute5(containment)) {
    throw new Error(`${label} escapes prompt-policy source root`);
  }
  let current = root;
  for (const segment of portable.split("/")) {
    current = join14(current, segment);
    if (!pathEntryExists(current)) {
      throw new Error(`${label} is missing: ${portable}`);
    }
    const metadata = lstatSync9(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} uses a symlink: ${portable}`);
    }
  }
  if (!lstatSync9(absolute).isFile() || realpathSync5(absolute) !== absolute) {
    throw new Error(`${label} must be a contained regular file: ${portable}`);
  }
  return absolute;
}
function portableRelativePath(value, label) {
  const path = stringValue2(value, label);
  if (path.length === 0 || isAbsolute5(path) || path.includes("\\") || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a normalized portable relative path`);
  }
  return path;
}
function assertDigest(bytes, fact, label) {
  const actual = digest(bytes);
  if (actual.sha256 !== fact.sha256 || actual.bytes !== fact.bytes) {
    throw new Error(`${label} digest or byte count does not match prompt-policy descriptor`);
  }
}
function digest(bytes) {
  return {
    sha256: createHash2("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength
  };
}
function validateText2(bytes, label) {
  if (bytes.length === 0 || bytes.includes(0) || bytes.at(-1) !== 10 || bytes.includes(Buffer.from("\r"))) {
    throw new Error(`${label} must be non-empty LF text with a final newline and no NUL`);
  }
}
function rejectMachinePaths2(bytes, label) {
  const text = bytes.toString("utf8");
  const match = MACHINE_PATH_PATTERNS.find((pattern) => pattern.test(text));
  if (match) {
    throw new Error(`${label} contains a machine-specific path`);
  }
}
function exactKeys2(object, expected, label) {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.join("\x00") !== wanted.join("\x00")) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}
function record2(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}
function jsonValue(value, label) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => jsonValue(item, `${label}[${index}]`));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = jsonValue(item, `${label}.${key}`);
    }
    return result;
  }
  throw new Error(`${label} must be a JSON value`);
}
function stringValue2(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}
function sha256Value(value, label) {
  const text = stringValue2(value, label);
  if (!SHA256_PATTERN.test(text)) {
    throw new Error(`${label} must be lowercase SHA-256`);
  }
  return text;
}
function bytesValue(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}
function publicFileFact(fact) {
  return { sha256: fact.sha256, bytes: fact.bytes };
}
function publicLegalFact(fact) {
  return { sha256: fact.sha256, bytes: fact.bytes };
}

// packages/installer/src/prompt-policy/managed-state.ts
var PROMPT_POLICY_KEYS = [
  "model_instructions_file",
  "developer_instructions",
  "compact_prompt"
];
function createManagedTarget(context, bytes) {
  const skizzlesDirectory = dirname8(context.managedDirectory);
  mkdirSync9(skizzlesDirectory, { recursive: true, mode: 448 });
  chmodSync6(skizzlesDirectory, 448);
  let createdDirectory = false;
  let createdTarget;
  try {
    mkdirSync9(context.managedDirectory, { mode: 448 });
    createdDirectory = true;
    chmodSync6(context.managedDirectory, 448);
    writeFileSync6(context.managedTarget, bytes, { flag: "wx", mode: 384 });
    createdTarget = fileIdentity4(context.managedTarget);
    chmodSync6(context.managedTarget, 384);
    return createdTarget;
  } catch (error) {
    if (createdTarget) {
      removeOwnedIdentity(context.managedTarget, createdTarget);
    }
    if (createdDirectory) {
      removeDirectoryIfEmpty(context.managedDirectory);
    }
    throw error;
  }
}
function readAndValidateReceipt(context) {
  assertPrivateDirectory(dirname8(context.receiptPath), ".skizzles directory");
  if (pathEntryExists(context.managedDirectory)) {
    assertPrivateDirectory(context.managedDirectory, "prompt-policy managed directory");
  }
  assertRegularPrivateFile(context.receiptPath, "prompt-policy receipt");
  const value = record2(readJsonFile(context.receiptPath, "Skizzles prompt-policy receipt"), "prompt-policy receipt");
  exactKeys2(value, [
    "schema",
    "version",
    "state",
    "codexBinary",
    "configPath",
    "managedTarget",
    "policy",
    "values"
  ], "prompt-policy receipt");
  if (value["schema"] !== "skizzles.prompt-policy-receipt" || value["version"] !== 1) {
    throw new Error("invalid prompt-policy receipt schema, version, or state");
  }
  const state = receiptState(value["state"]);
  const codexBinary = stringValue2(value["codexBinary"], "receipt Codex binary");
  if (!isAbsolute6(codexBinary) || resolve12(codexBinary) !== context.codexBinary) {
    throw new Error(`use the Codex binary recorded by the prompt-policy receipt: ${codexBinary}`);
  }
  const configPath = stringValue2(value["configPath"], "receipt config path");
  if (!isAbsolute6(configPath) || resolve12(configPath) !== context.configPath) {
    throw new Error("prompt-policy receipt config path is outside selected CODEX_HOME");
  }
  const targetObject = record2(value["managedTarget"], "receipt managed target");
  exactKeys2(targetObject, ["path", "sha256", "bytes"], "receipt managed target");
  const target = {
    path: stringValue2(targetObject["path"], "receipt managed target path"),
    sha256: sha256Value(targetObject["sha256"], "receipt managed target sha256"),
    bytes: bytesValue(targetObject["bytes"], "receipt managed target bytes")
  };
  if (!isAbsolute6(target.path) || resolve12(target.path) !== context.managedTarget) {
    throw new Error("prompt-policy receipt managed target is escaped or swapped");
  }
  const policy = validateReceiptPolicy(value["policy"]);
  const values = parseReceiptValues(value["values"], target, policy);
  const receipt = {
    schema: "skizzles.prompt-policy-receipt",
    version: 1,
    state,
    codexBinary,
    configPath,
    managedTarget: target,
    policy,
    values
  };
  return receipt;
}
function receiptState(value) {
  if (value === "pending" || value === "active" || value === "restoring") {
    return value;
  }
  throw new Error("invalid prompt-policy receipt schema, version, or state");
}
function validateReceiptPolicy(value) {
  const object = record2(value, "receipt policy facts");
  exactKeys2(object, [
    "descriptor",
    "role",
    "applied",
    "provenance",
    "upstream",
    "license",
    "notice",
    "developerInstructions",
    "compactPrompt"
  ], "receipt policy facts");
  const policy = {
    descriptor: parseFileFact(object["descriptor"], "receipt descriptor"),
    role: stringValue2(object["role"], "receipt policy role"),
    applied: parseFileFact(object["applied"], "receipt applied prompt"),
    provenance: parseFileFact(object["provenance"], "receipt provenance"),
    upstream: parseUpstreamFact(object["upstream"]),
    license: parseLegalFact(object["license"], "receipt LICENSE"),
    notice: parseLegalFact(object["notice"], "receipt NOTICE"),
    developerInstructions: parseFileFact(object["developerInstructions"], "receipt developer instructions"),
    compactPrompt: parseFileFact(object["compactPrompt"], "receipt compact prompt")
  };
  assertCanonicalLegalMappings(policy.license, policy.notice);
  return policy;
}
function parseReceiptValues(value, managedTarget, policy) {
  if (!Array.isArray(value) || value.length !== PROMPT_POLICY_KEYS.length) {
    throw new Error("prompt-policy receipt must own exactly three config values");
  }
  const values = [];
  for (const [index, expectedKey] of PROMPT_POLICY_KEYS.entries()) {
    const owned = record2(value[index], `receipt value ${expectedKey}`);
    exactKeys2(owned, ["keyPath", "beforePresent", "before", "after"], `receipt value ${expectedKey}`);
    if (owned["keyPath"] !== expectedKey || typeof owned["beforePresent"] !== "boolean") {
      throw new Error(`prompt-policy receipt has invalid owned key ${expectedKey}`);
    }
    values.push({
      keyPath: expectedKey,
      beforePresent: owned["beforePresent"],
      before: jsonValue(owned["before"], `receipt ${expectedKey} before`),
      after: jsonValue(owned["after"], `receipt ${expectedKey} after`)
    });
  }
  const modelInstructionsAfter = values[0]?.after;
  if (typeof modelInstructionsAfter !== "string") {
    throw new Error("receipt model instructions target must be a string");
  }
  if (modelInstructionsAfter !== managedTarget.path) {
    throw new Error("prompt-policy receipt model instructions target is swapped");
  }
  for (const [index, fact, label] of [
    [1, policy.developerInstructions, "developer instructions"],
    [2, policy.compactPrompt, "compact prompt"]
  ]) {
    const after = values[index]?.after;
    if (typeof after !== "string") {
      throw new Error(`receipt ${label} is not a string`);
    }
    assertDigest(Buffer.from(after), fact, `receipt ${label}`);
  }
  if (managedTarget.sha256 !== policy.applied.sha256 || managedTarget.bytes !== policy.applied.bytes) {
    throw new Error("receipt managed target fact does not match applied prompt fact");
  }
  return values;
}
function validateManagedTarget(context, receipt) {
  assertPrivateDirectory(dirname8(context.managedDirectory), ".skizzles directory");
  assertPrivateDirectory(context.managedDirectory, "prompt-policy managed directory");
  assertRegularPrivateFile(context.managedTarget, "prompt-policy managed target");
  const bytes = readFileSync9(context.managedTarget);
  assertDigest(bytes, receipt.managedTarget, "prompt-policy managed target");
}
function validateSourceMatchesReceipt(source, receipt) {
  if (JSON.stringify(source.facts) !== JSON.stringify(receipt.policy)) {
    throw new Error("selected prompt-policy source does not match the pending receipt");
  }
}
function cleanupNewPolicyFiles(context, managedIdentity, receiptIdentity) {
  const receiptPresent = receiptIdentity ? assertOwnedIdentity(context.receiptPath, receiptIdentity) : false;
  const managedPresent = assertOwnedIdentity(context.managedTarget, managedIdentity);
  if (receiptPresent) {
    rmSync7(context.receiptPath);
  }
  if (managedPresent) {
    rmSync7(context.managedTarget);
  }
  removeDirectoryIfEmpty(context.managedDirectory);
}
function cleanupOwnedPolicyFiles(context, receipt) {
  if (pathEntryExists(context.managedTarget)) {
    validateManagedTarget(context, receipt);
    rmSync7(context.managedTarget);
  }
  removeDirectoryIfEmpty(context.managedDirectory);
  rmSync7(context.receiptPath, { force: true });
}
function removeDirectoryIfEmpty(path) {
  if (existsSync9(path) && readdirSync4(path).length === 0) {
    rmdirSync2(path);
  }
}
function fileIdentity4(path) {
  const metadata = lstatSync10(path);
  return { dev: metadata.dev, ino: metadata.ino };
}
function removeOwnedIdentity(path, expected) {
  if (!assertOwnedIdentity(path, expected)) {
    return;
  }
  rmSync7(path);
}
function assertOwnedIdentity(path, expected) {
  if (!pathEntryExists(path)) {
    return false;
  }
  const actual = fileIdentity4(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(`refusing to clean replaced prompt-policy owned file: ${path}`);
  }
  return true;
}
function throwConfigDrift(config, receipt, operation) {
  const drifted = receipt.values.filter((value) => {
    const current = configValue(config, value.keyPath);
    const before = current.present === value.beforePresent && (!value.beforePresent || sameJson(current.value, value.before));
    const after = current.present && sameJson(current.value, value.after);
    return !(before || after);
  }).map(({ keyPath }) => keyPath);
  const keys = drifted.length > 0 ? drifted : PROMPT_POLICY_KEYS;
  throw new Error(`refusing to ${operation} drifted prompt-policy config keys: ${keys.join(", ")}`);
}
function configValue(root, keyPath) {
  let current = root;
  for (const segment of keyPath.split(".")) {
    if (current === null || Array.isArray(current) || typeof current !== "object" || !(segment in current)) {
      return { present: false, value: null };
    }
    const next = current[segment];
    if (next === undefined) {
      return { present: false, value: null };
    }
    current = next;
  }
  return { present: true, value: current };
}
function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function assertRegularPrivateFile(path, label) {
  if (!pathEntryExists(path)) {
    throw new Error(`${label} is missing: ${path}`);
  }
  const metadata = lstatSync10(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a non-symlink regular file`);
  }
  if ((metadata.mode & 511) !== 384) {
    throw new Error(`${label} must have owner-only mode 0600`);
  }
}
function assertPrivateDirectory(path, label) {
  if (!pathEntryExists(path)) {
    throw new Error(`${label} is missing: ${path}`);
  }
  const metadata = lstatSync10(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  if ((metadata.mode & 511) !== 448) {
    throw new Error(`${label} must have owner-only mode 0700`);
  }
}

// packages/installer/src/prompt-policy.ts
var RECEIPT_NAME = "prompt-policy-receipt.json";
var MANAGED_DIRECTORY = "prompt-policy";
var MANAGED_FILE = "skizzles-base.md";
function applyPromptPolicy(options) {
  return withPromptPolicyLock(canonicalExistingPath(options.codexHome), "apply", options.lockOptions, () => applyPromptPolicyUnlocked(options));
}
async function applyPromptPolicyUnlocked(options) {
  const context = validateContext(options);
  const source = readPolicySource(options.sourceRoot, options.sourceDescriptor?.descriptorPath ?? descriptorPathForSourceRoot(options.sourceRoot));
  const receiptExists = pathEntryExists(context.receiptPath);
  const targetExists = pathEntryExists(context.managedTarget);
  if (receiptExists !== targetExists) {
    throw new Error("prompt-policy receipt/managed-target ownership is incomplete; refusing mutation");
  }
  if (receiptExists) {
    const receipt = readAndValidateReceipt(context);
    validateManagedTarget(context, receipt);
    validateSourceMatchesReceipt(source, receipt);
    if (receipt.state === "active") {
      throw new Error("prompt policy is already active");
    }
    if (receipt.state === "restoring") {
      throw new Error("prompt policy restoration is pending; run prompt-policy restore");
    }
    return resumeApply(options, context, receipt);
  }
  const rpcSession = await openConfigRpcSession({
    codexHome: context.codexHome,
    codexBinary: context.codexBinary,
    dryRun: options.dryRun,
    rpcFactory: options.rpcFactory,
    workspace: options.workspace
  });
  const { rpc } = rpcSession;
  try {
    const layer = selectedUserLayer(await rpc.read(), rpcSession.configPath);
    const edits = policyEdits(context.managedTarget, source);
    const receipt = {
      schema: "skizzles.prompt-policy-receipt",
      version: 1,
      state: "pending",
      codexBinary: context.codexBinary,
      configPath: context.configPath,
      managedTarget: {
        path: context.managedTarget,
        sha256: source.facts.applied.sha256,
        bytes: source.facts.applied.bytes
      },
      policy: source.facts,
      values: snapshotConfigValues(layer.config, edits)
    };
    const outcome = {
      receipt,
      action: "apply",
      managedTargetClassification: "new-managed-copy"
    };
    if (options.dryRun) {
      return outcome;
    }
    const managedIdentity = createManagedTarget(context, source.applied);
    let receiptIdentity;
    try {
      writePrivateJson(context.receiptPath, receipt, true);
      receiptIdentity = fileIdentity4(context.receiptPath);
    } catch (error) {
      cleanupNewPolicyFiles(context, managedIdentity);
      throw error;
    }
    await options.afterPendingReceipt?.();
    try {
      await rpc.batchWrite({
        edits,
        filePath: context.configPath,
        expectedVersion: layer.version,
        reloadUserConfig: true
      });
    } catch (error) {
      if (isConfigVersionConflict(error)) {
        cleanupNewPolicyFiles(context, managedIdentity, receiptIdentity);
      }
      throw safeConfigWriteError(error);
    }
    options.afterBatchWrite?.();
    receipt.state = "active";
    writePrivateJson(context.receiptPath, receipt);
    return outcome;
  } finally {
    try {
      await rpc.close();
    } finally {
      await rpcSession.cleanup();
    }
  }
}
async function resumeApply(options, context, receipt) {
  const rpcSession = await openConfigRpcSession({
    codexHome: context.codexHome,
    codexBinary: context.codexBinary,
    dryRun: options.dryRun,
    rpcFactory: options.rpcFactory,
    workspace: options.workspace
  });
  const { rpc } = rpcSession;
  try {
    const layer = selectedUserLayer(await rpc.read(), rpcSession.configPath);
    const atBefore = valuesMatchBefore(layer.config, receipt.values);
    const atAfter = valuesMatchAfter(layer.config, receipt.values);
    if (!(atBefore || atAfter)) {
      throwConfigDrift(layer.config, receipt, "resume");
    }
    const outcome = {
      receipt,
      action: atAfter ? "activate-recovered" : "resume-apply",
      managedTargetClassification: "owned-managed-copy"
    };
    if (options.dryRun) {
      return outcome;
    }
    if (atBefore) {
      try {
        await rpc.batchWrite({
          edits: receipt.values.map(({ keyPath, after }) => ({
            keyPath,
            value: after,
            mergeStrategy: "replace"
          })),
          filePath: context.configPath,
          expectedVersion: layer.version,
          reloadUserConfig: true
        });
      } catch (error) {
        throw safeConfigWriteError(error);
      }
      options.afterBatchWrite?.();
    }
    receipt.state = "active";
    writePrivateJson(context.receiptPath, receipt);
    return outcome;
  } finally {
    try {
      await rpc.close();
    } finally {
      await rpcSession.cleanup();
    }
  }
}
function restorePromptPolicy(options) {
  return withPromptPolicyLock(canonicalExistingPath(options.codexHome), "restore", options.lockOptions, () => restorePromptPolicyUnlocked(options));
}
async function restorePromptPolicyUnlocked(options) {
  const context = validateContext(options);
  if (!pathEntryExists(context.receiptPath)) {
    throw new Error(`Skizzles prompt-policy receipt is missing: ${context.receiptPath}`);
  }
  const receipt = readAndValidateReceipt(context);
  const managedTargetExists = pathEntryExists(context.managedTarget);
  if (managedTargetExists) {
    validateManagedTarget(context, receipt);
  } else if (receipt.state !== "restoring") {
    throw new Error("prompt-policy managed target is missing; retaining receipt evidence");
  }
  const rpcSession = await openConfigRpcSession({
    codexHome: context.codexHome,
    codexBinary: context.codexBinary,
    dryRun: options.dryRun,
    rpcFactory: options.rpcFactory,
    workspace: options.workspace
  });
  const { rpc } = rpcSession;
  try {
    const layer = selectedUserLayer(await rpc.read(), rpcSession.configPath);
    const atBefore = valuesMatchBefore(layer.config, receipt.values);
    const atAfter = valuesMatchAfter(layer.config, receipt.values);
    if (receipt.state === "restoring" && atBefore) {
      const outcome2 = {
        receipt,
        action: "finish-restore",
        managedTargetClassification: "owned-managed-copy"
      };
      if (!options.dryRun) {
        cleanupOwnedPolicyFiles(context, receipt);
      }
      return outcome2;
    }
    if (!managedTargetExists) {
      throw new Error("prompt-policy managed target disappeared before restoration completed; retaining receipt evidence");
    }
    if (receipt.state === "pending" && atBefore) {
      const outcome2 = {
        receipt,
        action: "discard-pending",
        managedTargetClassification: "owned-managed-copy"
      };
      if (!options.dryRun) {
        cleanupOwnedPolicyFiles(context, receipt);
      }
      return outcome2;
    }
    if (!atAfter) {
      throwConfigDrift(layer.config, receipt, "restore");
    }
    const outcome = {
      receipt,
      action: "restore",
      managedTargetClassification: "owned-managed-copy"
    };
    if (options.dryRun) {
      return outcome;
    }
    receipt.state = "restoring";
    writePrivateJson(context.receiptPath, receipt);
    try {
      await rpc.batchWrite({
        edits: restoreConfigEdits(receipt.values),
        filePath: context.configPath,
        expectedVersion: layer.version,
        reloadUserConfig: true
      });
    } catch (error) {
      throw safeConfigWriteError(error);
    }
    options.afterBatchWrite?.();
    cleanupOwnedPolicyFiles(context, receipt);
    return outcome;
  } finally {
    try {
      await rpc.close();
    } finally {
      await rpcSession.cleanup();
    }
  }
}
function promptPolicySummary(outcome, dryRun) {
  const { receipt } = outcome;
  return {
    ok: true,
    dryRun,
    surface: "prompt-policy",
    action: outcome.action,
    state: receipt.state,
    configPath: receipt.configPath,
    keys: receipt.values.map(({ keyPath, beforePresent }) => ({
      keyPath,
      beforePresent
    })),
    policy: {
      descriptor: publicFileFact(receipt.policy.descriptor),
      applied: publicFileFact(receipt.policy.applied),
      developerInstructions: publicFileFact(receipt.policy.developerInstructions),
      compactPrompt: publicFileFact(receipt.policy.compactPrompt),
      license: publicLegalFact(receipt.policy.license),
      notice: publicLegalFact(receipt.policy.notice)
    },
    managedTarget: {
      path: receipt.managedTarget.path,
      classification: outcome.managedTargetClassification,
      sha256: receipt.managedTarget.sha256,
      bytes: receipt.managedTarget.bytes
    },
    sessionImpact: "new Codex sessions required",
    compactPromptScope: "local compaction only; remote compaction may bypass it"
  };
}
function validateContext(options) {
  if (!isAbsolute7(options.codexHome)) {
    throw new Error("--codex-home must be an absolute path");
  }
  const codexHome = canonicalExistingPath(options.codexHome);
  if (!(existsSync10(codexHome) && lstatSync11(codexHome).isDirectory())) {
    throw new Error(`CODEX_HOME is missing or not a directory: ${codexHome}`);
  }
  if (lstatSync11(resolve13(options.codexHome)).isSymbolicLink()) {
    throw new Error(`CODEX_HOME may not be a symlink: ${options.codexHome}`);
  }
  assertManagedParentsAreReal(codexHome, [
    ".skizzles",
    `.skizzles/${MANAGED_DIRECTORY}`
  ]);
  const codexBinary = validateCodexBinary(options.codexBinary);
  return {
    codexHome,
    codexBinary,
    configPath: join15(codexHome, "config.toml"),
    receiptPath: join15(codexHome, ".skizzles", RECEIPT_NAME),
    managedDirectory: join15(codexHome, ".skizzles", MANAGED_DIRECTORY),
    managedTarget: join15(codexHome, ".skizzles", MANAGED_DIRECTORY, MANAGED_FILE)
  };
}
function policyEdits(target, source) {
  return [
    { keyPath: PROMPT_POLICY_KEYS[0], value: target, mergeStrategy: "replace" },
    {
      keyPath: PROMPT_POLICY_KEYS[1],
      value: source.developerInstructions,
      mergeStrategy: "replace"
    },
    {
      keyPath: PROMPT_POLICY_KEYS[2],
      value: source.compactPrompt,
      mergeStrategy: "replace"
    }
  ];
}
function descriptorPathForSourceRoot(sourceRoot) {
  const canonical = PROMPT_POLICY_DESCRIPTOR_PATHS.canonicalWorkspacePath;
  if (existsSync10(resolve13(sourceRoot, canonical))) {
    return canonical;
  }
  return PROMPT_POLICY_DESCRIPTOR_PATHS.packagedPath;
}

// packages/installer/src/cli.ts
async function main(argv = process9.argv.slice(2)) {
  const parsed = parseInstallerCommand(argv);
  await runInstallerOperation(async (workspace) => {
    await execute(parsed, workspace);
  });
}
async function execute(parsed, workspace) {
  switch (parsed.command) {
    case "doctor": {
      const report2 = doctor(parsed.home, parsed.codexHome, undefined, workspace);
      console.log(JSON.stringify(report2));
      if (!report2.ok) {
        process9.exitCode = 1;
      }
      return;
    }
    case "configure": {
      const receipt = await configureCodex({ ...parsed, workspace });
      printConfigSummary(receipt, parsed.dryRun);
      return;
    }
    case "unconfigure": {
      const receipt = await unconfigureCodex({ ...parsed, workspace });
      printConfigSummary(receipt, parsed.dryRun);
      return;
    }
    case "prompt-policy": {
      const outcome = parsed.action === "apply" ? await applyPromptPolicy({ ...parsed, workspace }) : await restorePromptPolicy({ ...parsed, workspace });
      console.log(JSON.stringify(promptPolicySummary(outcome, parsed.dryRun)));
      return;
    }
    case "install": {
      if (parsed.surface === "skills") {
        const receipt2 = installSkills(parsed);
        console.log(JSON.stringify({
          ok: true,
          dryRun: parsed.dryRun,
          ...receiptSummary(receipt2)
        }));
        return;
      }
      const receipt = installHarness(parsed);
      printHarnessSummary(receipt, parsed.dryRun);
      return;
    }
    case "uninstall": {
      if (parsed.surface === "skills") {
        const receipt2 = uninstallSkills(parsed.codexHome, parsed.dryRun);
        console.log(JSON.stringify({
          ok: true,
          dryRun: parsed.dryRun,
          ...receiptSummary(receipt2)
        }));
        return;
      }
      const receipt = uninstallHarness(parsed.home, parsed.dryRun);
      printHarnessSummary(receipt, parsed.dryRun);
      return;
    }
    default:
      return assertNever(parsed);
  }
}
function printConfigSummary(receipt, dryRun) {
  const summary = {
    ok: true,
    dryRun,
    surface: "config",
    orchestration: receipt.orchestration,
    instructions: receipt.instructions ?? "native",
    configPath: receipt.configPath,
    keys: receipt.values.map(({ keyPath }) => keyPath)
  };
  if (receipt.sourceRoot !== undefined) {
    summary["sourceRoot"] = receipt.sourceRoot;
  }
  console.log(JSON.stringify(summary));
}
function printHarnessSummary(receipt, dryRun) {
  console.log(JSON.stringify({
    ok: true,
    dryRun,
    surface: "harness",
    transfer: receipt.transfer,
    pluginTarget: receipt.pluginTarget
  }));
}
function assertNever(value) {
  throw new Error(`unreachable installer command: ${JSON.stringify(value)}`);
}
function exitCodeForError(error) {
  if (error instanceof RunWorkspaceAbortedError) {
    if (error.signal === "SIGHUP")
      return 129;
    if (error.signal === "SIGINT")
      return 130;
    if (error.signal === "SIGTERM")
      return 143;
  }
  return 1;
}
if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "installer failed");
    process9.exit(exitCodeForError(error));
  });
}
export {
  main,
  exitCodeForError
};
