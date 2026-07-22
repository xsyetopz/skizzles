import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import type { RunWorkspace } from "@skizzles/scratchspace";
import {
  assertCompleteCatalog,
  type JsonObject,
  LUNA_MODEL,
  parseJson,
} from "../catalog/schema.ts";
import { codexSupervisorGroup } from "./group.ts";
import {
  codexSupervisorCommand,
  codexSupervisorProtocol,
  type FinalCodexSupervisorMessage,
} from "./supervisor.ts";

const SEMANTIC_VERSION =
  /(?<![0-9A-Za-z-])((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?=\s|$)/;

export type ChildFailure =
  | "bundled-exit"
  | "cancelled"
  | "invalid-bundled-json"
  | "invalid-preflight-json"
  | "lifecycle"
  | "preflight-exit"
  | "spawn"
  | "stderr-limit"
  | "stdout-limit"
  | "stream"
  | "timeout"
  | "unsupported-platform"
  | "unsafe-binary"
  | "version-exit"
  | "version-format";

const CHILD_FAILURE_MESSAGES: Record<ChildFailure, string> = {
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
  "unsupported-platform":
    "Codex child process groups are unsupported on Windows until Job Object ownership is implemented",
  "unsafe-binary": "codex binary must be a physical absolute regular file",
  "version-exit": "codex version command failed",
  "version-format":
    "codex version did not contain a valid full semantic version",
};

export class CodexChildError extends Error {
  readonly code: ChildFailure;

  constructor(code: ChildFailure) {
    super(CHILD_FAILURE_MESSAGES[code]);
    this.name = "CodexChildError";
    this.code = code;
  }
}

export interface CommandLimits {
  timeoutMs: number;
  terminationGraceMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

interface CommandResult {
  stdout: Uint8Array;
  exitCode: number;
}

type CodexSubprocess = Bun.Subprocess<"ignore", "pipe", "pipe">;

interface CodexSpawnOptions {
  readonly stdin: "ignore";
  readonly stdout: "pipe";
  readonly stderr: "pipe";
  readonly env: Record<string, string>;
  readonly detached: true;
  readonly ipc: (message: unknown) => void;
}

export interface CodexRuntime {
  readonly platform: NodeJS.Platform;
  readonly kill?: typeof process.kill;
  spawn: (command: string[], options: CodexSpawnOptions) => CodexSubprocess;
}

export const systemCodexRuntime: CodexRuntime = {
  platform: process.platform,
  spawn: (command, options) => Bun.spawn(command, options),
};

type ArgumentsFactory =
  | string[]
  | ((isolatedHome: string) => Promise<string[]>);

export function requireOwnedProcessScope(platform: NodeJS.Platform): void {
  if (platform === "win32") {
    throw new CodexChildError("unsupported-platform");
  }
}

function commandEnvironment(home: string): Record<string, string> {
  return {
    CODEX_HOME: home,
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    TMPDIR: join(home, "tmp"),
    XDG_CACHE_HOME: join(home, "xdg-cache"),
    XDG_CONFIG_HOME: join(home, "xdg-config"),
    XDG_DATA_HOME: join(home, "xdg-data"),
  };
}

async function isolatedHome(workspace: RunWorkspace): Promise<string> {
  const home = workspace.path(`codex-home-${crypto.randomUUID()}`);
  await mkdir(home, { mode: 0o700 });
  for (const directory of ["tmp", "xdg-cache", "xdg-config", "xdg-data"]) {
    await mkdir(join(home, directory), { mode: 0o700 });
  }
  return home;
}

async function validateCodexBinary(path: string): Promise<void> {
  try {
    if (!isAbsolute(path) || (await realpath(path)) !== path) {
      throw new CodexChildError("unsafe-binary");
    }
    const metadata = await lstat(path);
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

function concatenate(chunks: Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  failure: "stderr-limit" | "stdout-limit",
  signal: AbortSignal,
  stop: (reason: ChildFailure) => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = (): void => {
    reader.cancel().catch(() => undefined);
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

async function runIsolatedCodex(
  workspace: RunWorkspace,
  codexBinary: string,
  argsFactory: ArgumentsFactory,
  limits: CommandLimits,
  runtime: CodexRuntime,
): Promise<CommandResult> {
  requireOwnedProcessScope(runtime.platform);
  await validateCodexBinary(codexBinary);
  const home = await isolatedHome(workspace);
  try {
    const args =
      typeof argsFactory === "function" ? await argsFactory(home) : argsFactory;
    const protocol = codexSupervisorProtocol();
    let child: CodexSubprocess;
    try {
      child = runtime.spawn(codexSupervisorCommand(codexBinary, args), {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: commandEnvironment(home),
        detached: true,
        ipc: protocol.receive,
      });
    } catch {
      throw new CodexChildError("spawn");
    }
    const group = codexSupervisorGroup(
      child,
      `codex-supervisor-${child.pid}`,
      runtime.kill,
    );
    try {
      workspace.registerChild(group);
    } catch {
      await group.stopWithin(limits.terminationGraceMs).catch(() => undefined);
      throw new CodexChildError("lifecycle");
    }

    const controller = new AbortController();
    let failure: ChildFailure | undefined;
    let cleanupFailed = false;
    const cleanupFailure = Promise.withResolvers<void>();
    let cleanup: Promise<void> | undefined;
    const cleanGroup = (): Promise<void> => {
      cleanup ??= group.stopWithin(limits.terminationGraceMs).catch(() => {
        cleanupFailed = true;
        cleanupFailure.resolve();
      });
      return cleanup;
    };
    const stop = (reason: ChildFailure): void => {
      failure ??= reason;
      controller.abort();
      cleanGroup().catch(() => undefined);
    };
    const cancel = (): void => stop("cancelled");
    workspace.signal.addEventListener("abort", cancel, { once: true });
    if (workspace.signal.aborted) {
      cancel();
    }
    const timer = setTimeout(() => stop("timeout"), limits.timeoutMs);
    try {
      const supervisorOutcome = Promise.race([
        protocol.final.then(
          (message) => ({ message, ok: true as const }),
          () => ({ ok: false as const }),
        ),
        child.exited.then(() => ({ ok: false as const })),
        cleanupFailure.promise.then(() => ({ ok: false as const })),
      ]).then(async (outcome) => {
        await cleanGroup();
        controller.abort();
        return outcome;
      });
      const [stdout, , outcome] = await Promise.all([
        collectBounded(
          child.stdout,
          limits.maxStdoutBytes,
          "stdout-limit",
          controller.signal,
          stop,
        ),
        collectBounded(
          child.stderr,
          limits.maxStderrBytes,
          "stderr-limit",
          controller.signal,
          stop,
        ),
        supervisorOutcome,
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

function commandResult(
  stdout: Uint8Array,
  message: FinalCodexSupervisorMessage,
): CommandResult {
  if (message.type === "spawn-error") {
    throw new CodexChildError("spawn");
  }
  if (message.type !== "exited") {
    throw new CodexChildError("lifecycle");
  }
  return { stdout, exitCode: message.exitCode };
}

function parseJsonOutput(
  output: Uint8Array,
  failure: "invalid-bundled-json" | "invalid-preflight-json",
): unknown {
  try {
    return parseJson(new TextDecoder().decode(output));
  } catch {
    throw new CodexChildError(failure);
  }
}

export async function clientVersion(
  workspace: RunWorkspace,
  codexBinary: string,
  limits: CommandLimits,
  runtime: CodexRuntime = systemCodexRuntime,
): Promise<string> {
  const result = await runIsolatedCodex(
    workspace,
    codexBinary,
    ["--version"],
    {
      ...limits,
      maxStdoutBytes: Math.min(limits.maxStdoutBytes, 1024),
    },
    runtime,
  );
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

export async function bundledCatalog(
  workspace: RunWorkspace,
  codexBinary: string,
  limits: CommandLimits,
  runtime: CodexRuntime = systemCodexRuntime,
): Promise<JsonObject> {
  const result = await runIsolatedCodex(
    workspace,
    codexBinary,
    ["debug", "models", "--bundled"],
    limits,
    runtime,
  );
  if (result.exitCode !== 0) {
    throw new CodexChildError("bundled-exit");
  }
  return assertCompleteCatalog(
    parseJsonOutput(result.stdout, "invalid-bundled-json"),
  );
}

export async function preflightCatalog(
  workspace: RunWorkspace,
  codexBinary: string,
  contents: string,
  limits: CommandLimits,
  runtime: CodexRuntime = systemCodexRuntime,
): Promise<void> {
  const result = await runIsolatedCodex(
    workspace,
    codexBinary,
    async (home) => {
      const candidate = join(home, "candidate.json");
      await writeFile(candidate, contents, { mode: 0o600, flag: "wx" });
      return [
        "debug",
        "models",
        "-c",
        `model_catalog_json=${JSON.stringify(candidate)}`,
      ];
    },
    limits,
    runtime,
  );
  if (result.exitCode !== 0) {
    throw new CodexChildError("preflight-exit");
  }
  const loaded = assertCompleteCatalog(
    parseJsonOutput(result.stdout, "invalid-preflight-json"),
  );
  const loadedLuna = loaded.models.filter(
    (entry) => entry["slug"] === LUNA_MODEL,
  );
  if (
    loadedLuna.length !== 1 ||
    loadedLuna[0]?.["multi_agent_version"] !== "v2"
  ) {
    throw new Error("catalog preflight did not load Luna V2");
  }
}
