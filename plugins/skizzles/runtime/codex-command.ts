#!/usr/bin/env bun
// @bun

// packages/command-supervisor/src/codex-command.ts
import process7 from "process";

// packages/command-supervisor/src/codex-command/cli.ts
import process6 from "process";

// packages/command-supervisor/src/codex-command/run-command.ts
import { join as join5 } from "path";
import process5 from "process";

// packages/command-supervisor/src/codex-command/run-artifacts.ts
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync as lstatSync3,
  mkdirSync as mkdirSync2,
  openSync,
  readFileSync as readFileSync2,
  realpathSync as realpathSync2,
  renameSync as renameSync2,
  unlinkSync,
  writeSync
} from "fs";
import { basename as basename2, dirname as dirname3, join as join3 } from "path";

// packages/command-supervisor/src/codex-command/run-retention.ts
import {
  lstatSync as lstatSync2,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync
} from "fs";
import { dirname as dirname2, join as join2, resolve as resolve2 } from "path";

// packages/command-supervisor/src/codex-command/run-root.ts
import { lstatSync, mkdirSync, realpathSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import process from "process";
function currentUid() {
  return process.getuid?.();
}
function identity(info) {
  return {
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    mode: info.mode,
    size: info.size,
    mtimeMs: info.mtimeMs
  };
}
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode && left.size === right.size && left.mtimeMs === right.mtimeMs;
}
function sameDirectoryNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode;
}
function ownedByCurrentUser(info) {
  const uid = currentUid();
  return uid === undefined || info.uid === uid;
}
function hasMode(info, mode) {
  return (info.mode & 511) === mode;
}
function isOwnedDirectory(info, mode) {
  return info.isDirectory() && !info.isSymbolicLink() && ownedByCurrentUser(info) && hasMode(info, mode);
}
function isOwnedRegularFile(info, mode) {
  return info.isFile() && !info.isSymbolicLink() && ownedByCurrentUser(info) && hasMode(info, mode);
}
function trustedParent(path) {
  const physical = realpathSync(path);
  const info = lstatSync(physical);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("run root parent is not a physical directory");
  }
  const uid = currentUid();
  const writableByOthers = (info.mode & 18) !== 0;
  const trustedOwner = uid === undefined || info.uid === uid || info.uid === 0;
  const trustedStickyRoot = info.uid === 0 && (info.mode & 512) !== 0;
  if (!trustedOwner || writableByOthers && !trustedStickyRoot) {
    throw new Error("run root parent is not trusted");
  }
  return physical;
}
function validateExistingRoot(path) {
  const absolute = resolve(path);
  const direct = lstatSync(absolute);
  if (direct.isSymbolicLink()) {
    throw new Error("run root must not be a symlink");
  }
  const physical = realpathSync(absolute);
  const info = lstatSync(physical);
  if (!isOwnedDirectory(info, 448)) {
    throw new Error("run root must be an owner-only directory");
  }
  return physical;
}
function prepareRunRoot(path) {
  const absolute = resolve(path);
  try {
    return validateExistingRoot(absolute);
  } catch (error) {
    if (!(error instanceof Error && ("code" in error) && error.code === "ENOENT")) {
      throw error;
    }
  }
  const parent = trustedParent(dirname(absolute));
  const physical = join(parent, basename(absolute));
  mkdirSync(physical, { mode: 448 });
  return validateExistingRoot(physical);
}
function validatedRootIdentity(root) {
  if (realpathSync(root) !== root) {
    throw new Error("run root is not physically contained");
  }
  const info = lstatSync(root);
  if (!isOwnedDirectory(info, 448)) {
    throw new Error("run root ownership changed");
  }
  return identity(info);
}

// packages/command-supervisor/src/codex-command/run-retention.ts
var maximumStatusBytes = 1024 * 1024;
var generatedRunIdPattern = /^[a-f0-9]{12}$/;
var artifactNames = ["status.json", "stderr.log", "stdout.log"];
var allowedStatusKeys = new Set([
  "id",
  "command",
  "startedAt",
  "completedAt",
  "exitCode",
  "signal",
  "shell",
  "stdoutObservedBytes",
  "stderrObservedBytes",
  "stdoutStoredBytes",
  "stderrStoredBytes",
  "stdoutTruncated",
  "stderrTruncated",
  "artifactCapture",
  "drainIncomplete"
]);
function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function statusCounter(status, key) {
  const value = status[key];
  return isNonnegativeInteger(value) ? value : undefined;
}
function validStatusStrings(status, id) {
  return status["id"] === id && typeof status["command"] === "string" && typeof status["shell"] === "string" && typeof status["startedAt"] === "string" && !Number.isNaN(Date.parse(status["startedAt"])) && typeof status["completedAt"] === "string" && !Number.isNaN(Date.parse(status["completedAt"]));
}
function validStatusCounters(status) {
  return [
    "stdoutObservedBytes",
    "stderrObservedBytes",
    "stdoutStoredBytes",
    "stderrStoredBytes"
  ].every((key) => isNonnegativeInteger(status[key]));
}
function validStatusFlags(status) {
  return typeof status["stdoutTruncated"] === "boolean" && typeof status["stderrTruncated"] === "boolean" && typeof status["drainIncomplete"] === "boolean" && status["artifactCapture"] === "active";
}
function completedStatus(content, id) {
  let status;
  try {
    status = JSON.parse(content);
  } catch {
    return;
  }
  if (!isRecord(status)) {
    return;
  }
  const record = status;
  if (Object.keys(record).some((key) => !allowedStatusKeys.has(key))) {
    return;
  }
  const signal = record["signal"];
  const validSignal = signal === undefined || signal === "SIGHUP" || signal === "SIGINT" || signal === "SIGTERM";
  if (!(validSignal && validStatusStrings(record, id) && validStatusCounters(record) && validStatusFlags(record) && isNonnegativeInteger(record["exitCode"]))) {
    return;
  }
  const stdoutStoredBytes = statusCounter(record, "stdoutStoredBytes");
  const stderrStoredBytes = statusCounter(record, "stderrStoredBytes");
  const stdoutObservedBytes = statusCounter(record, "stdoutObservedBytes");
  const stderrObservedBytes = statusCounter(record, "stderrObservedBytes");
  if (stdoutStoredBytes === undefined) {
    return;
  }
  if (stderrStoredBytes === undefined) {
    return;
  }
  if (stdoutObservedBytes === undefined) {
    return;
  }
  if (stderrObservedBytes === undefined) {
    return;
  }
  if (stdoutStoredBytes > stdoutObservedBytes || stderrStoredBytes > stderrObservedBytes) {
    return;
  }
  return { stdoutStoredBytes, stderrStoredBytes };
}
function exactArtifactEntries(path) {
  try {
    const entries = readdirSync(path).sort();
    return entries.length === artifactNames.length && artifactNames.every((name, index) => entries[index] === name);
  } catch {
    return false;
  }
}
function inspectCompletedRun(path, id) {
  try {
    const directory = lstatSync2(path);
    if (!(isOwnedDirectory(directory, 448) && exactArtifactEntries(path))) {
      return;
    }
    const statusInfo = lstatSync2(join2(path, "status.json"));
    const stderrInfo = lstatSync2(join2(path, "stderr.log"));
    const stdoutInfo = lstatSync2(join2(path, "stdout.log"));
    if (!isOwnedRegularFile(statusInfo, 384) || statusInfo.size > maximumStatusBytes || !isOwnedRegularFile(stderrInfo, 384) || !isOwnedRegularFile(stdoutInfo, 384)) {
      return;
    }
    const marker = completedStatus(readFileSync(join2(path, "status.json"), "utf8"), id);
    if (!marker || marker.stdoutStoredBytes !== stdoutInfo.size || marker.stderrStoredBytes !== stderrInfo.size) {
      return;
    }
    return {
      id,
      path,
      mtime: directory.mtimeMs,
      size: statusInfo.size + stderrInfo.size + stdoutInfo.size,
      directoryIdentity: identity(directory),
      artifactIdentities: {
        "status.json": identity(statusInfo),
        "stderr.log": identity(stderrInfo),
        "stdout.log": identity(stdoutInfo)
      }
    };
  } catch {
    return;
  }
}
function sameRunIdentity(left, right) {
  return left.id === right.id && sameIdentity(left.directoryIdentity, right.directoryIdentity) && artifactNames.every((name) => sameIdentity(left.artifactIdentities[name], right.artifactIdentities[name]));
}
function restoreQuarantine(quarantine, original) {
  try {
    lstatSync2(original);
  } catch {
    try {
      renameSync(quarantine, original);
    } catch {}
  }
}
function removeRetainedRun(root, rootIdentity, run) {
  if (dirname2(resolve2(run.path)) !== root) {
    return false;
  }
  const current = inspectCompletedRun(run.path, run.id);
  if (!(current && sameRunIdentity(run, current))) {
    return false;
  }
  const quarantine = join2(root, `.cleanup-${run.id}-${crypto.randomUUID()}`);
  try {
    renameSync(run.path, quarantine);
  } catch {
    return false;
  }
  try {
    const moved = inspectCompletedRun(quarantine, run.id);
    const currentRoot = identity(lstatSync2(root));
    const safeToRemove = moved !== undefined && sameRunIdentity(run, moved) && sameDirectoryNode(rootIdentity, currentRoot) && dirname2(resolve2(quarantine)) === root;
    if (!safeToRemove) {
      restoreQuarantine(quarantine, run.path);
      return false;
    }
    rmSync(quarantine, { recursive: true });
    return true;
  } catch {
    restoreQuarantine(quarantine, run.path);
    return false;
  }
}
function cleanOldRuns(root, limit) {
  try {
    const rootIdentity = validatedRootIdentity(root);
    const entries = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && generatedRunIdPattern.test(entry.name)).map((entry) => inspectCompletedRun(join2(root, entry.name), entry.name)).filter((entry) => entry !== undefined).sort((left, right) => left.mtime - right.mtime);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= limit) {
        break;
      }
      if (removeRetainedRun(root, rootIdentity, entry)) {
        total -= entry.size;
      }
    }
  } catch {}
}

// packages/command-supervisor/src/codex-command/run-artifacts.ts
var retainedOutputTailBytes = 1200;
function closeArtifact(file) {
  if (file === undefined) {
    return;
  }
  try {
    closeSync(file);
  } catch {}
}
function createRunId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}
function prepareRunArtifacts(root, id, maximumDiskBytes) {
  let directory;
  let statusPath;
  let stdoutFile;
  let stderrFile;
  try {
    const physicalRoot = prepareRunRoot(root);
    cleanOldRuns(physicalRoot, maximumDiskBytes);
    validatedRootIdentity(physicalRoot);
    directory = join3(physicalRoot, id);
    mkdirSync2(directory, { mode: 448 });
    if (!isOwnedDirectory(lstatSync3(directory), 448)) {
      throw new Error("run directory is not owner-only");
    }
    stdoutFile = openSync(join3(directory, "stdout.log"), "wx", 384);
    stderrFile = openSync(join3(directory, "stderr.log"), "wx", 384);
    statusPath = join3(directory, "status.json");
    return {
      directory,
      statusPath,
      stdoutFile,
      stderrFile,
      available: true,
      setupError: undefined
    };
  } catch (error) {
    closeArtifact(stdoutFile);
    closeArtifact(stderrFile);
    return {
      directory,
      statusPath: undefined,
      stdoutFile: undefined,
      stderrFile: undefined,
      available: false,
      setupError: error instanceof Error ? error.message : "unknown error"
    };
  }
}
function closeRunArtifacts(artifacts) {
  closeArtifact(artifacts.stdoutFile);
  closeArtifact(artifacts.stderrFile);
}
function writeAll(file, content) {
  let offset = 0;
  while (offset < content.length) {
    const written = writeSync(file, content, offset, content.length - offset);
    if (written <= 0) {
      throw new Error("unable to persist status artifact");
    }
    offset += written;
  }
}
function missingPath(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function statusIdentity(path) {
  try {
    const info = lstatSync3(path);
    if (!isOwnedRegularFile(info, 384)) {
      throw new Error("status artifact is not owner-only");
    }
    return identity(info);
  } catch (error) {
    if (missingPath(error)) {
      return;
    }
    throw error;
  }
}
function sameOptionalIdentity(left, right) {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return sameIdentity(left, right);
}
function cleanupOwnedTemporary(path, expected) {
  if (!expected) {
    return;
  }
  try {
    const current = identity(lstatSync3(path));
    if (sameDirectoryNode(expected, current)) {
      unlinkSync(path);
    }
  } catch {}
}
function fsyncRunDirectory(directory, expected) {
  let file;
  try {
    file = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(file);
    const unchangedDirectory = isOwnedDirectory(info, 448) && sameDirectoryNode(expected, identity(info));
    if (!unchangedDirectory) {
      throw new Error("run directory identity changed");
    }
    fsyncSync(file);
  } finally {
    closeArtifact(file);
  }
}
function statusWriteBoundary(statusPath, status) {
  const directory = dirname3(statusPath);
  const root = dirname3(directory);
  if (basename2(statusPath) !== "status.json" || basename2(directory) !== status.id || realpathSync2(directory) !== directory) {
    throw new Error("status path escaped its run directory");
  }
  const rootIdentity = validatedRootIdentity(root);
  const directoryInfo = lstatSync3(directory);
  if (!isOwnedDirectory(directoryInfo, 448)) {
    throw new Error("run directory is not owner-only");
  }
  return {
    root,
    rootIdentity,
    directory,
    directoryIdentity: identity(directoryInfo),
    previousStatusIdentity: statusIdentity(statusPath)
  };
}
function writeStatus(statusPath, status) {
  if (!statusPath) {
    return;
  }
  let file;
  let temporaryIdentity;
  let temporaryPath;
  try {
    const boundary = statusWriteBoundary(statusPath, status);
    const content = Buffer.from(`${JSON.stringify(status)}
`);
    temporaryPath = join3(boundary.directory, `.status-${crypto.randomUUID()}.tmp`);
    file = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 384);
    const temporaryInfo = fstatSync(file);
    temporaryIdentity = identity(temporaryInfo);
    if (!isOwnedRegularFile(temporaryInfo, 384)) {
      throw new Error("status temporary is not owner-only");
    }
    writeAll(file, content);
    fsyncSync(file);
    temporaryIdentity = identity(fstatSync(file));
    closeArtifact(file);
    file = undefined;
    const currentRootIdentity = validatedRootIdentity(boundary.root);
    const currentDirectoryInfo = lstatSync3(boundary.directory);
    const currentDirectoryIdentity = identity(currentDirectoryInfo);
    const currentStatusIdentity = statusIdentity(statusPath);
    const currentTemporaryIdentity = identity(lstatSync3(temporaryPath));
    const unchangedBoundary = sameDirectoryNode(boundary.rootIdentity, currentRootIdentity) && isOwnedDirectory(currentDirectoryInfo, 448) && sameDirectoryNode(boundary.directoryIdentity, currentDirectoryIdentity) && sameIdentity(temporaryIdentity, currentTemporaryIdentity) && sameOptionalIdentity(boundary.previousStatusIdentity, currentStatusIdentity);
    if (!unchangedBoundary) {
      throw new Error("status write boundary changed");
    }
    renameSync2(temporaryPath, statusPath);
    temporaryPath = undefined;
    fsyncRunDirectory(boundary.directory, boundary.directoryIdentity);
  } catch {} finally {
    closeArtifact(file);
    if (temporaryPath) {
      cleanupOwnedTemporary(temporaryPath, temporaryIdentity);
    }
  }
}
function artifactContents(path) {
  try {
    return readFileSync2(path, "utf8");
  } catch {
    return "";
  }
}
function artifactTail(path) {
  try {
    const content = readFileSync2(path);
    return content.subarray(Math.max(0, content.length - retainedOutputTailBytes)).toString("utf8");
  } catch {
    return "";
  }
}

// packages/command-supervisor/src/codex-command/settings.ts
import { accessSync, constants as constants2 } from "fs";
import { tmpdir } from "os";
import { basename as basename3, isAbsolute, join as join4, relative, resolve as resolve3 } from "path";
import process2 from "process";
var defaultMaximumBytes = 16 * 1024 * 1024;
var defaultMaximumDiskBytes = 256 * 1024 * 1024;
var defaultHeartbeatMilliseconds = 30000;
var defaultDrainMilliseconds = 750;
var defaultInlineBytes = 10 * 1024;
var defaultSignalGraceMilliseconds = 750;
function integerEnvironment(name, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number.parseInt(process2.env[name] ?? "", 10);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}
function runRoot() {
  if (process2.env["CODEX_COMMAND_OUTPUT_DIR"]) {
    return process2.env["CODEX_COMMAND_OUTPUT_DIR"];
  }
  const candidate = resolve3(tmpdir());
  const cwd = resolve3(process2.cwd());
  const fromWorkingTree = relative(cwd, candidate);
  const safeTemporaryDirectory = fromWorkingTree === "" || !(fromWorkingTree.startsWith("..") || isAbsolute(fromWorkingTree)) ? "/tmp" : candidate;
  return join4(safeTemporaryDirectory, "codex-command-output");
}
function commandShell() {
  const candidate = process2.env["SHELL"];
  if (!(candidate && isAbsolute(candidate))) {
    return "/bin/sh";
  }
  if (!["bash", "dash", "ksh", "sh", "zsh"].includes(basename3(candidate))) {
    return "/bin/sh";
  }
  try {
    accessSync(candidate, constants2.X_OK);
    if (resolve3(candidate) !== resolve3(process2.argv[1] ?? "")) {
      return candidate;
    }
  } catch {
    return "/bin/sh";
  }
  return "/bin/sh";
}
function loadRunSettings() {
  const maximumBytes = integerEnvironment("CODEX_COMMAND_MAX_BYTES", defaultMaximumBytes, 1);
  return {
    root: runRoot(),
    maximumBytes,
    maximumDiskBytes: integerEnvironment("CODEX_COMMAND_MAX_DISK_BYTES", defaultMaximumDiskBytes, maximumBytes),
    heartbeatMilliseconds: integerEnvironment("CODEX_COMMAND_HEARTBEAT_MS", defaultHeartbeatMilliseconds, 25),
    drainMilliseconds: integerEnvironment("CODEX_COMMAND_DRAIN_MS", defaultDrainMilliseconds, 0),
    inlineBytes: integerEnvironment("CODEX_COMMAND_INLINE_BYTES", defaultInlineBytes, 0),
    signalGraceMilliseconds: integerEnvironment("CODEX_COMMAND_SIGNAL_GRACE_MS", defaultSignalGraceMilliseconds, 0, 60000)
  };
}

// packages/command-supervisor/src/codex-command/shell-process.ts
import process3 from "process";
var supervisedSignals = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP"
];
var signalExitCodes = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143
};
function missingProcess(error) {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}
function signalProcessTree(child, signal) {
  if (process3.platform !== "win32") {
    try {
      process3.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (missingProcess(error)) {
        return;
      }
    }
  }
  try {
    child.kill(signal);
  } catch {}
}
function processTreeExists(child) {
  try {
    process3.kill(process3.platform === "win32" ? child.pid : -child.pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitForProcessTreeExit(child, timeoutMilliseconds) {
  const deadline = performance.now() + timeoutMilliseconds;
  while (performance.now() < deadline) {
    if (!processTreeExists(child)) {
      return true;
    }
    await Bun.sleep(10);
  }
  return !processTreeExists(child);
}
function spawnSupervisedShell(shell, script, signalGraceMilliseconds) {
  const child = Bun.spawn([shell, "-c", script], {
    cwd: process3.cwd(),
    env: process3.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    detached: process3.platform !== "win32"
  });
  let receivedSignal;
  let shellExited = false;
  let signalAfterShellExit = false;
  let shellExitCode;
  let escalationTimer;
  let escalationComplete = false;
  let resolveEscalation = () => {
    return;
  };
  const escalation = new Promise((resolve4) => {
    resolveEscalation = resolve4;
  });
  const finishEscalation = () => {
    if (escalationComplete) {
      return;
    }
    escalationComplete = true;
    if (escalationTimer) {
      clearTimeout(escalationTimer);
    }
    escalationTimer = undefined;
    resolveEscalation();
  };
  const forceExit = () => {
    signalProcessTree(child, "SIGKILL");
    finishEscalation();
  };
  const handleSignal = (signal) => {
    if (receivedSignal !== undefined) {
      forceExit();
      return;
    }
    receivedSignal = signal;
    signalAfterShellExit = shellExited;
    signalProcessTree(child, signal);
    escalationTimer = setTimeout(forceExit, signalGraceMilliseconds);
    escalationTimer.unref();
  };
  const handlers = new Map;
  for (const signal of supervisedSignals) {
    const handler = handleSignal.bind(undefined, signal);
    handlers.set(signal, handler);
    process3.on(signal, handler);
  }
  const removeHandlers = () => {
    for (const [signal, handler] of handlers) {
      process3.off(signal, handler);
    }
  };
  const settleReceivedSignal = async () => {
    if (receivedSignal === undefined) {
      return;
    }
    if (processTreeExists(child)) {
      const exitedBeforeEscalation = await Promise.race([
        waitForProcessTreeExit(child, signalGraceMilliseconds + 25),
        escalation.then(() => false)
      ]);
      if (exitedBeforeEscalation) {
        finishEscalation();
      } else {
        await escalation;
      }
    } else {
      finishEscalation();
    }
    await waitForProcessTreeExit(child, 500);
  };
  const settleNormalCompletion = async () => {
    if (!processTreeExists(child)) {
      return false;
    }
    signalProcessTree(child, "SIGTERM");
    const exitedGracefully = await waitForProcessTreeExit(child, signalGraceMilliseconds);
    if (!exitedGracefully) {
      signalProcessTree(child, "SIGKILL");
    }
    await waitForProcessTreeExit(child, 500);
    return true;
  };
  return {
    child,
    waitForShell: async () => {
      shellExitCode = await child.exited;
      shellExited = true;
      return shellExitCode;
    },
    finish: async () => {
      await Bun.sleep(0);
      let forcedCleanup = false;
      if (receivedSignal === undefined) {
        forcedCleanup = await settleNormalCompletion();
      } else {
        await settleReceivedSignal();
      }
      const signal = receivedSignal;
      const exitCode = signal !== undefined && signalAfterShellExit ? signalExitCodes[signal] : shellExitCode ?? await child.exited;
      return { exitCode, signal, forcedCleanup };
    },
    close: () => {
      finishEscalation();
      removeHandlers();
    }
  };
}

// packages/command-supervisor/src/codex-command/stream-capture.ts
import { writeSync as writeSync2 } from "fs";
import process4 from "process";
function emptyCaptureState() {
  return {
    observedBytes: 0,
    storedBytes: 0,
    truncated: false,
    finished: false
  };
}
function forwardChunk(streamName, chunk) {
  (streamName === "stdout" ? process4.stdout : process4.stderr).write(chunk);
}
function retainChunk(artifact, chunk, maximumBytes, state) {
  const remaining = maximumBytes - state.storedBytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  const stored = chunk.subarray(0, remaining);
  try {
    const written = writeSync2(artifact, stored);
    state.storedBytes += written;
    if (written !== chunk.length) {
      state.truncated = true;
    }
  } catch {
    state.truncated = true;
  }
}
function consumeChunk(streamName, chunk, artifact, maximumBytes, forward, state) {
  state.observedBytes += chunk.length;
  if (forward) {
    forwardChunk(streamName, chunk);
  }
  if (artifact !== undefined) {
    retainChunk(artifact, chunk, maximumBytes, state);
  }
}
function captureStream(stream, streamName, artifact, maximumBytes, forward, state) {
  if (!stream) {
    state.finished = true;
    return { done: Promise.resolve(), cancel: () => {
      return;
    } };
  }
  const reader = stream.getReader();
  let cancelled = false;
  const done = (async () => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        if (cancelled) {
          break;
        }
        consumeChunk(streamName, next.value, artifact, maximumBytes, forward, state);
      }
    } catch {
      state.truncated = true;
    } finally {
      state.finished = true;
      reader.releaseLock();
    }
  })();
  return {
    done,
    cancel: () => {
      cancelled = true;
      reader.cancel().catch(() => {
        return;
      });
    }
  };
}
function printCaptured(label, content) {
  if (!content) {
    return;
  }
  process4.stdout.write(`[codex-command] ${label}:
${content}`);
  if (!content.endsWith(`
`)) {
    process4.stdout.write(`
`);
  }
}

// packages/command-supervisor/src/codex-command/run-command.ts
function syncStreamStatus(status, stdout, stderr) {
  status.stdoutObservedBytes = stdout.observedBytes;
  status.stderrObservedBytes = stderr.observedBytes;
  status.stdoutStoredBytes = stdout.storedBytes;
  status.stderrStoredBytes = stderr.storedBytes;
  status.stdoutTruncated = stdout.truncated;
  status.stderrTruncated = stderr.truncated;
}
function progressReporter(startedAt, stdout, stderr) {
  let lastReportedStdoutBytes = 0;
  let lastReportedStderrBytes = 0;
  return () => {
    if (stdout.observedBytes === lastReportedStdoutBytes && stderr.observedBytes === lastReportedStderrBytes) {
      return;
    }
    const seconds = Math.floor((performance.now() - startedAt) / 1000);
    console.log(`| ${seconds}s | ${stdout.observedBytes}B | ${stderr.observedBytes}B |`);
    lastReportedStdoutBytes = stdout.observedBytes;
    lastReportedStderrBytes = stderr.observedBytes;
  };
}
function waitForCaptureDrain(captures, drainMilliseconds) {
  const allDone = Promise.all(captures.map((capture) => capture.done));
  return Promise.race([
    allDone.then(() => true),
    Bun.sleep(drainMilliseconds).then(() => false)
  ]);
}
async function finishCaptures(captures) {
  const allDone = Promise.all(captures.map((capture) => capture.done));
  const finished = await Promise.race([
    allDone.then(() => true),
    Bun.sleep(25).then(() => false)
  ]);
  if (!finished) {
    for (const capture of captures) {
      capture.cancel();
    }
    await Promise.race([allDone, Bun.sleep(25)]);
  }
}
function renderRetainedOutput(directory, status, inlineBytes) {
  const combinedBytes = status.stdoutObservedBytes + status.stderrObservedBytes;
  const printFullOutput = combinedBytes <= inlineBytes && !status.stdoutTruncated && !status.stderrTruncated;
  if (printFullOutput) {
    printCaptured("stdout", artifactContents(join5(directory, "stdout.log")));
    printCaptured("stderr", artifactContents(join5(directory, "stderr.log")));
    return;
  }
  printCaptured("stdout tail", artifactTail(join5(directory, "stdout.log")));
  printCaptured("stderr tail", artifactTail(join5(directory, "stderr.log")));
}
function renderCompletion(status, processStartedAt) {
  if (status.stdoutTruncated || status.stderrTruncated) {
    console.log(`[codex-command] retained out=${status.stdoutStoredBytes}/${status.stdoutObservedBytes}B err=${status.stderrStoredBytes}/${status.stderrObservedBytes}B`);
  }
  const outcome = status.signal ? `signal ${status.signal}` : `exit ${status.exitCode ?? "unknown"}`;
  const incomplete = status.drainIncomplete ? " drain-incomplete" : "";
  const elapsedSeconds = Math.floor((performance.now() - processStartedAt) / 1000);
  console.log(`[codex-command] ${outcome} in ${elapsedSeconds}s${incomplete}`);
}
async function runCommand(script) {
  const settings = loadRunSettings();
  const id = createRunId();
  const artifacts = prepareRunArtifacts(settings.root, id, settings.maximumDiskBytes);
  if (artifacts.setupError) {
    console.error(`[codex-command] warning: artifact capture unavailable (${artifacts.setupError}); supervising without artifacts`);
  }
  const shell = commandShell();
  const status = {
    id,
    command: script,
    startedAt: new Date().toISOString(),
    shell,
    stdoutObservedBytes: 0,
    stderrObservedBytes: 0,
    stdoutStoredBytes: 0,
    stderrStoredBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    artifactCapture: artifacts.available ? "active" : "unavailable",
    drainIncomplete: false
  };
  writeStatus(artifacts.statusPath, status);
  console.log(`[codex-command] artifact: ${artifacts.directory ?? "unavailable"}`);
  console.log("| seconds | out | err |");
  const processStartedAt = performance.now();
  let supervisedShell;
  try {
    supervisedShell = spawnSupervisedShell(shell, script, settings.signalGraceMilliseconds);
  } catch (error) {
    status.completedAt = new Date().toISOString();
    status.exitCode = 127;
    writeStatus(artifacts.statusPath, status);
    closeRunArtifacts(artifacts);
    console.error(`[codex-command] unable to start command: ${error instanceof Error ? error.message : "unknown error"}`);
    return 127;
  }
  const shouldForward = !artifacts.available || Boolean(process5.stdout.isTTY || process5.stderr.isTTY);
  const stdoutState = emptyCaptureState();
  const stderrState = emptyCaptureState();
  const captures = [
    captureStream(supervisedShell.child.stdout, "stdout", artifacts.stdoutFile, settings.maximumBytes, shouldForward, stdoutState),
    captureStream(supervisedShell.child.stderr, "stderr", artifacts.stderrFile, settings.maximumBytes, shouldForward, stderrState)
  ];
  const reportProgress = progressReporter(processStartedAt, stdoutState, stderrState);
  const heartbeat = setInterval(() => {
    syncStreamStatus(status, stdoutState, stderrState);
    writeStatus(artifacts.statusPath, status);
    reportProgress();
  }, settings.heartbeatMilliseconds);
  heartbeat.unref();
  await supervisedShell.waitForShell();
  let result;
  let drainedNaturally = false;
  try {
    drainedNaturally = await waitForCaptureDrain(captures, settings.drainMilliseconds);
  } finally {
    try {
      result = await supervisedShell.finish();
      status.drainIncomplete = !drainedNaturally || result.forcedCleanup;
      await finishCaptures(captures);
      status.completedAt = new Date().toISOString();
      status.exitCode = result.exitCode;
      if (result.signal !== undefined) {
        status.signal = result.signal;
      }
      syncStreamStatus(status, stdoutState, stderrState);
      clearInterval(heartbeat);
      closeRunArtifacts(artifacts);
      writeStatus(artifacts.statusPath, status);
    } finally {
      supervisedShell.close();
    }
  }
  reportProgress();
  if (!shouldForward && artifacts.available && artifacts.directory) {
    renderRetainedOutput(artifacts.directory, status, settings.inlineBytes);
  }
  renderCompletion(status, processStartedAt);
  return result.exitCode;
}

// packages/command-supervisor/src/codex-command/run-queries.ts
import { lstatSync as lstatSync4, readdirSync as readdirSync2, readFileSync as readFileSync3 } from "fs";
import { join as join6 } from "path";
var queryRunIdPattern = /^[A-Za-z0-9._-]+$/;
function validateQueryRunId(id) {
  if (id === "." || id === ".." || !queryRunIdPattern.test(id)) {
    throw new Error("invalid run id");
  }
}
function requireRegularArtifact(directory, filename, label) {
  const path = join6(directory, filename);
  try {
    const info = lstatSync4(path);
    if (!isOwnedRegularFile(info, 384)) {
      throw new Error("not an owned file");
    }
    return path;
  } catch {
    throw new Error(`${label} artifact unavailable`);
  }
}

class RunStoreQueries {
  requestedRoot;
  constructor(root) {
    this.requestedRoot = root;
  }
  root() {
    try {
      return validateExistingRoot(this.requestedRoot);
    } catch {
      throw new Error("run store unavailable");
    }
  }
  requireRunDirectory(id) {
    validateQueryRunId(id);
    const directory = join6(this.root(), id);
    try {
      const info = lstatSync4(directory);
      if (isOwnedDirectory(info, 448)) {
        return directory;
      }
    } catch {}
    throw new Error(`run not found: ${id}`);
  }
  status(id) {
    const directory = this.requireRunDirectory(id);
    const path = requireRegularArtifact(directory, "status.json", "status");
    try {
      return readFileSync3(path, "utf8");
    } catch {
      throw new Error("status artifact unavailable");
    }
  }
  tail(id, stream) {
    const directory = this.requireRunDirectory(id);
    const filename = stream === "stdout" ? "stdout.log" : "stderr.log";
    const path = requireRegularArtifact(directory, filename, `${stream} log`);
    try {
      const content = readFileSync3(path);
      return content.subarray(Math.max(0, content.length - retainedOutputTailBytes)).toString("utf8");
    } catch {
      throw new Error(`${stream} log artifact unavailable`);
    }
  }
  search(needle, id) {
    if (!needle || needle.length > 256) {
      throw new Error("search text must be 1-256 characters");
    }
    const directories = id ? [this.requireRunDirectory(id)] : this.retainedRunDirectories();
    const matches = [];
    for (const directory of directories) {
      for (const filename of ["stdout.log", "stderr.log"]) {
        try {
          const path = requireRegularArtifact(directory, filename, filename);
          if (readFileSync3(path, "utf8").includes(needle)) {
            matches.push(path);
          }
        } catch {}
      }
    }
    return matches;
  }
  retainedRunDirectories() {
    const root = this.root();
    try {
      return readdirSync2(root, { withFileTypes: true }).filter((entry) => {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          return false;
        }
        try {
          return isOwnedDirectory(lstatSync4(join6(root, entry.name)), 448);
        } catch {
          return false;
        }
      }).map((entry) => join6(root, entry.name));
    } catch {
      throw new Error("run store unavailable");
    }
  }
}

// packages/command-supervisor/src/codex-command/cli.ts
var usage = "usage: codex-command run --base64url <script> | status <run-id> | tail <run-id> [stdout|stderr] | errors <run-id> | search <text> [run-id]";
var base64UrlPattern = /^[A-Za-z0-9_-]+$/;
function decodeScript(value) {
  if (!base64UrlPattern.test(value)) {
    throw new Error("encoded script is not base64url");
  }
  const result = Buffer.from(value, "base64url").toString("utf8");
  if (!result || Buffer.from(result, "utf8").toString("base64url") !== value) {
    throw new Error("encoded script is invalid");
  }
  return result;
}
function selectedStream(value) {
  const stream = value ?? "stdout";
  if (stream !== "stdout" && stream !== "stderr") {
    throw new Error("stream must be stdout or stderr");
  }
  return stream;
}
function writeTail(content) {
  process6.stdout.write(content);
  if (!content.endsWith(`
`)) {
    process6.stdout.write(`
`);
  }
}
function requiredArgument(arguments_, index) {
  const value = arguments_[index];
  if (value === undefined) {
    throw new Error("missing command argument");
  }
  return value;
}
function executeRun(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--base64url") {
    return;
  }
  return runCommand(decodeScript(requiredArgument(arguments_, 1)));
}
function executeQuery(subcommand, arguments_) {
  const queries = new RunStoreQueries(runRoot());
  if (subcommand === "status" && arguments_.length === 1) {
    process6.stdout.write(queries.status(requiredArgument(arguments_, 0)));
    return 0;
  }
  if (subcommand === "tail" && (arguments_.length === 1 || arguments_.length === 2)) {
    writeTail(queries.tail(requiredArgument(arguments_, 0), selectedStream(arguments_[1])));
    return 0;
  }
  if (subcommand === "errors" && arguments_.length === 1) {
    writeTail(queries.tail(requiredArgument(arguments_, 0), "stderr"));
    return 0;
  }
  if (subcommand === "search" && (arguments_.length === 1 || arguments_.length === 2)) {
    for (const path of queries.search(requiredArgument(arguments_, 0), arguments_[1])) {
      console.log(path);
    }
    return 0;
  }
  return;
}
function execute(subcommand, arguments_) {
  return subcommand === "run" ? executeRun(arguments_) : executeQuery(subcommand, arguments_);
}
async function dispatchCommand(arguments_) {
  const [subcommand, ...subcommandArguments] = arguments_;
  try {
    const exitCode = await execute(subcommand, subcommandArguments);
    if (exitCode !== undefined) {
      return exitCode;
    }
    console.error(usage);
    return 64;
  } catch (error) {
    console.error(`[codex-command] ${error instanceof Error ? error.message : "unexpected failure"}`);
    return 64;
  }
}

// packages/command-supervisor/src/codex-command.ts
process7.exit(await dispatchCommand(process7.argv.slice(2)));
