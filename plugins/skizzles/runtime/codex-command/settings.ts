import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { RunSettings } from "./types.ts";

const defaultMaximumBytes = 16 * 1024 * 1024;
const defaultMaximumDiskBytes = 256 * 1024 * 1024;
const defaultHeartbeatMilliseconds = 30_000;
const defaultDrainMilliseconds = 750;
const defaultInlineBytes = 10 * 1024;
const defaultSignalGraceMilliseconds = 750;

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

export function runRoot(): string {
  if (process.env["CODEX_COMMAND_OUTPUT_DIR"]) {
    return process.env["CODEX_COMMAND_OUTPUT_DIR"];
  }
  const candidate = resolve(tmpdir());
  const cwd = resolve(process.cwd());
  const fromWorkingTree = relative(cwd, candidate);
  const safeTemporaryDirectory =
    fromWorkingTree === "" ||
    !(fromWorkingTree.startsWith("..") || isAbsolute(fromWorkingTree))
      ? "/tmp"
      : candidate;
  return join(safeTemporaryDirectory, "codex-command-output");
}

/** Uses the invoking shell only when it is an absolute executable with familiar
 * `-c` semantics. /bin/sh is the portable, non-recursive fallback. */
export function commandShell(): string {
  const candidate = process.env["SHELL"];
  if (!(candidate && isAbsolute(candidate))) return "/bin/sh";
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

export function loadRunSettings(): RunSettings {
  const maximumBytes = integerEnvironment(
    "CODEX_COMMAND_MAX_BYTES",
    defaultMaximumBytes,
    1,
  );
  return {
    root: runRoot(),
    maximumBytes,
    maximumDiskBytes: integerEnvironment(
      "CODEX_COMMAND_MAX_DISK_BYTES",
      defaultMaximumDiskBytes,
      maximumBytes,
    ),
    heartbeatMilliseconds: integerEnvironment(
      "CODEX_COMMAND_HEARTBEAT_MS",
      defaultHeartbeatMilliseconds,
      25,
    ),
    drainMilliseconds: integerEnvironment(
      "CODEX_COMMAND_DRAIN_MS",
      defaultDrainMilliseconds,
      0,
    ),
    inlineBytes: integerEnvironment(
      "CODEX_COMMAND_INLINE_BYTES",
      defaultInlineBytes,
      0,
    ),
    signalGraceMilliseconds: integerEnvironment(
      "CODEX_COMMAND_SIGNAL_GRACE_MS",
      defaultSignalGraceMilliseconds,
      0,
      60_000,
    ),
  };
}
