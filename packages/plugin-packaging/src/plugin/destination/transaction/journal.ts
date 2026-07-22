import { randomUUID } from "node:crypto";
import process from "node:process";
import { PackagingError } from "../../contract.ts";

const OWNER_FILE = "owner.json";
const JOURNAL_FILE = "journal.json";
const PROTOCOL_VERSION = 2;
const PRIVATE_JSON_LIMIT = 16_384;
const PRIVATE_JSON_DEPTH_LIMIT = 32;
const OWNER_IDENTIFICATION_RETRY_MS = 5;
const OWNER_IDENTIFICATION_TIMEOUT_MS = 500;
const DECIMAL_IDENTITY_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface LockOwner {
  controllerPid: number;
  controllerStartIdentity: string;
  pid: number;
  processStartIdentity: string;
  token: string;
  version: number;
}

interface SerializedIdentity {
  dev: string;
  ino: string;
}

type JournalState = "active" | "committed" | "cleanup-pending";

interface TransactionJournal {
  backup?: SerializedIdentity;
  original: { identity?: SerializedIdentity; present: boolean };
  stage?: SerializedIdentity;
  state: JournalState;
  version: number;
}

function parsePrivateJson(text: string): unknown {
  if (text.length > PRIVATE_JSON_LIMIT)
    throw new Error("private JSON too large");
  const objects: Array<Set<string> | undefined> = [];
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}[\]]/gu)) {
    const token = match[0];
    if (token === "{" || token === "[") {
      if (objects.length >= PRIVATE_JSON_DEPTH_LIMIT) {
        throw new Error("private JSON too deep");
      }
      objects.push(token === "{" ? new Set<string>() : undefined);
    } else if (token === "}" || token === "]") {
      objects.pop();
    } else if (/^\s*:/u.test(text.slice((match.index ?? 0) + token.length))) {
      const keys = objects.at(-1);
      const key: unknown = JSON.parse(token);
      if (keys?.has(String(key))) throw new Error("duplicate private JSON key");
      keys?.add(String(key));
    }
  }
  return JSON.parse(text);
}

function parseOwner(value: unknown): LockOwner {
  const record = requiredRecord(value);
  if (
    Object.keys(record).length !== 6 ||
    record["version"] !== PROTOCOL_VERSION ||
    !Number.isSafeInteger(record["controllerPid"]) ||
    typeof record["controllerStartIdentity"] !== "string" ||
    !Number.isSafeInteger(record["pid"]) ||
    typeof record["processStartIdentity"] !== "string" ||
    typeof record["token"] !== "string" ||
    !UUID_PATTERN.test(record["token"])
  ) {
    throw new Error("invalid owner");
  }
  return {
    controllerPid: Number(record["controllerPid"]),
    controllerStartIdentity: String(record["controllerStartIdentity"]),
    version: PROTOCOL_VERSION,
    pid: Number(record["pid"]),
    processStartIdentity: record["processStartIdentity"],
    token: record["token"],
  };
}

function parseJournal(value: unknown): TransactionJournal {
  const record = requiredRecord(value);
  const original = requiredRecord(record["original"]);
  const state = record["state"];
  if (
    Object.keys(record).length !==
      3 + Number("backup" in record) + Number("stage" in record) ||
    Object.keys(original).length !== 1 + Number("identity" in original) ||
    record["version"] !== PROTOCOL_VERSION ||
    typeof original["present"] !== "boolean" ||
    !isJournalState(state)
  ) {
    throw new Error("invalid journal");
  }
  const journal: TransactionJournal = {
    version: PROTOCOL_VERSION,
    state,
    original: { present: original["present"] },
  };
  const prior = parseIdentity(original["identity"]);
  const stage = parseIdentity(record["stage"]);
  const backup = parseIdentity(record["backup"]);
  if (prior !== undefined) journal.original.identity = prior;
  if (stage !== undefined) journal.stage = stage;
  if (backup !== undefined) journal.backup = backup;
  return journal;
}

function parseIdentity(value: unknown): SerializedIdentity | undefined {
  if (value === undefined) return;
  const record = requiredRecord(value);
  if (
    Object.keys(record).length !== 2 ||
    typeof record["dev"] !== "string" ||
    typeof record["ino"] !== "string" ||
    !DECIMAL_IDENTITY_PATTERN.test(record["dev"]) ||
    !DECIMAL_IDENTITY_PATTERN.test(record["ino"])
  ) {
    throw new Error("invalid identity");
  }
  return { dev: record["dev"], ino: record["ino"] };
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid record");
  }
  return Object.fromEntries(Object.entries(value));
}

function isJournalState(value: unknown): value is JournalState {
  return (
    typeof value === "string" &&
    ["active", "committed", "cleanup-pending"].includes(value)
  );
}

function serialized(value: { dev: bigint; ino: bigint }): SerializedIdentity {
  return { dev: String(value.dev), ino: String(value.ino) };
}

function deserialize(value: SerializedIdentity | undefined) {
  if (value === undefined) return;
  return { dev: BigInt(value.dev), ino: BigInt(value.ino) };
}

function matches(
  actual: { dev: bigint; ino: bigint } | undefined,
  expected: SerializedIdentity | undefined,
): boolean {
  return (
    actual !== undefined &&
    expected !== undefined &&
    String(actual.dev) === expected.dev &&
    String(actual.ino) === expected.ino
  );
}

type ProcessIdentity =
  | { state: "alive"; value: string }
  | { state: "dead" }
  | { state: "unknown" };

function processIdentity(pid: number): ProcessIdentity {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return { state: "dead" };
    }
    return { state: "unknown" };
  }
  const result = Bun.spawnSync(
    ["/bin/ps", "-o", "state=", "-o", "lstart=", "-p", String(pid)],
    {
      env: { PATH: process.env["PATH"] ?? "", LC_ALL: "C" },
      stderr: "ignore",
      stdout: "pipe",
    },
  );
  if (result.exitCode !== 0) return { state: "unknown" };
  const value = result.stdout.toString().trim();
  const separator = value.indexOf(" ");
  if (separator < 0) return { state: "unknown" };
  if (value.slice(0, separator).includes("Z")) return { state: "dead" };
  const identity = value.slice(separator + 1).trim();
  return identity === ""
    ? { state: "unknown" }
    : { state: "alive", value: identity };
}

function ownerIsActive(owner: LockOwner): boolean {
  const identity = processIdentity(owner.pid);
  return (
    identity.state === "unknown" ||
    (identity.state === "alive" &&
      identity.value === owner.processStartIdentity)
  );
}

async function ownerRemainsActive(
  owner: LockOwner,
  attempts = 10,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!ownerIsActive(owner)) return false;
    await Bun.sleep(10);
  }
  return ownerIsActive(owner);
}

async function ownerForProcess(pid: number): Promise<LockOwner> {
  const deadline = performance.now() + OWNER_IDENTIFICATION_TIMEOUT_MS;
  while (true) {
    const identity = processIdentity(pid);
    const controller = processIdentity(process.pid);
    if (identity.state === "alive" && controller.state === "alive") {
      return {
        controllerPid: process.pid,
        controllerStartIdentity: controller.value,
        version: PROTOCOL_VERSION,
        pid,
        processStartIdentity: identity.value,
        token: randomUUID(),
      };
    }
    if (
      identity.state === "dead" ||
      controller.state === "dead" ||
      performance.now() >= deadline
    ) {
      throw new PackagingError("Plugin staging could not identify lock owner.");
    }
    await Bun.sleep(OWNER_IDENTIFICATION_RETRY_MS);
  }
}

function ownerControllerIsDead(owner: LockOwner): boolean {
  const identity = processIdentity(owner.controllerPid);
  return (
    identity.state === "dead" ||
    (identity.state === "alive" &&
      identity.value !== owner.controllerStartIdentity)
  );
}

function temporaryName(name: string, token: string): string {
  return `.${name}.${token}.tmp`;
}

export type { LockOwner, SerializedIdentity, TransactionJournal };
export {
  deserialize,
  JOURNAL_FILE,
  matches,
  OWNER_FILE,
  ownerControllerIsDead,
  ownerForProcess,
  ownerIsActive,
  ownerRemainsActive,
  PROTOCOL_VERSION,
  parseJournal,
  parseOwner,
  parsePrivateJson,
  serialized,
  temporaryName,
  UUID_PATTERN,
};
