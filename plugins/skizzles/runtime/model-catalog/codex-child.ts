import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  assertCompleteCatalog,
  type JsonObject,
  LUNA_MODEL,
} from "./catalog-schema.ts";

const SEMANTIC_VERSION =
  /(?<![0-9A-Za-z-])((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?=\s|$)/;

type ChildFailure =
  | "bundled-exit"
  | "invalid-bundled-json"
  | "invalid-preflight-json"
  | "lifecycle"
  | "preflight-exit"
  | "spawn"
  | "stderr-limit"
  | "stdout-limit"
  | "stream"
  | "timeout"
  | "unsafe-binary"
  | "version-exit"
  | "version-format";

const CHILD_FAILURE_MESSAGES: Record<ChildFailure, string> = {
  "bundled-exit": "codex bundled catalog command failed",
  "invalid-bundled-json": "codex bundled catalog returned invalid JSON",
  "invalid-preflight-json": "catalog preflight returned invalid JSON",
  lifecycle: "codex command cleanup failed",
  "preflight-exit": "catalog preflight command failed",
  spawn: "codex command could not start",
  "stderr-limit": "codex stderr exceeds its byte limit",
  "stdout-limit": "codex stdout exceeds its byte limit",
  stream: "codex command stream failed",
  timeout: "codex command timed out",
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

type ArgumentsFactory =
  | string[]
  | ((isolatedHome: string) => Promise<string[]>);

function commandEnvironment(home: string): Record<string, string> {
  return {
    CODEX_HOME: home,
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    PATH: globalThis.process.env["PATH"] ?? "/usr/bin:/bin",
    TMPDIR: join(home, "tmp"),
    XDG_CACHE_HOME: join(home, "xdg-cache"),
    XDG_CONFIG_HOME: join(home, "xdg-config"),
    XDG_DATA_HOME: join(home, "xdg-data"),
  };
}

async function isolatedHome(): Promise<string> {
  const physicalTemp = await realpath(tmpdir());
  const home = await mkdtemp(join(physicalTemp, "skizzles-model-catalog-"));
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
    if (error instanceof CodexChildError) throw error;
    throw new CodexChildError("unsafe-binary");
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    if (globalThis.process.platform === "win32") {
      globalThis.process.kill(pid, signal);
    } else {
      globalThis.process.kill(-pid, signal);
    }
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw new CodexChildError("lifecycle");
  }
}

async function terminateGroup(pid: number, graceMs: number): Promise<boolean> {
  if (!signalGroup(pid, "SIGTERM")) return false;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await Bun.sleep(Math.min(10, Math.max(1, deadline - Date.now())));
    if (!signalGroup(pid, 0)) return true;
  }
  signalGroup(pid, "SIGKILL");
  await Bun.sleep(10);
  return true;
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
      if (done) break;
      const nextLength = length + value.byteLength;
      if (nextLength > limit) {
        stop(failure);
        break;
      }
      length = nextLength;
      chunks.push(value);
    }
  } catch {
    if (!signal.aborted) stop("stream");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return concatenate(chunks, length);
}

async function runIsolatedCodex(
  codexBinary: string,
  argsFactory: ArgumentsFactory,
  limits: CommandLimits,
): Promise<CommandResult> {
  await validateCodexBinary(codexBinary);
  const home = await isolatedHome();
  try {
    const args =
      typeof argsFactory === "function" ? await argsFactory(home) : argsFactory;
    let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      child = Bun.spawn([codexBinary, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: commandEnvironment(home),
        detached: true,
      });
    } catch {
      throw new CodexChildError("spawn");
    }

    const controller = new AbortController();
    let failure: ChildFailure | undefined;
    let cleanupFailed = false;
    let cleanup: Promise<boolean> | undefined;
    const cleanGroup = (): Promise<boolean> => {
      cleanup ??= terminateGroup(child.pid, limits.terminationGraceMs).catch(
        () => {
          cleanupFailed = true;
          return false;
        },
      );
      return cleanup;
    };
    const stop = (reason: ChildFailure): void => {
      failure ??= reason;
      controller.abort();
      cleanGroup().catch(() => undefined);
    };
    const timer = setTimeout(() => stop("timeout"), limits.timeoutMs);
    try {
      const exited = child.exited.then(async (exitCode) => {
        if (await cleanGroup()) controller.abort();
        return exitCode;
      });
      const [stdout, , exitCode] = await Promise.all([
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
        exited,
      ]);
      await cleanGroup();
      if (failure !== undefined) throw new CodexChildError(failure);
      if (cleanupFailed) throw new CodexChildError("lifecycle");
      return { stdout, exitCode };
    } finally {
      clearTimeout(timer);
      controller.abort();
      await cleanGroup();
      await child.exited.catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof CodexChildError) throw error;
    throw new CodexChildError("lifecycle");
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {
      throw new CodexChildError("lifecycle");
    });
  }
}

function parseJsonOutput(
  output: Uint8Array,
  failure: "invalid-bundled-json" | "invalid-preflight-json",
): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(output));
  } catch {
    throw new CodexChildError(failure);
  }
}

export async function clientVersion(
  codexBinary: string,
  limits: CommandLimits,
): Promise<string> {
  const result = await runIsolatedCodex(codexBinary, ["--version"], {
    ...limits,
    maxStdoutBytes: Math.min(limits.maxStdoutBytes, 1024),
  });
  if (result.exitCode !== 0) throw new CodexChildError("version-exit");
  const match = new TextDecoder().decode(result.stdout).match(SEMANTIC_VERSION);
  const version = match?.[1];
  if (version === undefined) throw new CodexChildError("version-format");
  return version;
}

export async function bundledCatalog(
  codexBinary: string,
  limits: CommandLimits,
): Promise<JsonObject> {
  const result = await runIsolatedCodex(
    codexBinary,
    ["debug", "models", "--bundled"],
    limits,
  );
  if (result.exitCode !== 0) throw new CodexChildError("bundled-exit");
  return assertCompleteCatalog(
    parseJsonOutput(result.stdout, "invalid-bundled-json"),
  );
}

export async function preflightCatalog(
  codexBinary: string,
  contents: string,
  limits: CommandLimits,
): Promise<void> {
  const result = await runIsolatedCodex(
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
  );
  if (result.exitCode !== 0) throw new CodexChildError("preflight-exit");
  const loaded = assertCompleteCatalog(
    parseJsonOutput(result.stdout, "invalid-preflight-json"),
  );
  const loadedLuna = (loaded["models"] as JsonObject[]).filter(
    (entry) => entry["slug"] === LUNA_MODEL,
  );
  if (
    loadedLuna.length !== 1 ||
    loadedLuna[0]?.["multi_agent_version"] !== "v2"
  ) {
    throw new Error("catalog preflight did not load Luna V2");
  }
}
