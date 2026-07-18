import { randomUUID } from "node:crypto";
import process from "node:process";
import { PackagingError } from "./contract.ts";

const OWNER_FILE = "owner.json";
const JOURNAL_FILE = "journal.json";
const PROTOCOL_VERSION = 1;
const PRIVATE_JSON_LIMIT = 16_384;
const PRIVATE_JSON_DEPTH_LIMIT = 32;
const DECIMAL_IDENTITY_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface LockOwner {
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
    Object.keys(record).length !== 4 ||
    record["version"] !== PROTOCOL_VERSION ||
    !Number.isSafeInteger(record["pid"]) ||
    typeof record["processStartIdentity"] !== "string" ||
    typeof record["token"] !== "string" ||
    !UUID_PATTERN.test(record["token"])
  ) {
    throw new Error("invalid owner");
  }
  return {
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

function processIdentity(pid: number): string | undefined {
  const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
    env: { PATH: process.env["PATH"] ?? "", LC_ALL: "C" },
    stderr: "ignore",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return;
  const value = result.stdout.toString().trim();
  return value === "" ? undefined : value;
}

function ownerIsActive(owner: LockOwner): boolean {
  return processIdentity(owner.pid) === owner.processStartIdentity;
}

function currentOwner(): LockOwner {
  const processStartIdentity = processIdentity(process.pid);
  if (processStartIdentity === undefined) {
    throw new PackagingError("Plugin staging could not identify lock owner.");
  }
  return {
    version: PROTOCOL_VERSION,
    pid: process.pid,
    processStartIdentity,
    token: randomUUID(),
  };
}

function temporaryName(name: string, token: string): string {
  return `.${name}.${token}.tmp`;
}

export type { LockOwner, SerializedIdentity, TransactionJournal };
export {
  currentOwner,
  deserialize,
  JOURNAL_FILE,
  matches,
  OWNER_FILE,
  ownerIsActive,
  PROTOCOL_VERSION,
  parseJournal,
  parseOwner,
  parsePrivateJson,
  serialized,
  temporaryName,
  UUID_PATTERN,
};
