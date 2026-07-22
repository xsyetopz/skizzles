#!/usr/bin/env bun
// @bun

// packages/command-supervisor/src/codex-command.ts
import process8 from "process";

// packages/command-supervisor/src/codex-command/cli.ts
import process7 from "process";

// packages/command-supervisor/src/codex-command/run/command.ts
import { join as join5 } from "path";
import process6 from "process";

// packages/command-supervisor/src/codex-command/capture-lifecycle.ts
var captureCancellationMilliseconds = 25;
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
    Bun.sleep(captureCancellationMilliseconds).then(() => false)
  ]);
  if (!finished) {
    for (const capture of captures) {
      capture.cancel();
    }
    await Promise.race([allDone, Bun.sleep(captureCancellationMilliseconds)]);
  }
}

// packages/command-supervisor/src/codex-command/settings.ts
import { accessSync, constants } from "fs";
import { tmpdir } from "os";
import { basename, isAbsolute, join, relative, resolve } from "path";
import process from "process";
var defaultMaximumBytes = 16 * 1024 * 1024;
var defaultMaximumDiskBytes = 256 * 1024 * 1024;
var defaultHeartbeatMilliseconds = 30000;
var defaultDrainMilliseconds = 750;
var defaultInlineBytes = 10 * 1024;
var defaultSignalGraceMilliseconds = 750;
function integerEnvironment(name, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}
function runRoot(options = {}) {
  const environment = options.environment ?? process.env;
  const configured = environment["CODEX_COMMAND_OUTPUT_DIR"];
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  const candidate = resolve(options.temporaryDirectory ?? tmpdir());
  const cwd = resolve(options.workingDirectory ?? process.cwd());
  const fromWorkingTree = relative(cwd, candidate);
  const insideWorkingTree = fromWorkingTree === "" || !(fromWorkingTree.startsWith("..") || isAbsolute(fromWorkingTree));
  if (insideWorkingTree) {
    throw new Error("The platform temporary directory is inside the working tree; set CODEX_COMMAND_OUTPUT_DIR to a durable external path.");
  }
  return join(candidate, "codex-command-output");
}
function commandShell() {
  const candidate = process.env["SHELL"];
  if (!(candidate && isAbsolute(candidate))) {
    return "/bin/sh";
  }
  if (!["bash", "dash", "ksh", "sh", "zsh"].includes(basename(candidate))) {
    return "/bin/sh";
  }
  try {
    accessSync(candidate, constants.X_OK);
    if (resolve(candidate) !== resolve(process.argv[1] ?? "")) {
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
    maximumDiskBytes: integerEnvironment("CODEX_COMMAND_MAX_DISK_BYTES", Math.max(defaultMaximumDiskBytes, maximumBytes), maximumBytes),
    heartbeatMilliseconds: integerEnvironment("CODEX_COMMAND_HEARTBEAT_MS", defaultHeartbeatMilliseconds, 25),
    drainMilliseconds: integerEnvironment("CODEX_COMMAND_DRAIN_MS", defaultDrainMilliseconds, 0),
    inlineBytes: integerEnvironment("CODEX_COMMAND_INLINE_BYTES", defaultInlineBytes, 0),
    signalGraceMilliseconds: integerEnvironment("CODEX_COMMAND_SIGNAL_GRACE_MS", defaultSignalGraceMilliseconds, 0, 60000)
  };
}

// packages/command-supervisor/src/codex-command/shell-process.ts
import process3 from "process";

// packages/command-supervisor/src/codex-command/process-tree.ts
import process2 from "process";
var forcedExitWaitMilliseconds = 500;
function missingProcess(error) {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}
function signalProcessTree(child, signal) {
  if (process2.platform !== "win32") {
    try {
      process2.kill(-child.pid, signal);
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
    let target = -child.pid;
    if (process2.platform === "win32") {
      target = child.pid;
    }
    process2.kill(target, 0);
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
async function terminateProcessTree(child, signalGraceMilliseconds) {
  if (!processTreeExists(child)) {
    return "not-required";
  }
  signalProcessTree(child, "SIGTERM");
  const exitedGracefully = await waitForProcessTreeExit(child, signalGraceMilliseconds);
  if (exitedGracefully) {
    return "terminated";
  }
  signalProcessTree(child, "SIGKILL");
  await waitForProcessTreeExit(child, forcedExitWaitMilliseconds);
  return "killed";
}

// packages/command-supervisor/src/codex-command/shell-process.ts
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
  let escalated = false;
  let resolveEscalation = () => {
    return;
  };
  const escalation = new Promise((resolve2) => {
    resolveEscalation = resolve2;
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
    escalated = true;
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
      return "not-required";
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
    return escalated ? "killed" : "terminated";
  };
  const settleNormalCompletion = async () => terminateProcessTree(child, signalGraceMilliseconds);
  return {
    child,
    waitForShell: async () => {
      shellExitCode = await child.exited;
      shellExited = true;
      return shellExitCode;
    },
    finish: async () => {
      await Bun.sleep(0);
      const cleanup = receivedSignal === undefined ? await settleNormalCompletion() : await settleReceivedSignal();
      const signal = receivedSignal;
      const exitCode = signal !== undefined && signalAfterShellExit ? signalExitCodes[signal] : shellExitCode ?? await child.exited;
      return { exitCode, signal, cleanup };
    },
    close: () => {
      finishEscalation();
      removeHandlers();
    }
  };
}

// packages/command-supervisor/src/codex-command/stream-capture.ts
import { createHash } from "crypto";
import { writeSync } from "fs";
import process4 from "process";
function emptyCaptureState() {
  return {
    observedBytes: 0,
    storedBytes: 0,
    truncated: false,
    finished: false,
    retainedSha256: createHash("sha256")
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
    const written = writeSync(artifact, stored);
    state.storedBytes += written;
    state.retainedSha256.update(stored.subarray(0, written));
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
  return consumeStream(stream, state, (chunk) => {
    consumeChunk(streamName, chunk, artifact, maximumBytes, forward, state);
  });
}
function consumeStream(stream, state, consume) {
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
        consume(next.value);
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

// packages/command-supervisor/src/codex-command/run/artifacts.ts
import {
  closeSync,
  constants as constants2,
  fstatSync,
  fsyncSync,
  lstatSync as lstatSync3,
  mkdirSync as mkdirSync2,
  openSync,
  readFileSync as readFileSync2,
  realpathSync as realpathSync2,
  renameSync as renameSync2,
  unlinkSync,
  writeSync as writeSync2
} from "fs";
import { basename as basename3, dirname as dirname3, join as join4 } from "path";

// packages/command-supervisor/src/codex-command/run/retention.ts
import {
  lstatSync as lstatSync2,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync
} from "fs";
import { dirname as dirname2, join as join3, resolve as resolve3 } from "path";

// packages/command-supervisor/src/codex-command/run/status.ts
import { createHash as createHash2 } from "crypto";
var runStatusSchema = "skizzles.command-supervisor/run-status";
var runStatusVersion = 1;
var operatorActionLabel = "operator shell action";
var failedStartExitCode = 127;
function sha256Digest(content) {
  return createHash2("sha256").update(content).digest("hex");
}
function emptyEvidence(reference) {
  return {
    reference,
    sensitivity: "operator-private",
    redaction: "none",
    integrity: "unauthenticated-sha256",
    observedBytes: 0,
    storedBytes: 0,
    truncated: false,
    sha256: sha256Digest(new Uint8Array)
  };
}
function createRunStatus(input) {
  return {
    schema: runStatusSchema,
    version: runStatusVersion,
    id: input.id,
    action: {
      label: operatorActionLabel,
      sha256: sha256Digest(input.script),
      sensitivity: "secret-bearing",
      redaction: "content-omitted"
    },
    execution: { shell: input.shell },
    retention: {
      policy: "per-output-cap-with-pre-run-completed-cleanup",
      maximumOutputArtifactBytes: input.settings.maximumBytes,
      cleanupThresholdBytes: input.settings.maximumDiskBytes,
      directoryMode: "0700",
      fileMode: "0600"
    },
    evidence: {
      stdout: emptyEvidence("stdout.log"),
      stderr: emptyEvidence("stderr.log")
    },
    lifecycle: {
      state: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      exitCode: null,
      cancellationSignal: null,
      drain: "pending",
      cleanup: "pending"
    },
    artifactCapture: input.artifactCapture
  };
}
function updateEvidence(evidence, capture) {
  evidence.observedBytes = capture.observedBytes;
  evidence.storedBytes = capture.storedBytes;
  evidence.truncated = capture.truncated;
  evidence.sha256 = capture.retainedSha256.copy().digest("hex");
}
function syncRunEvidence(status, stdout, stderr) {
  updateEvidence(status.evidence.stdout, stdout);
  updateEvidence(status.evidence.stderr, stderr);
}
function failRunStart(status) {
  status.lifecycle.state = "failed-to-start";
  status.lifecycle.completedAt = new Date().toISOString();
  status.lifecycle.exitCode = failedStartExitCode;
  status.lifecycle.drain = "complete";
  status.lifecycle.cleanup = "not-required";
}
function completeRun(status, input) {
  status.lifecycle.state = "completed";
  status.lifecycle.completedAt = new Date().toISOString();
  status.lifecycle.exitCode = input.exitCode;
  status.lifecycle.cancellationSignal = input.signal ?? null;
  status.lifecycle.drain = "incomplete";
  if (input.drainedNaturally) {
    status.lifecycle.drain = "complete";
  }
  status.lifecycle.cleanup = input.cleanup;
}

// packages/command-supervisor/src/codex-command/run/evidence.ts
function verifyEvidence(status, evidence, content) {
  const terminal = status.lifecycle.state !== "running";
  return content.length >= evidence.storedBytes && (!terminal || content.length === evidence.storedBytes) && content.length <= status.retention.maximumOutputArtifactBytes && sha256Digest(content.subarray(0, evidence.storedBytes)) === evidence.sha256;
}
function verifyRunEvidence(status, stdout, stderr) {
  return verifyEvidence(status, status.evidence.stdout, stdout) && verifyEvidence(status, status.evidence.stderr, stderr);
}

// packages/command-supervisor/src/codex-command/run/root.ts
import { lstatSync, mkdirSync, realpathSync } from "fs";
import { basename as basename2, dirname, join as join2, resolve as resolve2 } from "path";
import process5 from "process";
function currentUid() {
  return process5.getuid?.();
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
  const absolute = resolve2(path);
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
  const absolute = resolve2(path);
  try {
    return validateExistingRoot(absolute);
  } catch (error) {
    if (!(error instanceof Error && ("code" in error) && error.code === "ENOENT")) {
      throw error;
    }
  }
  const parent = trustedParent(dirname(absolute));
  const physical = join2(parent, basename2(absolute));
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

// packages/command-supervisor/src/codex-command/run/lifecycle-codec.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactLifecycleKeys(value) {
  const expected = [
    "cancellationSignal",
    "cleanup",
    "completedAt",
    "drain",
    "exitCode",
    "startedAt",
    "state"
  ];
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && expected.every((key, index) => key === actual[index]);
}
function isSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isIsoTimestamp(value) {
  if (typeof value !== "string") {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}
function runningLifecycle(startedAt, completedAt, exitCode, cancellationSignal, drain, cleanup) {
  if (completedAt !== null || exitCode !== null || cancellationSignal !== null || drain !== "pending" || cleanup !== "pending") {
    return;
  }
  return {
    state: "running",
    startedAt,
    completedAt,
    exitCode,
    cancellationSignal,
    drain,
    cleanup
  };
}
function terminalLifecycle(state, startedAt, completedAt, exitCode, cancellationSignal, drain, cleanup) {
  if (completedAt < startedAt) {
    return;
  }
  if (state === "failed-to-start") {
    if (exitCode !== 127 || cancellationSignal !== null || drain !== "complete" || cleanup !== "not-required") {
      return;
    }
    return {
      state,
      startedAt,
      completedAt,
      exitCode,
      cancellationSignal,
      drain,
      cleanup
    };
  }
  if (state !== "completed" || drain !== "complete" && drain !== "incomplete" || cleanup === "pending" || cancellationSignal !== null && cleanup === "not-required") {
    return;
  }
  return {
    state,
    startedAt,
    completedAt,
    exitCode,
    cancellationSignal,
    drain,
    cleanup
  };
}
function parseRunLifecycle(value) {
  if (!(isRecord(value) && hasExactLifecycleKeys(value) && isIsoTimestamp(value["startedAt"]))) {
    return;
  }
  const state = value["state"];
  const completedAt = value["completedAt"];
  const exitCode = value["exitCode"];
  const cancellationSignal = value["cancellationSignal"];
  const drain = value["drain"];
  const cleanup = value["cleanup"];
  const validSignal = cancellationSignal === null || cancellationSignal === "SIGHUP" || cancellationSignal === "SIGINT" || cancellationSignal === "SIGTERM";
  const validCleanup = cleanup === "pending" || cleanup === "not-required" || cleanup === "terminated" || cleanup === "killed";
  if (!(validSignal && validCleanup)) {
    return;
  }
  if (state === "running") {
    return runningLifecycle(value["startedAt"], completedAt, exitCode, cancellationSignal, drain, cleanup);
  }
  if (!(isIsoTimestamp(completedAt) && isSafeInteger(exitCode))) {
    return;
  }
  return terminalLifecycle(state, value["startedAt"], completedAt, exitCode, cancellationSignal, drain, cleanup);
}

// packages/command-supervisor/src/codex-command/run/status-codec.ts
var maximumStatusBytes = 64 * 1024;
var sha256Pattern = /^[a-f0-9]{64}$/u;
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && expected.every((key, index) => key === actual[index]);
}
function isSafeInteger2(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function parseEvidence(value, reference, maximumBytes) {
  if (!(isRecord2(value) && hasExactKeys(value, [
    "integrity",
    "observedBytes",
    "redaction",
    "reference",
    "sensitivity",
    "sha256",
    "storedBytes",
    "truncated"
  ]))) {
    return;
  }
  const observedBytes = value["observedBytes"];
  const storedBytes = value["storedBytes"];
  const truncated = value["truncated"];
  const digest = value["sha256"];
  const valid = value["reference"] === reference && value["sensitivity"] === "operator-private" && value["redaction"] === "none" && value["integrity"] === "unauthenticated-sha256" && isSafeInteger2(observedBytes) && isSafeInteger2(storedBytes) && storedBytes <= observedBytes && storedBytes <= maximumBytes && typeof truncated === "boolean" && (observedBytes === storedBytes || truncated) && typeof digest === "string" && sha256Pattern.test(digest);
  if (!valid || typeof digest !== "string") {
    return;
  }
  return {
    reference,
    sensitivity: "operator-private",
    redaction: "none",
    integrity: "unauthenticated-sha256",
    observedBytes,
    storedBytes,
    truncated,
    sha256: digest
  };
}
function parseRunStatus(content, id) {
  if (Buffer.byteLength(content) > maximumStatusBytes) {
    throw new Error("status exceeds its schema bound");
  }
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("status is not valid JSON");
  }
  if (!(isRecord2(value) && hasExactKeys(value, [
    "action",
    "artifactCapture",
    "evidence",
    "execution",
    "id",
    "lifecycle",
    "retention",
    "schema",
    "version"
  ])) || value["schema"] !== runStatusSchema || value["version"] !== runStatusVersion || value["id"] !== id || value["artifactCapture"] !== "active") {
    throw new Error("status schema is unsupported");
  }
  const action = value["action"];
  const execution = value["execution"];
  const retention = value["retention"];
  const evidence = value["evidence"];
  if (!(isRecord2(action) && hasExactKeys(action, ["label", "redaction", "sensitivity", "sha256"])) || action["label"] !== operatorActionLabel || action["sensitivity"] !== "secret-bearing" || action["redaction"] !== "content-omitted" || typeof action["sha256"] !== "string" || !sha256Pattern.test(action["sha256"]) || !isRecord2(execution) || !hasExactKeys(execution, ["shell"]) || typeof execution["shell"] !== "string" || !execution["shell"].startsWith("/") || execution["shell"].length > 4096 || !isRecord2(retention) || !hasExactKeys(retention, [
    "cleanupThresholdBytes",
    "directoryMode",
    "fileMode",
    "maximumOutputArtifactBytes",
    "policy"
  ]) || retention["policy"] !== "per-output-cap-with-pre-run-completed-cleanup" || retention["directoryMode"] !== "0700" || retention["fileMode"] !== "0600" || !isSafeInteger2(retention["maximumOutputArtifactBytes"]) || retention["maximumOutputArtifactBytes"] < 1 || !isSafeInteger2(retention["cleanupThresholdBytes"]) || retention["cleanupThresholdBytes"] < retention["maximumOutputArtifactBytes"] || !isRecord2(evidence) || !hasExactKeys(evidence, ["stderr", "stdout"])) {
    throw new Error("status schema is malformed");
  }
  const stdout = parseEvidence(evidence["stdout"], "stdout.log", retention["maximumOutputArtifactBytes"]);
  const stderr = parseEvidence(evidence["stderr"], "stderr.log", retention["maximumOutputArtifactBytes"]);
  const lifecycle = parseRunLifecycle(value["lifecycle"]);
  if (!(stdout && stderr && lifecycle)) {
    throw new Error("status schema is malformed");
  }
  return {
    schema: runStatusSchema,
    version: runStatusVersion,
    id,
    action: {
      label: operatorActionLabel,
      sha256: action["sha256"],
      sensitivity: "secret-bearing",
      redaction: "content-omitted"
    },
    execution: { shell: execution["shell"] },
    retention: {
      policy: "per-output-cap-with-pre-run-completed-cleanup",
      maximumOutputArtifactBytes: retention["maximumOutputArtifactBytes"],
      cleanupThresholdBytes: retention["cleanupThresholdBytes"],
      directoryMode: "0700",
      fileMode: "0600"
    },
    evidence: { stdout, stderr },
    lifecycle,
    artifactCapture: "active"
  };
}
function serializeRunStatus(status) {
  const content = `${JSON.stringify(status)}
`;
  if (status.artifactCapture === "active") {
    parseRunStatus(content, status.id);
  }
  return content;
}

// packages/command-supervisor/src/codex-command/run/retention.ts
var generatedRunIdPattern = /^[a-f0-9]{12}$/u;
var artifactNames = ["status.json", "stderr.log", "stdout.log"];
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
    const statusInfo = lstatSync2(join3(path, "status.json"));
    const stderrInfo = lstatSync2(join3(path, "stderr.log"));
    const stdoutInfo = lstatSync2(join3(path, "stdout.log"));
    if (!isOwnedRegularFile(statusInfo, 384) || statusInfo.size > maximumStatusBytes || !isOwnedRegularFile(stderrInfo, 384) || !isOwnedRegularFile(stdoutInfo, 384)) {
      return;
    }
    const status = parseRunStatus(readFileSync(join3(path, "status.json"), "utf8"), id);
    if (status.lifecycle.state === "running" || stdoutInfo.size !== status.evidence.stdout.storedBytes || stderrInfo.size !== status.evidence.stderr.storedBytes || stdoutInfo.size > status.retention.maximumOutputArtifactBytes || stderrInfo.size > status.retention.maximumOutputArtifactBytes || !verifyRunEvidence(status, readFileSync(join3(path, "stdout.log")), readFileSync(join3(path, "stderr.log")))) {
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
  } catch {}
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
  if (dirname2(resolve3(run.path)) !== root) {
    return false;
  }
  const current = inspectCompletedRun(run.path, run.id);
  if (!(current && sameRunIdentity(run, current))) {
    return false;
  }
  const quarantine = join3(root, `.cleanup-${run.id}-${crypto.randomUUID()}`);
  try {
    renameSync(run.path, quarantine);
  } catch {
    return false;
  }
  try {
    const moved = inspectCompletedRun(quarantine, run.id);
    const currentRoot = identity(lstatSync2(root));
    const safeToRemove = moved !== undefined && sameRunIdentity(run, moved) && sameDirectoryNode(rootIdentity, currentRoot) && dirname2(resolve3(quarantine)) === root;
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
    const entries = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && generatedRunIdPattern.test(entry.name)).map((entry) => inspectCompletedRun(join3(root, entry.name), entry.name)).filter((entry) => entry !== undefined).sort((left, right) => left.mtime - right.mtime);
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

// packages/command-supervisor/src/codex-command/run/artifacts.ts
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
    directory = join4(physicalRoot, id);
    mkdirSync2(directory, { mode: 448 });
    if (!isOwnedDirectory(lstatSync3(directory), 448)) {
      throw new Error("run directory is not owner-only");
    }
    stdoutFile = openSync(join4(directory, "stdout.log"), "wx", 384);
    stderrFile = openSync(join4(directory, "stderr.log"), "wx", 384);
    statusPath = join4(directory, "status.json");
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
    const written = writeSync2(file, content, offset, content.length - offset);
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
    file = openSync(directory, constants2.O_RDONLY | constants2.O_NOFOLLOW);
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
  if (basename3(statusPath) !== "status.json" || basename3(directory) !== status.id || realpathSync2(directory) !== directory) {
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
    const content = Buffer.from(serializeRunStatus(status));
    temporaryPath = join4(boundary.directory, `.status-${crypto.randomUUID()}.tmp`);
    file = openSync(temporaryPath, constants2.O_WRONLY | constants2.O_CREAT | constants2.O_EXCL | constants2.O_NOFOLLOW, 384);
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

// packages/command-supervisor/src/codex-command/run/command.ts
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
function renderRetainedOutput(directory, status, inlineBytes) {
  const combinedBytes = status.evidence.stdout.observedBytes + status.evidence.stderr.observedBytes;
  const printFullOutput = combinedBytes <= inlineBytes && !status.evidence.stdout.truncated && !status.evidence.stderr.truncated;
  if (printFullOutput) {
    printCaptured("stdout", artifactContents(join5(directory, "stdout.log")));
    printCaptured("stderr", artifactContents(join5(directory, "stderr.log")));
    return;
  }
  printCaptured("stdout tail", artifactTail(join5(directory, "stdout.log")));
  printCaptured("stderr tail", artifactTail(join5(directory, "stderr.log")));
}
function renderCompletion(status, processStartedAt) {
  if (status.evidence.stdout.truncated || status.evidence.stderr.truncated) {
    console.log(`[codex-command] retained out=${status.evidence.stdout.storedBytes}/${status.evidence.stdout.observedBytes}B err=${status.evidence.stderr.storedBytes}/${status.evidence.stderr.observedBytes}B`);
  }
  const outcome = status.lifecycle.cancellationSignal ? `signal ${status.lifecycle.cancellationSignal}` : `exit ${status.lifecycle.exitCode ?? "unknown"}`;
  const incomplete = status.lifecycle.drain === "incomplete" ? " drain-incomplete" : "";
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
  const status = createRunStatus({
    id,
    script,
    shell,
    settings,
    artifactCapture: artifacts.available ? "active" : "unavailable"
  });
  writeStatus(artifacts.statusPath, status);
  console.log(`[codex-command] artifact: ${artifacts.directory ?? "unavailable"}`);
  console.log("| seconds | out | err |");
  const processStartedAt = performance.now();
  let supervisedShell;
  try {
    supervisedShell = spawnSupervisedShell(shell, script, settings.signalGraceMilliseconds);
  } catch (error) {
    failRunStart(status);
    writeStatus(artifacts.statusPath, status);
    closeRunArtifacts(artifacts);
    console.error(`[codex-command] unable to start command: ${error instanceof Error ? error.message : "unknown error"}`);
    return 127;
  }
  const shouldForward = !artifacts.available || Boolean(process6.stdout.isTTY || process6.stderr.isTTY);
  const stdoutState = emptyCaptureState();
  const stderrState = emptyCaptureState();
  const captures = [
    captureStream(supervisedShell.child.stdout, "stdout", artifacts.stdoutFile, settings.maximumBytes, shouldForward, stdoutState),
    captureStream(supervisedShell.child.stderr, "stderr", artifacts.stderrFile, settings.maximumBytes, shouldForward, stderrState)
  ];
  const reportProgress = progressReporter(processStartedAt, stdoutState, stderrState);
  const heartbeat = setInterval(() => {
    syncRunEvidence(status, stdoutState, stderrState);
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
      await finishCaptures(captures);
      completeRun(status, {
        exitCode: result.exitCode,
        signal: result.signal,
        drainedNaturally,
        cleanup: result.cleanup
      });
      syncRunEvidence(status, stdoutState, stderrState);
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

// packages/command-supervisor/src/codex-command/run/queries.ts
import { lstatSync as lstatSync4, readdirSync as readdirSync2, readFileSync as readFileSync3 } from "fs";
import { join as join6 } from "path";
var queryRunIdPattern = /^[A-Za-z0-9._-]+$/u;
function validateQueryRunId(id) {
  if (id === "." || id === ".." || !queryRunIdPattern.test(id)) {
    throw new Error("invalid run id");
  }
}
function requireRegularArtifact(directory, filename, label, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const path = join6(directory, filename);
  try {
    const info = lstatSync4(path);
    if (!isOwnedRegularFile(info, 384) || info.size > maximumBytes) {
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
    const path = requireRegularArtifact(directory, "status.json", "status", maximumStatusBytes);
    try {
      const content = readFileSync3(path, "utf8");
      const status = parseRunStatus(content, id);
      const stdoutPath = requireRegularArtifact(directory, status.evidence.stdout.reference, "stdout log", status.retention.maximumOutputArtifactBytes);
      const stderrPath = requireRegularArtifact(directory, status.evidence.stderr.reference, "stderr log", status.retention.maximumOutputArtifactBytes);
      if (!verifyRunEvidence(status, readFileSync3(stdoutPath), readFileSync3(stderrPath))) {
        throw new Error("status evidence mismatch");
      }
      return content;
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
var base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
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
  process7.stdout.write(content);
  if (!content.endsWith(`
`)) {
    process7.stdout.write(`
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
    process7.stdout.write(queries.status(requiredArgument(arguments_, 0)));
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
process8.exit(await dispatchCommand(process8.argv.slice(2)));
