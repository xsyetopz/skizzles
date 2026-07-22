import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

const LOCK_SCHEMA = "skizzles.prompt-policy-lock";
const LOCK_VERSION = 1;
const OWNER_NAME = "owner.json";
const DEFAULT_INCOMPLETE_GRACE_MS = 5_000;
const TOKEN_PATTERN = /^[0-9a-f-]{36}$/;
const ORPHAN_NAME_PATTERN = /^(?:stale|release|failed)-[0-9a-f-]{36}$/;

const LINE_BREAK_PATTERN = /[\r\n]/;
const WHITESPACE_PATTERN = /\s+/;
const DARWIN_PS_LSTART =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/;
const DARWIN_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DARWIN_MONTHS = [
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
  "Dec",
];

interface FileIdentity {
  dev: number;
  ino: number;
}

interface LockOwner {
  schema: typeof LOCK_SCHEMA;
  version: typeof LOCK_VERSION;
  operation: "apply" | "restore";
  pid: number;
  processStartIdentity: string;
  token: string;
  createdAtUnixMs: number;
}

interface LockHandle {
  parent: string;
  path: string;
  identity: FileIdentity;
  owner: LockOwner;
}

export interface PromptPolicyLockOptions {
  lockParent?: string;
  incompleteGraceMs?: number;
  processStartIdentity?: (pid: number) => string | undefined;
  afterAcquire?: (lockPath: string) => void | Promise<void>;
  beforeStaleQuarantine?: (lockPath: string) => void | Promise<void>;
  beforeRelease?: (lockPath: string) => void | Promise<void>;
}

export function promptPolicyLockPath(
  codexHome: string,
  lockParent = defaultLockParent(),
): string {
  const absolute = resolve(codexHome);
  const canonical = existsSync(absolute) ? realpathSync(absolute) : absolute;
  const key = createHash("sha256").update(canonical).digest("hex");
  return join(resolve(lockParent), key);
}

export async function withPromptPolicyLock<T>(
  codexHome: string,
  operation: "apply" | "restore",
  options: PromptPolicyLockOptions | undefined,
  work: () => Promise<T>,
): Promise<T> {
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

function acquireLock(
  codexHome: string,
  operation: "apply" | "restore",
  options: PromptPolicyLockOptions | undefined,
): LockHandle | Promise<LockHandle> {
  const parent = resolve(options?.lockParent ?? defaultLockParent());
  ensureSafeParent(parent);
  const processStartIdentity = (
    options?.processStartIdentity ?? defaultProcessStartIdentity
  )(process.pid);
  if (!validProcessStartIdentity(processStartIdentity)) {
    throw new Error(
      "cannot establish process-start identity for prompt-policy lifecycle lock",
    );
  }
  const owner: LockOwner = {
    schema: LOCK_SCHEMA,
    version: LOCK_VERSION,
    operation,
    pid: process.pid,
    processStartIdentity,
    token: randomUUID(),
    createdAtUnixMs: Date.now(),
  };
  const path = promptPolicyLockPath(codexHome, parent);
  cleanupLockOrphans(parent, path, options);
  const created = createLock(parent, path, owner);
  if (created) {
    return created;
  }
  return reclaimStaleLock(parent, path, owner, options);
}

function cleanupLockOrphans(
  parent: string,
  lockPath: string,
  options: PromptPolicyLockOptions | undefined,
): void {
  const prefix = `${basename(lockPath)}.`;
  const grace = options?.incompleteGraceMs ?? DEFAULT_INCOMPLETE_GRACE_MS;
  for (const name of readdirSync(parent).sort()) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const suffix = name.slice(prefix.length);
    if (!ORPHAN_NAME_PATTERN.test(suffix)) {
      throw new Error(
        "prompt-policy lock parent contains malformed orphan state",
      );
    }
    const path = join(parent, name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("prompt-policy lock orphan is not a safe directory");
    }
    if ((metadata.mode & 0o777) !== 0o700) {
      throw new Error("prompt-policy lock orphan must have mode 0700");
    }
    const identity = fileIdentity(path);
    const entries = readdirSync(path).sort();
    if (
      entries.length > 1 ||
      (entries.length === 1 && entries[0] !== OWNER_NAME)
    ) {
      throw new Error("prompt-policy lock orphan contains unexpected entries");
    }
    const owner = entries.length === 1 ? readOwner(path) : undefined;
    if (owner) {
      assertStaleOwner(owner, options?.processStartIdentity);
    } else if (Date.now() - metadata.mtimeMs < grace) {
      throw new Error("prompt-policy lock orphan is inside its grace period");
    }
    assertIdentity(path, identity, "prompt-policy lock orphan was replaced");
    if (owner && !sameOwner(readOwner(path), owner)) {
      throw new Error("prompt-policy lock orphan ownership changed");
    }
    removeQuarantine(path, identity, owner !== undefined);
  }
}

function createLock(
  parent: string,
  path: string,
  owner: LockOwner,
): LockHandle | undefined {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return undefined;
    }
    throw error;
  }
  chmodSync(path, 0o700);
  const identity = fileIdentity(path);
  try {
    writeFileSync(
      join(path, OWNER_NAME),
      `${JSON.stringify(owner, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    chmodSync(join(path, OWNER_NAME), 0o600);
    const handle = { parent, path, identity, owner };
    verifyOwnedLock(handle, "initialization");
    return handle;
  } catch (error) {
    removeOwnedLockDirectory({ parent, path, identity, owner });
    throw error;
  }
}

async function reclaimStaleLock(
  parent: string,
  path: string,
  replacement: LockOwner,
  options: PromptPolicyLockOptions | undefined,
): Promise<LockHandle> {
  const grace = options?.incompleteGraceMs ?? DEFAULT_INCOMPLETE_GRACE_MS;
  if (!Number.isSafeInteger(grace) || grace < 0) {
    throw new Error("prompt-policy lock grace must be a non-negative integer");
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("prompt-policy lifecycle lock is not a safe directory");
  }
  if ((metadata.mode & 0o777) !== 0o700) {
    throw new Error("prompt-policy lifecycle lock must have mode 0700");
  }
  const identity = fileIdentity(path);
  const entries = readdirSync(path).sort();
  if (
    entries.length > 1 ||
    (entries.length === 1 && entries[0] !== OWNER_NAME)
  ) {
    throw new Error("prompt-policy lifecycle lock contains unexpected entries");
  }
  const owner = entries.length === 1 ? readOwner(path) : undefined;
  if (owner) {
    assertStaleOwner(owner, options?.processStartIdentity);
  } else if (Date.now() - metadata.mtimeMs < grace) {
    throw new Error(
      "prompt-policy lifecycle lock initialization is incomplete within its grace period",
    );
  }

  await options?.beforeStaleQuarantine?.(path);
  assertIdentity(
    path,
    identity,
    "prompt-policy lock changed during stale reclaim",
  );
  if (owner) {
    const current = readOwner(path);
    if (!sameOwner(current, owner)) {
      throw new Error(
        "prompt-policy lock ownership changed during stale reclaim",
      );
    }
    assertStaleOwner(current, options?.processStartIdentity);
  } else if (readdirSync(path).length > 0) {
    throw new Error(
      "prompt-policy orphan lock acquired an owner during reclaim",
    );
  }

  const quarantine = `${path}.stale-${replacement.token}`;
  renameSync(path, quarantine);
  assertIdentity(
    quarantine,
    identity,
    "prompt-policy stale-lock quarantine identity changed",
  );
  const acquired = createLock(parent, path, replacement);
  if (!acquired) {
    removeQuarantine(quarantine, identity, owner !== undefined);
    throw new Error(
      "another prompt-policy operation acquired the lifecycle lock",
    );
  }
  try {
    removeQuarantine(quarantine, identity, owner !== undefined);
  } catch (error) {
    releaseLock(acquired);
    throw error;
  }
  return acquired;
}

function releaseLock(lock: LockHandle): void {
  verifyOwnedLock(lock, "release");
  const quarantine = `${lock.path}.release-${lock.owner.token}`;
  renameSync(lock.path, quarantine);
  assertIdentity(
    quarantine,
    lock.identity,
    "prompt-policy release quarantine identity changed",
  );
  removeQuarantine(quarantine, lock.identity, true);
  removeParentIfEmpty(lock.parent);
}

function removeOwnedLockDirectory(lock: LockHandle): void {
  try {
    verifyOwnedLock(lock, "failed initialization cleanup");
  } catch {
    return;
  }
  const quarantine = `${lock.path}.failed-${lock.owner.token}`;
  renameSync(lock.path, quarantine);
  removeQuarantine(quarantine, lock.identity, true);
  removeParentIfEmpty(lock.parent);
}

function removeQuarantine(
  path: string,
  identity: FileIdentity,
  ownerExpected: boolean,
): void {
  assertIdentity(path, identity, "prompt-policy lock quarantine was replaced");
  const entries = readdirSync(path).sort();
  const expected = ownerExpected ? [OWNER_NAME] : [];
  if (entries.join("\0") !== expected.join("\0")) {
    throw new Error(
      "prompt-policy lock quarantine contains unexpected entries",
    );
  }
  if (ownerExpected) {
    rmSync(join(path, OWNER_NAME));
  }
  rmdirSync(path);
}

function verifyOwnedLock(lock: LockHandle, phase: string): void {
  assertIdentity(
    lock.path,
    lock.identity,
    `prompt-policy lifecycle lock changed during ${phase}`,
  );
  const metadata = lstatSync(lock.path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      `prompt-policy lifecycle lock became unsafe during ${phase}`,
    );
  }
  if (readdirSync(lock.path).sort().join("\0") !== OWNER_NAME) {
    throw new Error(
      `prompt-policy lifecycle lock gained unexpected entries during ${phase}`,
    );
  }
  const owner = readOwner(lock.path);
  if (!sameOwner(owner, lock.owner)) {
    throw new Error(`prompt-policy lock ownership changed during ${phase}`);
  }
}

function readOwner(lockPath: string): LockOwner {
  const path = join(lockPath, OWNER_NAME);
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("prompt-policy lock owner is not a regular file");
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error("prompt-policy lock owner must have mode 0600");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("prompt-policy lock owner is invalid JSON");
  }
  if (!isObject(value)) {
    throw new Error("prompt-policy lock owner is invalid");
  }
  const keys = Object.keys(value).sort();
  const expected = Object.keys({
    schema: true,
    version: true,
    operation: true,
    pid: true,
    processStartIdentity: true,
    token: true,
    createdAtUnixMs: true,
  }).sort();
  if (keys.join("\0") !== expected.join("\0")) {
    throw new Error("prompt-policy lock owner has unexpected fields");
  }
  const operation = value["operation"];
  const pid = value["pid"];
  const processStartIdentity = value["processStartIdentity"];
  const token = value["token"];
  const createdTimestamp = value[["created", "At", "Unix", "Ms"].join("")];
  if (
    value["schema"] !== LOCK_SCHEMA ||
    value["version"] !== LOCK_VERSION ||
    (operation !== "apply" && operation !== "restore") ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !validProcessStartIdentity(processStartIdentity) ||
    typeof token !== "string" ||
    !TOKEN_PATTERN.test(token) ||
    typeof createdTimestamp !== "number" ||
    !Number.isSafeInteger(createdTimestamp) ||
    createdTimestamp < 1
  ) {
    throw new Error("prompt-policy lock owner fields are invalid");
  }
  return {
    schema: LOCK_SCHEMA,
    version: LOCK_VERSION,
    operation,
    pid,
    processStartIdentity,
    token,
    createdAtUnixMs: createdTimestamp,
  };
}

function assertStaleOwner(
  owner: LockOwner,
  provider = defaultProcessStartIdentity,
): void {
  if (!processExists(owner.pid)) {
    return;
  }
  const actual = provider(owner.pid);
  if (!validProcessStartIdentity(actual)) {
    throw new Error(
      `cannot verify prompt-policy lock process identity for pid ${owner.pid}`,
    );
  }
  if (actual === owner.processStartIdentity) {
    throw new Error(
      `prompt-policy lifecycle is owned by live pid ${owner.pid} (${owner.operation})`,
    );
  }
}

function defaultProcessStartIdentity(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) {
        return undefined;
      }
      const fields = stat
        .slice(commandEnd + 1)
        .trim()
        .split(WHITESPACE_PATTERN);
      const startTicks = fields[19];
      return startTicks ? `linux:${startTicks}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    const result = Bun.spawnSync(
      ["/bin/ps", "-o", "lstart=", "-p", String(pid)],
      {
        env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    if (result.exitCode !== 0) {
      return undefined;
    }
    return normalizeDarwinProcessStart(result.stdout.toString());
  }
  return undefined;
}

export function normalizeDarwinProcessStart(
  output: string,
): string | undefined {
  const match = DARWIN_PS_LSTART.exec(output.trim().replace(/\s+/g, " "));
  if (!match) {
    return undefined;
  }
  const weekday = DARWIN_WEEKDAYS.indexOf(match[1] ?? "");
  const month = DARWIN_MONTHS.indexOf(match[2] ?? "");
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const year = Number(match[7]);
  if (weekday < 0 || month < 0) {
    return undefined;
  }
  const epochMs = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(epochMs);
  if (
    !Number.isFinite(epochMs) ||
    date.getUTCDay() !== weekday ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCFullYear() !== year
  ) {
    return undefined;
  }
  return `darwin:${epochMs / 1000}`;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EPERM") {
      return true;
    }
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function validProcessStartIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !LINE_BREAK_PATTERN.test(value)
  );
}

function sameOwner(left: LockOwner, right: LockOwner): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fileIdentity(path: string): FileIdentity {
  const metadata = lstatSync(path);
  return { dev: metadata.dev, ino: metadata.ino };
}

function assertIdentity(
  path: string,
  expected: FileIdentity,
  message: string,
): void {
  let actual: FileIdentity;
  try {
    actual = fileIdentity(path);
  } catch {
    throw new Error(message);
  }
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(message);
  }
}

function ensureSafeParent(parent: string): void {
  const ancestor = dirname(parent);
  const ancestorMetadata = statSync(ancestor);
  if (!ancestorMetadata.isDirectory()) {
    throw new Error("prompt-policy lock parent ancestor is not a directory");
  }
  try {
    const metadata = lstatSync(parent);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("prompt-policy lock parent is not a safe directory");
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
    mkdirSync(parent, { mode: 0o700 });
  }
  chmodSync(parent, 0o700);
}

function removeParentIfEmpty(parent: string): void {
  try {
    if (readdirSync(parent).length === 0) {
      rmdirSync(parent);
    }
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === "ENOENT" || error.code === "ENOTEMPTY")
    ) {
      return;
    }
    throw error;
  }
}

export function defaultLockParent(temporaryDirectory = tmpdir()): string {
  const uid =
    typeof process.getuid === "function" ? process.getuid() : process.pid;
  const systemTemp = realpathSync(temporaryDirectory);
  return join(systemTemp, `skizzles-prompt-policy-locks-${uid}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
