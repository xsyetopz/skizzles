#!/usr/bin/env bun
// @bun

// packages/model-catalog/src/index.ts
import process8 from "process";

// packages/model-catalog/src/catalog/refresh.ts
import { join as join8, resolve as resolve3 } from "path";

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
// packages/model-catalog/src/codex/child.ts
import { lstat as lstat3, mkdir as mkdir2, realpath as realpath2, writeFile } from "fs/promises";
import { isAbsolute as isAbsolute2, join as join6 } from "path";
import process6 from "process";

// packages/model-catalog/src/catalog/schema.ts
var LUNA_MODEL = "gpt-5.6-luna";
var REQUIRED_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  LUNA_MODEL
];
function object(value, label) {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}
function isJsonObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
function parseJson(contents) {
  const value = JSON.parse(contents);
  return value;
}
function parseCatalogCache(value) {
  if (!isJsonObject(value)) {
    throw new Error("model catalog cache is invalid");
  }
  try {
    const clientVersion = value["client_version"];
    const fetchedAt = value["fetched_at"];
    const modelsValue = value["models"];
    if (typeof clientVersion !== "string" || typeof fetchedAt !== "string" || !Array.isArray(modelsValue) || !modelsValue.every(isJsonObject)) {
      throw new Error("model catalog cache is invalid");
    }
    return {
      ...value,
      client_version: clientVersion,
      fetched_at: fetchedAt,
      models: modelsValue
    };
  } catch {
    throw new Error("model catalog cache is invalid");
  }
}
function catalog(value) {
  const root = object(value, "model catalog");
  const modelsValue = root["models"];
  if (!Array.isArray(modelsValue) || modelsValue.length === 0) {
    throw new Error("model catalog must contain models");
  }
  const models = modelsValue.map((model, index) => object(model, `model ${index}`));
  return { ...root, models };
}
function assertCompleteCatalog(value) {
  const root = catalog(value);
  const slugs = new Set(root.models.map((model) => model["slug"]));
  const missing = REQUIRED_MODELS.filter((slug) => !slugs.has(slug));
  if (missing.length > 0) {
    throw new Error(`model catalog is incomplete; missing ${missing.join(", ")}`);
  }
  return root;
}
function applyLunaV2Overlay(value) {
  const cloned = assertCompleteCatalog(structuredClone(value));
  const matches = cloned.models.filter((model) => model["slug"] === LUNA_MODEL);
  const luna = matches[0];
  if (matches.length !== 1 || luna === undefined) {
    throw new Error(`expected exactly one ${LUNA_MODEL} model, found ${matches.length}`);
  }
  if (luna["multi_agent_version"] === "v2") {
    return { catalog: cloned, overlay: "upstream-v2" };
  }
  if (luna["multi_agent_version"] !== "v1") {
    throw new Error(`${LUNA_MODEL} has unexpected multi_agent_version`);
  }
  luna["multi_agent_version"] = "v2";
  return { catalog: cloned, overlay: "applied" };
}

// packages/model-catalog/src/codex/group.ts
import process4 from "process";
var FORCED_EXIT_TIMEOUT_MS = 2000;
function signalOwnedCodexSupervisor(supervisorExited, pid, signal, kill = process4.kill) {
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
async function settlesWithin(settled, milliseconds) {
  const timeout = Promise.withResolvers();
  const timer = setTimeout(() => timeout.resolve(false), milliseconds);
  try {
    return await Promise.race([
      settled.then(() => true),
      timeout.promise
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function codexSupervisorGroup(child, label, kill = process4.kill) {
  let exitObserved = false;
  const signal = (value) => {
    if (exitObserved)
      return false;
    const supervisorExited = child.exitCode !== null;
    if (supervisorExited) {
      exitObserved = true;
      return false;
    }
    return signalOwnedCodexSupervisor(false, child.pid, value, kill);
  };
  const waitForExit = async () => {
    if (exitObserved)
      return;
    await child.exited;
    exitObserved = true;
  };
  const stopWithin = async (graceMs) => {
    let gracefulError;
    try {
      signal("SIGTERM");
    } catch (error) {
      gracefulError = error;
    }
    if (exitObserved || gracefulError === undefined && await settlesWithin(child.exited, graceMs)) {
      exitObserved = true;
      return;
    }
    try {
      signal("SIGKILL");
    } catch (forceError) {
      if (gracefulError !== undefined) {
        throw new AggregateError([gracefulError, forceError], "Codex supervisor termination signals failed");
      }
      throw forceError;
    }
    if (exitObserved)
      return;
    if (!await settlesWithin(child.exited, FORCED_EXIT_TIMEOUT_MS)) {
      const error = new Error("Codex supervisor survived forced termination");
      if (gracefulError !== undefined) {
        throw new AggregateError([gracefulError, error], "Codex supervisor cleanup failed");
      }
      throw error;
    }
    exitObserved = true;
  };
  return {
    label,
    pid: child.pid,
    requestStop: () => {
      signal("SIGTERM");
    },
    forceStop: () => {
      signal("SIGKILL");
    },
    waitForExit,
    stopWithin
  };
}

// packages/model-catalog/src/codex/supervisor.ts
import process5 from "process";
var CODEX_SUPERVISOR_PROTOCOL_VERSION = 1;
var CODEX_SUPERVISOR_SOURCE = String.raw`
const protocolVersion = ${CODEX_SUPERVISOR_PROTOCOL_VERSION};
process.on("SIGTERM", () => undefined);
setInterval(() => undefined, 2_147_483_647);
const publish = async (message) => {
  try {
    await process.send?.({ version: protocolVersion, ...message });
  } catch {}
};
const encoded = Bun.argv[1];
let command;
try {
  const parsed = JSON.parse(decodeURIComponent(encoded));
  const keys = typeof parsed === "object" && parsed !== null ? Object.keys(parsed) : [];
  if (
    keys.length !== 2 ||
    typeof parsed.binary !== "string" ||
    !Array.isArray(parsed.args) ||
    !parsed.args.every((value) => typeof value === "string")
  ) {
    throw new Error("invalid command");
  }
  command = parsed;
} catch {
  await publish({ type: "supervisor-error" });
}
if (command !== undefined) {
  try {
    const tool = Bun.spawn([command.binary, ...command.args], {
      env: process.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    await publish({ type: "ready" });
    tool.exited.then(
      (exitCode) => publish({ type: "exited", exitCode }),
      () => publish({ type: "tool-error" }),
    );
  } catch {
    await publish({ type: "spawn-error" });
  }
}
`;
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isCodexSupervisorMessage(value) {
  if (!isRecord2(value) || value["version"] !== CODEX_SUPERVISOR_PROTOCOL_VERSION || typeof value["type"] !== "string") {
    return false;
  }
  if (value["type"] === "ready" || value["type"] === "spawn-error" || value["type"] === "supervisor-error" || value["type"] === "tool-error") {
    return Object.keys(value).length === 2;
  }
  return value["type"] === "exited" && Object.keys(value).length === 3 && Number.isSafeInteger(value["exitCode"]);
}
function codexSupervisorProtocol() {
  const final = Promise.withResolvers();
  let state = "pending";
  const reject = () => {
    state = "final";
    final.reject(new Error("Codex supervisor protocol failed"));
  };
  const receive = (message) => {
    if (state === "final")
      return;
    if (!isCodexSupervisorMessage(message)) {
      reject();
      return;
    }
    if (message.type === "ready") {
      if (state !== "pending") {
        reject();
        return;
      }
      state = "ready";
      return;
    }
    if (message.type === "spawn-error" || message.type === "supervisor-error") {
      if (state !== "pending") {
        reject();
        return;
      }
    } else if (state !== "ready") {
      reject();
      return;
    }
    state = "final";
    final.resolve(message);
  };
  return { final: final.promise, receive };
}
function codexSupervisorCommand(binary, args) {
  return [
    process5.execPath,
    "--eval",
    CODEX_SUPERVISOR_SOURCE,
    encodeURIComponent(JSON.stringify({ binary, args }))
  ];
}

// packages/model-catalog/src/codex/child.ts
var SEMANTIC_VERSION = /(?<![0-9A-Za-z-])((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?=\s|$)/;
var CHILD_FAILURE_MESSAGES = {
  "bundled-exit": "codex bundled catalog command failed",
  cancelled: "codex command was cancelled",
  "invalid-bundled-json": "codex bundled catalog returned invalid JSON",
  "invalid-preflight-json": "catalog preflight returned invalid JSON",
  lifecycle: "codex command cleanup failed",
  "preflight-exit": "catalog preflight command failed",
  spawn: "codex command could not start",
  "stderr-limit": "codex stderr exceeds its byte limit",
  "stdout-limit": "codex stdout exceeds its byte limit",
  stream: "codex command stream failed",
  timeout: "codex command timed out",
  "unsupported-platform": "Codex child process groups are unsupported on Windows until Job Object ownership is implemented",
  "unsafe-binary": "codex binary must be a physical absolute regular file",
  "version-exit": "codex version command failed",
  "version-format": "codex version did not contain a valid full semantic version"
};

class CodexChildError extends Error {
  code;
  constructor(code) {
    super(CHILD_FAILURE_MESSAGES[code]);
    this.name = "CodexChildError";
    this.code = code;
  }
}
var systemCodexRuntime = {
  platform: process6.platform,
  spawn: (command, options) => Bun.spawn(command, options)
};
function requireOwnedProcessScope(platform) {
  if (platform === "win32") {
    throw new CodexChildError("unsupported-platform");
  }
}
function commandEnvironment(home) {
  return {
    CODEX_HOME: home,
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    PATH: process6.env["PATH"] ?? "/usr/bin:/bin",
    TMPDIR: join6(home, "tmp"),
    XDG_CACHE_HOME: join6(home, "xdg-cache"),
    XDG_CONFIG_HOME: join6(home, "xdg-config"),
    XDG_DATA_HOME: join6(home, "xdg-data")
  };
}
async function isolatedHome(workspace) {
  const home = workspace.path(`codex-home-${crypto.randomUUID()}`);
  await mkdir2(home, { mode: 448 });
  for (const directory of ["tmp", "xdg-cache", "xdg-config", "xdg-data"]) {
    await mkdir2(join6(home, directory), { mode: 448 });
  }
  return home;
}
async function validateCodexBinary(path) {
  try {
    if (!isAbsolute2(path) || await realpath2(path) !== path) {
      throw new CodexChildError("unsafe-binary");
    }
    const metadata = await lstat3(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new CodexChildError("unsafe-binary");
    }
  } catch (error) {
    if (error instanceof CodexChildError) {
      throw error;
    }
    throw new CodexChildError("unsafe-binary");
  }
}
function concatenate(chunks, length) {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
async function collectBounded(stream, limit, failure, signal, stop) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  const cancel = () => {
    reader.cancel().catch(() => {
      return;
    });
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const nextLength = length + value.byteLength;
      if (nextLength > limit) {
        stop(failure);
        break;
      }
      length = nextLength;
      chunks.push(value);
    }
  } catch {
    if (!signal.aborted) {
      stop("stream");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return concatenate(chunks, length);
}
async function runIsolatedCodex(workspace, codexBinary, argsFactory, limits, runtime) {
  requireOwnedProcessScope(runtime.platform);
  await validateCodexBinary(codexBinary);
  const home = await isolatedHome(workspace);
  try {
    const args = typeof argsFactory === "function" ? await argsFactory(home) : argsFactory;
    const protocol = codexSupervisorProtocol();
    let child;
    try {
      child = runtime.spawn(codexSupervisorCommand(codexBinary, args), {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: commandEnvironment(home),
        detached: true,
        ipc: protocol.receive
      });
    } catch {
      throw new CodexChildError("spawn");
    }
    const group = codexSupervisorGroup(child, `codex-supervisor-${child.pid}`, runtime.kill);
    try {
      workspace.registerChild(group);
    } catch {
      await group.stopWithin(limits.terminationGraceMs).catch(() => {
        return;
      });
      throw new CodexChildError("lifecycle");
    }
    const controller = new AbortController;
    let failure;
    let cleanupFailed = false;
    const cleanupFailure = Promise.withResolvers();
    let cleanup;
    const cleanGroup = () => {
      cleanup ??= group.stopWithin(limits.terminationGraceMs).catch(() => {
        cleanupFailed = true;
        cleanupFailure.resolve();
      });
      return cleanup;
    };
    const stop = (reason) => {
      failure ??= reason;
      controller.abort();
      cleanGroup().catch(() => {
        return;
      });
    };
    const cancel = () => stop("cancelled");
    workspace.signal.addEventListener("abort", cancel, { once: true });
    if (workspace.signal.aborted) {
      cancel();
    }
    const timer = setTimeout(() => stop("timeout"), limits.timeoutMs);
    try {
      const supervisorOutcome = Promise.race([
        protocol.final.then((message) => ({ message, ok: true }), () => ({ ok: false })),
        child.exited.then(() => ({ ok: false })),
        cleanupFailure.promise.then(() => ({ ok: false }))
      ]).then(async (outcome2) => {
        await cleanGroup();
        controller.abort();
        return outcome2;
      });
      const [stdout, , outcome] = await Promise.all([
        collectBounded(child.stdout, limits.maxStdoutBytes, "stdout-limit", controller.signal, stop),
        collectBounded(child.stderr, limits.maxStderrBytes, "stderr-limit", controller.signal, stop),
        supervisorOutcome
      ]);
      await cleanGroup();
      if (failure !== undefined) {
        throw new CodexChildError(failure);
      }
      if (cleanupFailed) {
        throw new CodexChildError("lifecycle");
      }
      if (!outcome.ok) {
        throw new CodexChildError("lifecycle");
      }
      return commandResult(stdout, outcome.message);
    } finally {
      clearTimeout(timer);
      workspace.signal.removeEventListener("abort", cancel);
      controller.abort();
      await cleanGroup();
    }
  } catch (error) {
    if (error instanceof CodexChildError) {
      throw error;
    }
    throw new CodexChildError("lifecycle");
  }
}
function commandResult(stdout, message) {
  if (message.type === "spawn-error") {
    throw new CodexChildError("spawn");
  }
  if (message.type !== "exited") {
    throw new CodexChildError("lifecycle");
  }
  return { stdout, exitCode: message.exitCode };
}
function parseJsonOutput(output, failure) {
  try {
    return parseJson(new TextDecoder().decode(output));
  } catch {
    throw new CodexChildError(failure);
  }
}
async function clientVersion(workspace, codexBinary, limits, runtime = systemCodexRuntime) {
  const result = await runIsolatedCodex(workspace, codexBinary, ["--version"], {
    ...limits,
    maxStdoutBytes: Math.min(limits.maxStdoutBytes, 1024)
  }, runtime);
  if (result.exitCode !== 0) {
    throw new CodexChildError("version-exit");
  }
  const match = new TextDecoder().decode(result.stdout).match(SEMANTIC_VERSION);
  const version = match?.[1];
  if (version === undefined) {
    throw new CodexChildError("version-format");
  }
  return version;
}
async function bundledCatalog(workspace, codexBinary, limits, runtime = systemCodexRuntime) {
  const result = await runIsolatedCodex(workspace, codexBinary, ["debug", "models", "--bundled"], limits, runtime);
  if (result.exitCode !== 0) {
    throw new CodexChildError("bundled-exit");
  }
  return assertCompleteCatalog(parseJsonOutput(result.stdout, "invalid-bundled-json"));
}
async function preflightCatalog(workspace, codexBinary, contents, limits, runtime = systemCodexRuntime) {
  const result = await runIsolatedCodex(workspace, codexBinary, async (home) => {
    const candidate = join6(home, "candidate.json");
    await writeFile(candidate, contents, { mode: 384, flag: "wx" });
    return [
      "debug",
      "models",
      "-c",
      `model_catalog_json=${JSON.stringify(candidate)}`
    ];
  }, limits, runtime);
  if (result.exitCode !== 0) {
    throw new CodexChildError("preflight-exit");
  }
  const loaded = assertCompleteCatalog(parseJsonOutput(result.stdout, "invalid-preflight-json"));
  const loadedLuna = loaded.models.filter((entry) => entry["slug"] === LUNA_MODEL);
  if (loadedLuna.length !== 1 || loadedLuna[0]?.["multi_agent_version"] !== "v2") {
    throw new Error("catalog preflight did not load Luna V2");
  }
}

// packages/model-catalog/src/catalog/store.ts
import { createHash } from "crypto";
import {
  chmod as chmod2,
  lstat as lstat4,
  mkdir as mkdir3,
  open as open3,
  readFile as readFile2,
  realpath as realpath3,
  rename as rename2,
  rm as rm2
} from "fs/promises";
import {
  basename as basename3,
  dirname as dirname2,
  isAbsolute as isAbsolute3,
  join as join7,
  parse,
  relative as relative2,
  resolve as resolve2,
  sep
} from "path";
import process7 from "process";
var MODEL_CACHE_TTL_MS = 300000;
function physicalPathKey(path) {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}
function isMissingFile(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function identity2(metadata) {
  return { dev: metadata.dev, ino: metadata.ino };
}
function sameIdentity(first, second) {
  if (first === undefined || second === undefined) {
    return first === second;
  }
  return first.dev === second.dev && first.ino === second.ino;
}
function pathComponents(path) {
  const absolute = resolve2(path);
  const { root } = parse(absolute);
  const segments = absolute.slice(root.length).split(sep).filter((segment) => segment.length > 0);
  const paths = [root];
  let current = root;
  for (const segment of segments) {
    current = join7(current, segment);
    paths.push(current);
  }
  return paths;
}
async function existingPathMetadata(path) {
  try {
    return await lstat4(path);
  } catch (error) {
    if (isMissingFile(error)) {
      return;
    }
    throw error;
  }
}
async function rejectSymlinkAncestors(path) {
  for (const component of pathComponents(path)) {
    const metadata = await existingPathMetadata(component);
    if (metadata === undefined) {
      return;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`${path} must not contain symlink path components`);
    }
  }
}
function within(root, path) {
  const child = relative2(root, path);
  return child === "" || !child.startsWith(`..${sep}`) && child !== "..";
}
async function firstMissingComponent(path) {
  for (const component of pathComponents(path)) {
    if (await existingPathMetadata(component) === undefined) {
      return component;
    }
  }
  return;
}
async function ensureDirectoryPath(path) {
  await rejectSymlinkAncestors(path);
  for (const component of pathComponents(path)) {
    const metadata = await existingPathMetadata(component);
    if (metadata === undefined) {
      await mkdir3(component, { mode: 448 });
      const created = await lstat4(component);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new Error(`${component} must be a directory`);
      }
      continue;
    }
    if (!metadata.isDirectory()) {
      throw new Error(`${component} must be a directory`);
    }
  }
}
function privateMode(metadata) {
  return (metadata.mode & 511) === 448;
}
async function validatePrivateDirectoryChain(privacyRoot, directory) {
  if (!within(privacyRoot, directory)) {
    throw new Error(`${directory} escapes its private storage root`);
  }
  await rejectSymlinkAncestors(directory);
  const expectedUid = process7.getuid?.();
  for (const component of pathComponents(directory)) {
    if (!within(privacyRoot, component)) {
      continue;
    }
    const metadata = await lstat4(component);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${component} must be a directory`);
    }
    if (expectedUid !== undefined && metadata.uid !== expectedUid) {
      throw new Error(`${component} must be owned by the current user`);
    }
    if (!privateMode(metadata)) {
      throw new Error(`${component} must have mode 0700`);
    }
    if (await realpath3(component) !== component) {
      throw new Error(`${component} must use its physical path`);
    }
  }
}
async function privacyRootFor(codexHome, directory) {
  if (within(codexHome, directory)) {
    return codexHome;
  }
  return await firstMissingComponent(directory) ?? directory;
}
async function preparePrivateParent(codexHome, target) {
  const directory = dirname2(target);
  const privacyRoot = await privacyRootFor(codexHome, directory);
  await ensureDirectoryPath(directory);
  await validatePrivateDirectoryChain(privacyRoot, directory);
}
async function prepareStandaloneParent(target) {
  const directory = dirname2(target);
  const privacyRoot = await firstMissingComponent(directory) ?? directory;
  await ensureDirectoryPath(directory);
  await validatePrivateDirectoryChain(privacyRoot, directory);
}
async function regularFileMetadata(path) {
  const metadata = await lstat4(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`${path} must not be a symlink`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${path} must be a regular file`);
  }
  return metadata;
}
function requireSingleLink(path, metadata) {
  if (metadata.nlink !== 1) {
    throw new Error(`${path} must have exactly one hard link`);
  }
  return metadata;
}
async function managedFileMetadata(path) {
  return requireSingleLink(path, await regularFileMetadata(path));
}
async function validatePhysicalRegularFile(path) {
  await rejectSymlinkAncestors(path);
  await regularFileMetadata(path);
}
async function validatePhysicalDirectory(path) {
  await rejectSymlinkAncestors(path);
  const metadata = await lstat4(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${path} must be a directory`);
  }
  if (await realpath3(path) !== path) {
    throw new Error(`${path} must use its physical path`);
  }
}
async function inspectTarget(path) {
  await rejectSymlinkAncestors(path);
  const physicalParent = await realpath3(dirname2(path));
  if (physicalParent !== dirname2(path)) {
    throw new Error(`${path} must use its physical parent path`);
  }
  const metadata = await existingPathMetadata(path);
  if (metadata === undefined) {
    return { physicalPath: join7(physicalParent, basename3(path)) };
  }
  const regular = await managedFileMetadata(path);
  return {
    physicalPath: join7(physicalParent, basename3(path)),
    identity: identity2(regular),
    metadata: regular
  };
}
async function ensurePrivateFileMode(path) {
  const metadata = await existingPathMetadata(path);
  if (metadata === undefined) {
    return;
  }
  const regular = await managedFileMetadata(path);
  const expectedUid = process7.getuid?.();
  if (expectedUid !== undefined && regular.uid !== expectedUid) {
    throw new Error(`${path} must be owned by the current user`);
  }
  if ((regular.mode & 511) === 384) {
    return;
  }
  const expected = identity2(regular);
  await chmod2(path, 384);
  const repaired = await managedFileMetadata(path);
  if (!sameIdentity(expected, identity2(repaired))) {
    throw new Error(`${path} changed during permission repair`);
  }
}
async function targetSnapshot(path) {
  const parent = await lstat4(dirname2(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error(`${dirname2(path)} must be a directory`);
  }
  const target = await existingPathMetadata(path);
  if (target !== undefined) {
    if (!target.isFile() || target.isSymbolicLink()) {
      throw new Error(`${path} must be a regular file`);
    }
    requireSingleLink(path, target);
  }
  return {
    parent: identity2(parent),
    ...target === undefined ? {} : {
      target: identity2(target),
      targetCtimeMs: target.ctimeMs,
      targetMode: target.mode & 511,
      targetMtimeMs: target.mtimeMs,
      targetNlink: target.nlink,
      targetSize: target.size
    }
  };
}
async function assertSnapshotUnchanged(path, expected) {
  await rejectSymlinkAncestors(path);
  const current = await targetSnapshot(path);
  if (!(sameIdentity(current.parent, expected.parent) && sameIdentity(current.target, expected.target)) || current.targetCtimeMs !== expected.targetCtimeMs || current.targetMode !== expected.targetMode || current.targetMtimeMs !== expected.targetMtimeMs || current.targetNlink !== expected.targetNlink || current.targetSize !== expected.targetSize) {
    throw new Error(`${path} changed during atomic replacement`);
  }
}
async function syncDirectory(path) {
  const handle = await open3(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function prepareCatalogStorePaths(paths) {
  for (const path of [paths.output, paths.status, paths.cache]) {
    if (!isAbsolute3(path)) {
      throw new Error(`${path} must be absolute`);
    }
    await preparePrivateParent(paths.codexHome, path);
    await ensurePrivateFileMode(path);
  }
  await validateCatalogStorePaths(paths);
}
async function validateCatalogTarget(paths, path) {
  const directory = dirname2(path);
  const privacyRoot = await privacyRootFor(paths.codexHome, directory);
  await validatePrivateDirectoryChain(privacyRoot, directory);
  const inspection = await inspectTarget(path);
  if (inspection.metadata === undefined) {
    return inspection;
  }
  const expectedUid = process7.getuid?.();
  if (expectedUid !== undefined && inspection.metadata.uid !== expectedUid || (inspection.metadata.mode & 511) !== 384) {
    throw new Error(`${path} must be an owner-only mode 0600 file`);
  }
  return inspection;
}
function assertDistinctInspections(first, second) {
  const samePath = physicalPathKey(first.physicalPath) === physicalPathKey(second.physicalPath);
  const sameFile = first.identity !== undefined && second.identity !== undefined && sameIdentity(first.identity, second.identity);
  if (samePath || sameFile) {
    throw new Error("catalog output, status, and cache paths must be physically distinct");
  }
}
async function validateCatalogStorePaths(paths) {
  const inspections = await Promise.all([paths.output, paths.status, paths.cache].map((path) => validateCatalogTarget(paths, path)));
  for (let left = 0;left < inspections.length; left += 1) {
    for (let right = left + 1;right < inspections.length; right += 1) {
      const first = inspections[left];
      const second = inspections[right];
      if (first === undefined || second === undefined) {
        continue;
      }
      assertDistinctInspections(first, second);
    }
  }
}
async function readBoundedJsonFile(path, maxBytes) {
  const metadata = await managedFileMetadata(path);
  if (metadata.size > maxBytes) {
    throw new Error("catalog input exceeds size limit");
  }
  const handle = await open3(path, "r");
  try {
    const opened = requireSingleLink(path, await handle.stat());
    if (!(opened.isFile() && sameIdentity(identity2(metadata), identity2(opened)))) {
      throw new Error(`${path} changed while opening catalog input`);
    }
    const contents = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < contents.byteLength) {
      const { bytesRead } = await handle.read(contents, length, contents.byteLength - length, null);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    if (length > maxBytes) {
      throw new Error("catalog input exceeds size limit");
    }
    const completed = requireSingleLink(path, await handle.stat());
    if (!sameIdentity(identity2(opened), identity2(completed))) {
      throw new Error(`${path} changed while reading catalog input`);
    }
    return parseJson(contents.subarray(0, length).toString("utf8"));
  } finally {
    await handle.close();
  }
}
async function cachedCatalog(path, expectedVersion, now, maxBytes) {
  try {
    const root = parseCatalogCache(await readBoundedJsonFile(path, maxBytes));
    if (root.client_version !== expectedVersion) {
      return;
    }
    const fetchedAt = Date.parse(root.fetched_at);
    const age = now.getTime() - fetchedAt;
    if (!Number.isFinite(fetchedAt) || age < 0 || age > MODEL_CACHE_TTL_MS) {
      return;
    }
    return assertCompleteCatalog({ models: root.models });
  } catch {
    return;
  }
}
async function validatedAtomicParent(path) {
  if (!isAbsolute3(path)) {
    throw new Error(`${path} must be absolute`);
  }
  await prepareStandaloneParent(path);
  await rejectSymlinkAncestors(path);
  const parent = dirname2(path);
  const metadata = await lstat4(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${parent} must be a directory`);
  }
  if (!privateMode(metadata)) {
    throw new Error(`${parent} must have mode 0700`);
  }
  const expectedUid = process7.getuid?.();
  if (expectedUid !== undefined && metadata.uid !== expectedUid) {
    throw new Error(`${parent} must be owned by the current user`);
  }
  return parent;
}
async function preparedTarget(path, contents) {
  let expected = await targetSnapshot(path);
  if (expected.target === undefined) {
    return { expected, unchanged: false };
  }
  if (expected.targetMode !== 384) {
    await chmod2(path, 384);
    expected = await targetSnapshot(path);
  }
  await assertSnapshotUnchanged(path, expected);
  if (expected.targetSize !== Buffer.byteLength(contents)) {
    return { expected, unchanged: false };
  }
  const currentContents = await readFile2(path, "utf8");
  await assertSnapshotUnchanged(path, expected);
  return { expected, unchanged: currentContents === contents };
}
async function writeSyncedTemporary(temporary, contents) {
  try {
    const handle = await open3(temporary, "wx", 384);
    try {
      const opened = requireSingleLink(temporary, await handle.stat());
      if ((opened.mode & 511) !== 384) {
        throw new Error(`${temporary} must have mode 0600`);
      }
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      const completed = requireSingleLink(temporary, await handle.stat());
      if (!sameIdentity(identity2(opened), identity2(completed)) || (completed.mode & 511) !== 384) {
        throw new Error(`${temporary} changed while staging atomic output`);
      }
    } finally {
      await handle.close();
    }
    return await targetSnapshot(temporary);
  } catch (error) {
    await rm2(temporary, { force: true });
    throw error;
  }
}
async function promoteTemporary(path, parent, temporary, temporaryExpected, expected, options) {
  await assertSnapshotUnchanged(path, expected);
  await assertSnapshotUnchanged(temporary, temporaryExpected);
  await options.beforePromote?.();
  await assertSnapshotUnchanged(path, expected);
  await assertSnapshotUnchanged(temporary, temporaryExpected);
  await rename2(temporary, path);
  await syncDirectory(parent);
  const promoted = await managedFileMetadata(path);
  if ((promoted.mode & 511) !== 384 || !sameIdentity(identity2(promoted), temporaryExpected.target)) {
    throw new Error(`${path} must have mode 0600`);
  }
}
async function writePrivateAtomic(path, contents, options = {}) {
  const parent = await validatedAtomicParent(path);
  const target = await preparedTarget(path, contents);
  if (target.unchanged) {
    return false;
  }
  const temporary = join7(parent, `.${globalThis.crypto.randomUUID()}.tmp`);
  let created = false;
  try {
    const temporaryExpected = await writeSyncedTemporary(temporary, contents);
    created = true;
    await promoteTemporary(path, parent, temporary, temporaryExpected, target.expected, options);
    created = false;
    return true;
  } finally {
    if (created) {
      await rm2(temporary, { force: true });
    }
  }
}
function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

// packages/model-catalog/src/catalog/refresh.ts
var DEFAULT_MAX_CATALOG_BYTES = 8 * 1024 * 1024;
var DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
var DEFAULT_TIMEOUT_MS = 1e4;
var DEFAULT_TERMINATION_GRACE_MS = 100;
var WORKSPACE_FORCE_STOP_MS = 2500;
var systemCatalogRefreshRuntime = {
  codex: systemCodexRuntime
};
function resolveCatalogPaths(options) {
  const codexHome = resolve3(options.codexHome);
  const paths = {
    codexHome,
    codexBinary: resolve3(options.codexBinary),
    output: resolve3(options.output ?? join8(codexHome, "skizzles", "model-catalog.json")),
    status: resolve3(options.status ?? join8(codexHome, "skizzles", "model-catalog-status.json")),
    cache: resolve3(options.cache ?? join8(codexHome, "models_cache.json"))
  };
  const distinct = new Set([paths.output, paths.status, paths.cache]);
  if (distinct.size !== 3) {
    throw new Error("catalog output, status, and cache paths must be distinct");
  }
  return paths;
}
function commandLimits(options) {
  const limits = {
    timeoutMs: options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    terminationGraceMs: DEFAULT_TERMINATION_GRACE_MS,
    maxStdoutBytes: options.maxCatalogBytes ?? DEFAULT_MAX_CATALOG_BYTES,
    maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES
  };
  if (!Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("catalog command limits must be positive safe integers");
  }
  return limits;
}
async function preparedCatalog(workspace, paths, limits, now, runtime) {
  const version = await clientVersion(workspace, paths.codexBinary, limits, runtime);
  const cached = await cachedCatalog(paths.cache, version, now, limits.maxStdoutBytes);
  let source = cached ? "cache" : "bundled";
  let sourceCatalog = cached ?? await bundledCatalog(workspace, paths.codexBinary, limits, runtime);
  let overlaid = applyLunaV2Overlay(sourceCatalog);
  let contents = `${JSON.stringify(overlaid.catalog, null, 2)}
`;
  try {
    await preflightCatalog(workspace, paths.codexBinary, contents, limits, runtime);
  } catch (error) {
    if (source !== "cache") {
      throw error;
    }
    source = "bundled";
    sourceCatalog = await bundledCatalog(workspace, paths.codexBinary, limits, runtime);
    overlaid = applyLunaV2Overlay(sourceCatalog);
    contents = `${JSON.stringify(overlaid.catalog, null, 2)}
`;
    await preflightCatalog(workspace, paths.codexBinary, contents, limits, runtime);
  }
  return { source, contents, overlay: overlaid.overlay };
}
async function refreshCatalog(options) {
  return await refreshCatalogWithRuntime(options, systemCatalogRefreshRuntime);
}
async function refreshCatalogWithRuntime(options, runtime) {
  const paths = resolveCatalogPaths(options);
  const limits = commandLimits(options);
  requireOwnedProcessScope(runtime.codex.platform);
  let workspace;
  try {
    const stale = await cleanupStale();
    if (stale.failed.length > 0) {
      throw new CodexChildError("lifecycle");
    }
    const workspaceOptions = {
      gracefulStopMs: limits.terminationGraceMs,
      forceStopMs: WORKSPACE_FORCE_STOP_MS
    };
    workspace = options.signal === undefined ? await create(workspaceOptions) : await create({ ...workspaceOptions, signal: options.signal });
  } catch {
    throw new CodexChildError("lifecycle");
  }
  let outcome;
  try {
    await prepareCatalogStorePaths(paths);
    const prepared = await preparedCatalog(workspace, paths, limits, options.now ?? new Date, runtime.codex);
    await validateCatalogStorePaths(paths);
    const revalidatePaths = async () => validateCatalogStorePaths(paths);
    const requireActive = () => {
      if (workspace.signal.aborted) {
        throw new CodexChildError("cancelled");
      }
    };
    requireActive();
    const updated = await writePrivateAtomic(paths.output, prepared.contents, {
      beforePromote: async () => {
        await revalidatePaths();
        await runtime.commitHooks?.beforeOutputPromote?.();
        requireActive();
      }
    });
    const result = {
      ok: true,
      source: prepared.source,
      updated,
      lunaOverlay: prepared.overlay,
      catalogChanged: updated,
      generation: digest(prepared.contents),
      output: paths.output
    };
    await runtime.commitHooks?.afterOutputCommit?.();
    await writePrivateAtomic(paths.status, `${JSON.stringify({ ...result, checkedAt: new Date().toISOString() }, null, 2)}
`, { beforePromote: revalidatePaths });
    outcome = { ok: true, result };
  } catch (error) {
    outcome = { ok: false, error };
  }
  let cleanupSucceeded = false;
  try {
    cleanupSucceeded = (await workspace.close()).state === "deleted";
  } catch {}
  if (!cleanupSucceeded) {
    throw new CodexChildError("lifecycle");
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.result;
}

// packages/model-catalog/src/cli.ts
import { readFile as readFile3 } from "fs/promises";
import { isAbsolute as isAbsolute5, resolve as resolve5 } from "path";

// packages/model-catalog/src/launch-agent.ts
import { isAbsolute as isAbsolute4, join as join9, resolve as resolve4 } from "path";
var UNRESOLVED_PLACEHOLDER = /__[A-Z0-9_]+__/;
function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function renderLaunchAgent(template, values) {
  const replacements = {
    __BUN_ABSOLUTE_PATH__: values.bun,
    __SCRIPT_ABSOLUTE_PATH__: values.script,
    __CODEX_HOME_ABSOLUTE_PATH__: values.codexHome,
    __CODEX_BINARY_ABSOLUTE_PATH__: values.codexBinary,
    __MODELS_CACHE_ABSOLUTE_PATH__: join9(values.codexHome, "models_cache.json")
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!isAbsolute4(value)) {
      throw new Error(`${placeholder} must be absolute`);
    }
    rendered = rendered.replaceAll(placeholder, xml(resolve4(value)));
  }
  if (UNRESOLVED_PLACEHOLDER.test(rendered)) {
    throw new Error("launch agent template contains unresolved placeholders");
  }
  return rendered;
}

// packages/model-catalog/src/cli.ts
var USAGE = "usage: skizzles-model-catalog <refresh|service|render-launch-agent> [options]";
function recordSwitch(found, flag) {
  if (found.has(flag)) {
    throw new Error(`${flag} must not be repeated`);
  }
  found.add(flag);
}
function recordValue(args, index, allowed, values) {
  const token = args[index];
  if (token === undefined) {
    return index;
  }
  if (!isValueFlag(token, allowed)) {
    throw new Error(token.startsWith("--") ? `unknown option ${token}` : `unexpected argument ${token}`);
  }
  const flag = token;
  if (values[flag] !== undefined) {
    throw new Error(`${flag} must not be repeated`);
  }
  const found = args[index + 1];
  if (found === undefined || found.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  if (found.length === 0 || !isAbsolute5(found)) {
    throw new Error(`${flag} requires a nonempty absolute path`);
  }
  values[flag] = found;
  return index + 1;
}
function isValueFlag(value, allowed) {
  for (const flag of allowed) {
    if (flag === value) {
      return true;
    }
  }
  return false;
}
function parseOptions(args, valueFlags, switches = []) {
  const allowedValues = new Set(valueFlags);
  const allowedSwitches = new Set(switches);
  const values = {};
  const foundSwitches = new Set;
  for (let index = 0;index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) {
      break;
    }
    if (allowedSwitches.has(token)) {
      recordSwitch(foundSwitches, token);
      continue;
    }
    index = recordValue(args, index, allowedValues, values);
  }
  return { values, switches: foundSwitches };
}
function required(options, flag) {
  const found = options.values[flag];
  if (found === undefined) {
    throw new Error(`${flag} is required`);
  }
  return found;
}
function refreshOptions(parsed) {
  const output = parsed.values["--output"];
  const status = parsed.values["--status"];
  const cache = parsed.values["--cache"];
  return {
    codexHome: required(parsed, "--codex-home"),
    codexBinary: required(parsed, "--codex-binary"),
    ...output === undefined ? {} : { output },
    ...status === undefined ? {} : { status },
    ...cache === undefined ? {} : { cache }
  };
}
async function runRefresh(args, service) {
  const parsed = parseOptions(args, ["--codex-home", "--codex-binary", "--status", "--output", "--cache"], service ? [] : ["--quiet-unchanged"]);
  const options = refreshOptions(parsed);
  const paths = resolveCatalogPaths(options);
  await prepareCatalogStorePaths(paths);
  const { status } = paths;
  let result;
  try {
    result = await refreshCatalog({ ...options, status });
  } catch (error) {
    if (service) {
      const message = error instanceof CodexChildError ? `model catalog child failure: ${error.message}` : "model catalog refresh failed";
      await writePrivateAtomic(status, `${JSON.stringify({ ok: false, error: message, checkedAt: new Date().toISOString() }, null, 2)}
`, { beforePromote: async () => validateCatalogStorePaths(paths) });
    }
    throw error;
  }
  if (!service && (result.updated || !parsed.switches.has("--quiet-unchanged"))) {
    console.log(JSON.stringify(result));
  }
}
async function runRenderLaunchAgent(args) {
  const parsed = parseOptions(args, [
    "--template",
    "--output",
    "--bun",
    "--script",
    "--codex-home",
    "--codex-binary"
  ]);
  const output = required(parsed, "--output");
  const template = required(parsed, "--template");
  const bun = required(parsed, "--bun");
  const script = required(parsed, "--script");
  const codexHome = required(parsed, "--codex-home");
  const codexBinary = required(parsed, "--codex-binary");
  await Promise.all([
    validatePhysicalRegularFile(template),
    validatePhysicalRegularFile(bun),
    validatePhysicalRegularFile(script),
    validatePhysicalDirectory(codexHome),
    validatePhysicalRegularFile(codexBinary)
  ]);
  const rendered = renderLaunchAgent(await readFile3(template, "utf8"), {
    bun,
    script,
    codexHome,
    codexBinary
  });
  await writePrivateAtomic(output, rendered);
  console.log(JSON.stringify({ ok: true, output: resolve5(output) }));
}
function runModelCatalogCli(args) {
  const [command, ...options] = args;
  if (command === "refresh") {
    return runRefresh(options, false);
  }
  if (command === "service") {
    return runRefresh(options, true);
  }
  if (command === "render-launch-agent") {
    return runRenderLaunchAgent(options);
  }
  throw new Error(USAGE);
}

// packages/model-catalog/src/index.ts
function applyLunaV2Overlay2(value) {
  return applyLunaV2Overlay(value);
}
function refreshCatalog2(options) {
  return refreshCatalog(options);
}
function renderLaunchAgent2(template, values) {
  return renderLaunchAgent(template, values);
}
if (import.meta.main) {
  try {
    await runModelCatalogCli(process8.argv.slice(2));
  } catch (error) {
    if (error instanceof Error) {
      const { message } = error;
      console.error(message);
    } else {
      console.error("model catalog operation failed");
    }
    process8.exit(1);
  }
}
export {
  renderLaunchAgent2 as renderLaunchAgent,
  refreshCatalog2 as refreshCatalog,
  applyLunaV2Overlay2 as applyLunaV2Overlay
};
