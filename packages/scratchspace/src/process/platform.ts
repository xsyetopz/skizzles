import { execFile } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import type { UsageDirectory, UsageEntry } from "../usage/contract.ts";
import {
  lstatSystemUsage,
  openSystemUsageDirectory,
} from "../usage/directory.ts";

export type {
  UsageDirectory,
  UsageEntry,
  UsageEntryKind,
} from "../usage/contract.ts";

export interface FileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
}

export interface ProcessIdentity {
  readonly platform: "darwin" | "linux" | "win32";
  readonly token: string;
}

export interface Deadline {
  readonly elapsed: Promise<void>;
  cancel: () => void;
}

export interface Runtime {
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  now: () => number;
  deadline: (milliseconds: number) => Deadline;
  temporaryDirectory: () => string;
  processIdentity: (pid: number) => Promise<ProcessIdentity | undefined>;
  processExists: (pid: number) => Promise<boolean | undefined>;
  mkdir: (
    path: string,
    options: { recursive: true; mode: number },
  ) => Promise<string | undefined>;
  chmod: (path: string, mode: number) => Promise<void>;
  mkdtemp: (prefix: string) => Promise<string>;
  lstatIdentity: (path: string) => Promise<FileIdentity | undefined>;
  lstatUsage: (path: string) => Promise<UsageEntry | undefined>;
  openUsageDirectory: (path: string) => Promise<UsageDirectory | undefined>;
  isDirectory: (path: string) => Promise<boolean>;
  isPrivateDirectory: (path: string) => Promise<boolean>;
  isFile: (path: string) => Promise<boolean>;
  pathExists: (path: string) => Promise<boolean | undefined>;
  realpath: (path: string) => Promise<string>;
  readFile: (path: string) => Promise<string>;
  readSecureFile: (
    path: string,
    maximumBytes: number,
  ) => Promise<string | undefined>;
  writeExclusive: (path: string, contents: string) => Promise<void>;
  writeReplace: (path: string, contents: string) => Promise<void>;
  readdir: (path: string) => Promise<readonly string[]>;
  scanDirectory: (
    path: string,
    limit: number,
  ) => Promise<{
    readonly names: readonly string[];
    readonly truncated: boolean;
  }>;
  rename: (from: string, to: string) => Promise<void>;
  removeRoot: (path: string) => Promise<void>;
  errorCode: (error: unknown) => string | undefined;
}

const execFileAsync = promisify(execFile);
const decimalPattern = /^\d+$/u;
const whitespacePattern = /\s+/gu;
const darwinBootPattern = /sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/u;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return;
  return typeof error.code === "string" ? error.code : undefined;
}

function deadline(milliseconds: number): Deadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
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
    },
  };
}

async function linuxIdentity(
  pid: number,
): Promise<ProcessIdentity | undefined> {
  try {
    const [bootId, stat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const startTicks = parseLinuxStartTicks(stat);
    if (startTicks === undefined) return;
    return { platform: "linux", token: `${bootId.trim()}:${startTicks}` };
  } catch {
    return undefined;
  }
}

async function darwinIdentity(
  pid: number,
): Promise<ProcessIdentity | undefined> {
  try {
    const [processResult, bootResult] = await Promise.all([
      execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 2000,
      }),
      execFileAsync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
        encoding: "utf8",
        timeout: 2000,
      }),
    ]);
    const normalized = processResult.stdout
      .trim()
      .replace(whitespacePattern, " ");
    const bootIdentity = parseDarwinBootTime(bootResult.stdout);
    if (normalized.length === 0) return;
    if (bootIdentity === undefined) return;
    return { platform: "darwin", token: `${bootIdentity}:${normalized}` };
  } catch {
    return undefined;
  }
}

export function parseDarwinBootTime(output: string): string | undefined {
  const match = darwinBootPattern.exec(output);
  const seconds = match?.[1];
  const microseconds = match?.[2];
  if (seconds === undefined || microseconds === undefined) return;
  return `${seconds}.${microseconds}`;
}

export function parseLinuxStartTicks(stat: string): string | undefined {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return;
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(whitespacePattern);
  const startTicks = fields[19];
  if (startTicks === undefined || !decimalPattern.test(startTicks)) return;
  return startTicks;
}

async function windowsIdentity(
  pid: number,
): Promise<ProcessIdentity | undefined> {
  const systemRoot = process.env["SystemRoot"];
  if (systemRoot === undefined || systemRoot.length === 0) {
    return;
  }
  const powershell = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  try {
    const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc()`;
    const result = await execFileAsync(
      powershell,
      ["-NoLogo", "-NoProfile", "-Command", script],
      {
        encoding: "utf8",
        timeout: 3000,
        windowsHide: true,
      },
    );
    const token = result.stdout.trim();
    if (!decimalPattern.test(token)) return;
    return { platform: "win32", token };
  } catch {
    return undefined;
  }
}

export function getProcessIdentity(
  platform: NodeJS.Platform,
  pid: number,
): Promise<ProcessIdentity | undefined> {
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

async function observeProcess(pid: number): Promise<boolean | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return undefined;
  }
}

async function fileIdentity(path: string): Promise<FileIdentity | undefined> {
  try {
    const stats = await lstat(path, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return;
    }
    return {
      device: stats.dev.toString(10),
      inode: stats.ino.toString(10),
      birthtimeNs: stats.birthtimeNs.toString(10),
    };
  } catch {
    return undefined;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean | undefined> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    return undefined;
  }
}

async function isPrivateDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    if (process.platform === "win32") return true;
    const currentUserId = process.getuid?.();
    return (
      (stats.mode & 0o077) === 0 &&
      (currentUserId === undefined || stats.uid === currentUserId)
    );
  } catch {
    return false;
  }
}

async function writeReplacement(path: string, contents: string): Promise<void> {
  const temporary = `${path}.next-${crypto.randomUUID()}`;
  await writeSynced(temporary, contents, true);
  try {
    await rename(temporary, path);
    await syncParent(path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncParent(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(join(path, ".."), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeSynced(
  path: string,
  contents: string,
  exclusive: boolean,
): Promise<void> {
  const flags = exclusive
    ? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
    : constants.O_WRONLY;
  const handle = await open(path, flags, 0o600);
  try {
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncParent(path);
}

async function readSecureFile(
  path: string,
  maximumBytes: number,
): Promise<string | undefined> {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let handle: FileHandle | undefined;
  try {
    const pathBefore = await lstat(path, { bigint: true });
    if (
      !pathBefore.isFile() ||
      pathBefore.isSymbolicLink() ||
      pathBefore.size > BigInt(maximumBytes) ||
      (process.platform !== "win32" && (Number(pathBefore.mode) & 0o077) !== 0)
    ) {
      return;
    }
    handle = await open(path, constants.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      pathBefore.dev !== before.dev ||
      pathBefore.ino !== before.ino ||
      pathBefore.birthtimeNs !== before.birthtimeNs ||
      before.size > BigInt(maximumBytes) ||
      (process.platform !== "win32" && (Number(before.mode) & 0o077) !== 0)
    ) {
      return;
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.birthtimeNs !== after.birthtimeNs ||
      before.size !== after.size ||
      pathAfter.isSymbolicLink() ||
      after.dev !== pathAfter.dev ||
      after.ino !== pathAfter.ino ||
      after.birthtimeNs !== pathAfter.birthtimeNs
    ) {
      return;
    }
    return contents;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function scanDirectory(
  path: string,
  limit: number,
): Promise<{ readonly names: readonly string[]; readonly truncated: boolean }> {
  const directory = await opendir(path);
  const names: string[] = [];
  try {
    while (names.length <= limit) {
      const entry = await directory.read();
      if (entry === null) return { names, truncated: false };
      names.push(entry.name);
    }
    return { names: names.slice(0, limit), truncated: true };
  } finally {
    try {
      await directory.close();
    } catch {
      // Reaching the end of Bun's directory iterator may already close it.
    }
  }
}

export function systemRuntime(): Runtime {
  return {
    pid: process.pid,
    platform: process.platform,
    now: Date.now,
    deadline,
    temporaryDirectory: () => realpathSync(tmpdir()),
    processIdentity: (pid) => getProcessIdentity(process.platform, pid),
    processExists: observeProcess,
    mkdir: (path, options) => mkdir(path, options),
    chmod,
    mkdtemp,
    lstatIdentity: fileIdentity,
    lstatUsage: lstatSystemUsage,
    openUsageDirectory: (path) =>
      openSystemUsageDirectory(path, process.platform),
    isDirectory: async (path) => (await fileIdentity(path)) !== undefined,
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
    removeRoot: (path) =>
      rm(path, {
        recursive: true,
        force: false,
        maxRetries: 5,
        retryDelay: 100,
      }),
    errorCode,
  };
}

export const managedDirectoryName = "skizzles-run-workspaces";
export const markerName = ".skizzles-run-workspace.json";

export function managedParent(runtime: Runtime): string {
  return join(runtime.temporaryDirectory(), managedDirectoryName);
}
