import { mkdir } from "node:fs/promises";
import processRuntime from "node:process";
import type { RunWorkspace } from "@skizzles/scratchspace";
import type {
  ConfigEdit,
  ConfigLayer,
  ConfigReadResponse,
  ConfigRpc,
  ConfigWriteResponse,
  JsonValue,
} from "./rpc-contract.ts";
import { type RpcSupervisor, spawnRpcSupervisor } from "./supervisor.ts";

export type ConfigRpcErrorKind = "conflict" | "protocol" | "transport";

const CONFIG_WRITE_ERROR_CODES = new Set([
  "configLayerReadonly",
  "configVersionConflict",
  "configValidationError",
  "configPathNotFound",
  "configSchemaUnknownKey",
  "userLayerNotFound",
]);
const SAFE_METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_./-]{0,63}$/u;

export class ConfigRpcError extends Error {
  readonly kind: ConfigRpcErrorKind;
  readonly code: string | undefined;

  constructor(
    kind: ConfigRpcErrorKind,
    message: string,
    code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConfigRpcError";
    this.kind = kind;
    this.code = code;
  }
}

export function isConfigVersionConflict(error: unknown): boolean {
  return error instanceof ConfigRpcError && error.kind === "conflict";
}

export function safeConfigWriteError(error: unknown): Error {
  if (isConfigVersionConflict(error)) {
    return new ConfigRpcError(
      "conflict",
      "Codex config version conflict; no config write was committed",
      "configVersionConflict",
    );
  }
  if (error instanceof ConfigRpcError) {
    return error;
  }
  return new ConfigRpcError(
    "transport",
    "Codex config write outcome is ambiguous; pending recovery evidence was retained",
  );
}

export class AppServerRpc implements ConfigRpc {
  private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly supervisor: RpcSupervisor;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  private constructor(supervisor: RpcSupervisor) {
    this.supervisor = supervisor;
    this.process = supervisor.process;
  }

  static async create(
    codexHome: string,
    codexBinary: string,
    workspace: RunWorkspace,
  ): Promise<AppServerRpc> {
    assertAppServerPlatform(processRuntime.platform);
    const processTemp = workspace.path("process-temp", "codex-app-server");
    await mkdir(processTemp, { recursive: true, mode: 0o700 });
    const supervisor = spawnRpcSupervisor([codexBinary, "app-server"], {
      ...Bun.env,
      CODEX_HOME: codexHome,
      TEMP: processTemp,
      TMP: processTemp,
      TMPDIR: processTemp,
    });
    const rpc = new AppServerRpc(supervisor);
    try {
      workspace.registerChild(supervisor.scope);
    } catch (error) {
      await supervisor.scope.forceStop();
      await supervisor.scope.waitForExit();
      throw error;
    }
    void rpc.consumeStdout();
    void rpc.consumeStderr();
    try {
      await supervisor.waitUntilReady();
      await rpc.request("initialize", {
        clientInfo: {
          name: "skizzles_installer",
          title: "Skizzles Installer",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      });
      rpc.send({ method: "initialized" });
      return rpc;
    } catch (error) {
      try {
        await rpc.close();
      } catch (cleanup) {
        throw new ConfigRpcError(
          "transport",
          "Codex app-server cleanup failed after startup failure",
          undefined,
          { cause: new AggregateError([cleanup, error]) },
        );
      }
      throw error;
    }
  }

  async read(): Promise<ConfigReadResponse> {
    return parseConfigReadResponse(
      await this.request("config/read", { includeLayers: true, cwd: null }),
    );
  }

  async batchWrite(params: {
    edits: ConfigEdit[];
    filePath: string;
    expectedVersion: string;
    reloadUserConfig: boolean;
  }): Promise<ConfigWriteResponse> {
    return parseConfigWriteResponse(
      await this.request("config/batchWrite", params),
    );
  }

  async close(): Promise<void> {
    this.process.stdin.end();
    if (!(await this.supervisor.waitForToolExit(2000))) {
      await this.supervisor.scope.requestStop();
      await Bun.sleep(100);
    }
    await this.supervisor.scope.forceStop();
    await this.supervisor.scope.waitForExit();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ConfigRpcError(
            "transport",
            `Codex app-server request timed out (${safeMethodName(method)})`,
          ),
        );
      }, 15_000);
      this.pending.set(id, { resolve: resolvePromise, reject, timeout });
      this.send({ method, id, params });
    });
  }

  private send(message: object): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
    this.process.stdin.flush();
  }

  private async consumeStdout(): Promise<void> {
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        this.receive(line);
      }
    }
    const error = new ConfigRpcError(
      "transport",
      "Codex app-server closed unexpectedly",
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private receive(line: string): void {
    if (!line.trim()) {
      return;
    }
    let value: unknown;
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

  private async consumeStderr(): Promise<void> {
    const reader = this.process.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      decoder.decode(value, { stream: true });
    }
  }
}

function assertAppServerPlatform(platform: NodeJS.Platform): void {
  if (platform === "win32") {
    throw new ConfigRpcError(
      "transport",
      "Codex app-server process scopes require Windows Job Object support",
    );
  }
}

function classifyProtocolError(error: {
  message?: string;
  data?: unknown;
  code?: unknown;
}): ConfigRpcError {
  const safeCode = configWriteErrorCode(error.data);
  if (safeCode === "configVersionConflict") {
    return new ConfigRpcError(
      "conflict",
      "Codex config version conflict; no config write was committed",
      "configVersionConflict",
    );
  }
  return new ConfigRpcError(
    "protocol",
    safeCode
      ? `Codex app-server rejected the request (${safeCode})`
      : "Codex app-server rejected the request",
    safeCode,
  );
}

function configWriteErrorCode(data: unknown): string | undefined {
  if (!isPlainObject(data)) {
    return;
  }
  const value = data["config_write_error_code"];
  return typeof value === "string" && CONFIG_WRITE_ERROR_CODES.has(value)
    ? value
    : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseConfigReadResponse(value: unknown): ConfigReadResponse {
  if (!isPlainObject(value)) {
    throw invalidConfigResponse();
  }
  const layersValue = value["layers"];
  if (layersValue !== null && !Array.isArray(layersValue)) {
    throw invalidConfigResponse();
  }
  const layers =
    layersValue === null ? null : layersValue.map(parseConfigLayerResponse);
  const configValue = value["config"];
  if (configValue === undefined) {
    return { layers };
  }
  if (!isJsonValue(configValue)) {
    throw invalidConfigResponse();
  }
  return { config: configValue, layers };
}

function parseConfigLayerResponse(value: unknown): ConfigLayer {
  if (!(isPlainObject(value) && isPlainObject(value["name"]))) {
    throw invalidConfigResponse();
  }
  const nameValue = value["name"];
  const type = nameValue["type"];
  const file = nameValue["file"];
  const profile = nameValue["profile"];
  const version = value["version"];
  const config = value["config"];
  if (
    typeof type !== "string" ||
    (file !== undefined && typeof file !== "string") ||
    (profile !== undefined &&
      profile !== null &&
      typeof profile !== "string") ||
    typeof version !== "string" ||
    !isJsonValue(config)
  ) {
    throw invalidConfigResponse();
  }
  const name: ConfigLayer["name"] = { type };
  if (typeof file === "string") {
    name.file = file;
  }
  if (profile === null || typeof profile === "string") {
    name.profile = profile;
  }
  return { name, version, config };
}

function parseConfigWriteResponse(value: unknown): ConfigWriteResponse {
  if (
    !isPlainObject(value) ||
    typeof value["status"] !== "string" ||
    typeof value["version"] !== "string" ||
    typeof value["filePath"] !== "string"
  ) {
    throw invalidConfigResponse();
  }
  return {
    status: value["status"],
    version: value["version"],
    filePath: value["filePath"],
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
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

function invalidConfigResponse(): ConfigRpcError {
  return new ConfigRpcError(
    "protocol",
    "Codex app-server returned an invalid config response",
  );
}

function safeMethodName(method: string): string {
  return SAFE_METHOD_PATTERN.test(method) ? method : "unknown method";
}

export { assertAppServerPlatform };
