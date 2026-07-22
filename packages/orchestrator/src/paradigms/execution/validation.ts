import { type Digest, digestValue } from "../../digest.ts";
import { snapshotArray, snapshotRecord } from "../../engineering/snapshot.ts";
import type {
  ApplyPatchCommand,
  CodeActSandboxRequest,
  ExecutionObservation,
  LocateSymbolCommand,
  LocateTextCommand,
  StableCommandRequest,
  VerifyTestsCommand,
} from "./contract.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const maximumTextBytes = 65_536;

export function validIdentifier(
  value: unknown,
  maximum = 512,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.normalize("NFC")
  );
}

export function validDigest(value: unknown): value is Digest {
  return typeof value === "string" && digestPattern.test(value);
}

export function snapshotCommand(
  value: unknown,
): StableCommandRequest | undefined {
  const discriminator = snapshotRecord(
    value,
    ["command"],
    ["root", "symbol", "query", "patchDigest", "paths", "testIds"],
  );
  if (discriminator === undefined) return;
  if (discriminator["command"] === "locate.symbol") {
    const request = snapshotRecord(value, ["command", "root", "symbol"]);
    if (
      request === undefined ||
      !validRelativePath(request["root"]) ||
      !validIdentifier(request["symbol"], 4096)
    )
      return;
    return Object.freeze({
      command: "locate.symbol" as const,
      root: request["root"],
      symbol: request["symbol"],
    }) satisfies LocateSymbolCommand;
  }
  if (discriminator["command"] === "locate.text") {
    const request = snapshotRecord(value, ["command", "root", "query"]);
    if (
      request === undefined ||
      !validRelativePath(request["root"]) ||
      !validIdentifier(request["query"], 4096)
    )
      return;
    return Object.freeze({
      command: "locate.text" as const,
      root: request["root"],
      query: request["query"],
    }) satisfies LocateTextCommand;
  }
  if (discriminator["command"] === "patch.apply") {
    const request = snapshotRecord(value, ["command", "patchDigest", "paths"]);
    const paths = snapshotStringList(request?.["paths"], 256);
    if (
      request === undefined ||
      !validDigest(request["patchDigest"]) ||
      paths === undefined ||
      paths.length === 0 ||
      paths.some((path) => !validRelativePath(path))
    )
      return;
    return Object.freeze({
      command: "patch.apply" as const,
      patchDigest: request["patchDigest"],
      paths,
    }) satisfies ApplyPatchCommand;
  }
  if (discriminator["command"] === "verify.tests") {
    const request = snapshotRecord(value, ["command", "testIds"]);
    const testIds = snapshotStringList(request?.["testIds"], 256);
    if (
      request === undefined ||
      testIds === undefined ||
      testIds.length === 0 ||
      testIds.some((testId) => !validIdentifier(testId, 1024))
    )
      return;
    return Object.freeze({
      command: "verify.tests" as const,
      testIds,
    }) satisfies VerifyTestsCommand;
  }
  return undefined;
}

export function snapshotSandboxRequest(
  value: unknown,
): CodeActSandboxRequest | undefined {
  const request = snapshotRecord(value, [
    "executionId",
    "language",
    "source",
    "workingDirectory",
    "timeoutMilliseconds",
  ]);
  if (
    request === undefined ||
    !validIdentifier(request["executionId"]) ||
    request["language"] !== "typescript" ||
    !validIdentifier(request["source"], maximumTextBytes) ||
    !validRelativePath(request["workingDirectory"]) ||
    !positiveSafeInteger(request["timeoutMilliseconds"]) ||
    request["timeoutMilliseconds"] > 300_000
  )
    return;
  return Object.freeze({
    executionId: request["executionId"],
    language: "typescript" as const,
    source: request["source"],
    workingDirectory: request["workingDirectory"],
    timeoutMilliseconds: request["timeoutMilliseconds"],
  });
}

export function snapshotObservation(
  value: unknown,
): ExecutionObservation | undefined {
  const output = snapshotRecord(value, ["stdout", "stderr", "exitCode"]);
  if (
    output === undefined ||
    typeof output["stdout"] !== "string" ||
    typeof output["stderr"] !== "string" ||
    utf8Bytes(output["stdout"]) > maximumTextBytes ||
    utf8Bytes(output["stderr"]) > maximumTextBytes ||
    !nonnegativeSafeInteger(output["exitCode"]) ||
    output["exitCode"] > 255
  )
    return;
  const stdoutBytes = utf8Bytes(output["stdout"]);
  const stderrBytes = utf8Bytes(output["stderr"]);
  const material = Object.freeze({
    stdout: output["stdout"],
    stderr: output["stderr"],
    exitCode: output["exitCode"],
    stdoutBytes,
    stderrBytes,
  });
  return Object.freeze({
    ...material,
    observationDigest: digestValue(material),
  });
}

function snapshotStringList(
  value: unknown,
  maximum: number,
): readonly string[] | undefined {
  const values = snapshotArray(value, maximum);
  if (values === undefined || values.some((item) => typeof item !== "string"))
    return;
  return Object.freeze(values.map((item) => String(item)));
}

function validRelativePath(value: unknown): value is string {
  if (!validIdentifier(value, 4096)) return false;
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0"))
    return false;
  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function positiveSafeInteger(value: unknown): value is number {
  return nonnegativeSafeInteger(value) && value > 0;
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
