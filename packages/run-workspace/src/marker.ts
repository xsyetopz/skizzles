import { join } from "node:path";
import { RunWorkspaceError } from "./errors.ts";
import type { FileIdentity, ProcessIdentity, Runtime } from "./platform.ts";
import { markerName } from "./platform.ts";
import { inspectPrivateDirectory } from "./safety.ts";

export const markerSchema = 1;
const decimalPattern = /^\d+$/u;
const runIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maximumReasonLength = 256;
const maximumMarkerBytes = 16 * 1024;

export interface Marker {
  readonly schema: 1;
  readonly runId: string;
  readonly root: string;
  readonly rootIdentity: FileIdentity;
  readonly ownerPid: number;
  readonly ownerIdentity: ProcessIdentity;
  readonly createdAtMs: number;
  readonly state: "open" | "preserved" | "cleanup-failed" | "reaping";
  readonly reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return Object.keys(record).every((key) => allowed.has(key));
}

function parseFileIdentity(value: unknown): FileIdentity | undefined {
  if (!isRecord(value)) {
    return;
  }
  if (!exactKeys(value, ["device", "inode", "birthtimeNs"], [])) {
    return;
  }
  const { device, inode, birthtimeNs } = value;
  if (
    typeof device !== "string" ||
    typeof inode !== "string" ||
    typeof birthtimeNs !== "string" ||
    !decimalPattern.test(device) ||
    !decimalPattern.test(inode) ||
    !decimalPattern.test(birthtimeNs)
  ) {
    return;
  }
  return { device, inode, birthtimeNs };
}

function parseProcessIdentity(value: unknown): ProcessIdentity | undefined {
  if (!isRecord(value)) {
    return;
  }
  if (!exactKeys(value, ["platform", "token"], [])) {
    return;
  }
  const { platform, token } = value;
  if (
    (platform !== "linux" && platform !== "darwin" && platform !== "win32") ||
    typeof token !== "string" ||
    token.length === 0
  ) {
    return;
  }
  return { platform, token };
}

export function parseMarker(contents: string): Marker | undefined {
  let value: unknown;
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
    "state",
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
  if (
    schema !== markerSchema ||
    typeof runId !== "string" ||
    !runIdPattern.test(runId) ||
    typeof root !== "string" ||
    root.length === 0 ||
    rootIdentity === undefined ||
    !Number.isSafeInteger(ownerPid) ||
    typeof ownerPid !== "number" ||
    ownerPid <= 0 ||
    ownerIdentity === undefined ||
    !Number.isSafeInteger(createdAtMs) ||
    typeof createdAtMs !== "number" ||
    createdAtMs < 0 ||
    (state !== "open" &&
      state !== "preserved" &&
      state !== "cleanup-failed" &&
      state !== "reaping") ||
    (reason !== undefined && typeof reason !== "string")
  ) {
    return;
  }
  const marker: Marker = {
    schema: markerSchema,
    runId,
    root,
    rootIdentity,
    ownerPid,
    ownerIdentity,
    createdAtMs,
    state,
    ...(typeof reason === "string" ? { reason } : {}),
  };
  return serializeMarker(marker) === contents ? marker : undefined;
}

export function sameFileIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

export function sameProcessIdentity(
  left: ProcessIdentity,
  right: ProcessIdentity,
): boolean {
  return left.platform === right.platform && left.token === right.token;
}

export function markerPath(root: string): string {
  return join(root, markerName);
}

export function serializeMarker(marker: Marker): string {
  return `${JSON.stringify(marker, undefined, 2)}\n`;
}

export async function readMarker(
  runtime: Runtime,
  root: string,
): Promise<Marker | undefined> {
  try {
    const contents = await runtime.readSecureFile(
      markerPath(root),
      maximumMarkerBytes,
    );
    return contents === undefined ? undefined : parseMarker(contents);
  } catch {
    return undefined;
  }
}

export async function verifyMarkedRoot(
  runtime: Runtime,
  root: string,
  expectedRunId?: string,
  transitionalRoot?: string,
): Promise<Marker> {
  const [inspected, marker] = await Promise.all([
    inspectPrivateDirectory(runtime, root),
    readMarker(runtime, root),
  ]);
  if (inspected === undefined || marker === undefined) {
    throw new RunWorkspaceError(
      "UNVERIFIED_ROOT",
      "Refusing to clean an unverified run root",
    );
  }
  const acceptedMarkerPath =
    marker.root === root || marker.root === transitionalRoot;
  if (
    !(
      acceptedMarkerPath &&
      sameFileIdentity(inspected.identity, marker.rootIdentity)
    ) ||
    (expectedRunId !== undefined && marker.runId !== expectedRunId)
  ) {
    throw new RunWorkspaceError(
      "ROOT_IDENTITY_CHANGED",
      "Run workspace identity changed",
    );
  }
  return marker;
}

export function safeReason(reason: string): string {
  const sanitized = [...reason]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("");
  return sanitized.trim().slice(0, maximumReasonLength);
}
