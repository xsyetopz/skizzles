import { Database } from "bun:sqlite";
import { isAbsolute, normalize } from "node:path";
import { digestCanonical } from "./canonical.ts";
import type {
  ReflexionFailureRecord,
  ReflexionLocalDatabaseCreationResult,
  ReflexionMemoryPersistenceAuthority,
  ReflexionMemoryRecordSource,
} from "./contract.ts";
import {
  createReflexionMemoryRecorder,
  createReflexionPersistenceReceipt,
} from "./persistence.ts";
import { createReflexionMemoryQuery } from "./query.ts";
import { parseReflexionFailureRecord } from "./record.ts";

const createTable = `
CREATE TABLE IF NOT EXISTS reflexion_failures (
  record_digest TEXT PRIMARY KEY NOT NULL,
  record_json TEXT NOT NULL
) STRICT
`;
const insertRecord =
  "INSERT OR IGNORE INTO reflexion_failures(record_digest, record_json) VALUES (?, ?)";
const selectRecords =
  "SELECT record_json FROM reflexion_failures ORDER BY record_digest";
const selectDigests =
  "SELECT record_digest FROM reflexion_failures ORDER BY record_digest";
const maximumDatabasePathLength = 4096;

export function createReflexionLocalDatabase(
  input: unknown,
): ReflexionLocalDatabaseCreationResult {
  const databasePath = parseDatabasePath(input);
  if (databasePath === undefined) {
    return Object.freeze({
      status: "rejected" as const,
      code: "INVALID_LOCAL_DATABASE_CONFIG" as const,
    });
  }
  try {
    const database = new Database(databasePath, { create: true, strict: true });
    try {
      database.exec(createTable);
    } finally {
      database.close();
    }
  } catch {
    return Object.freeze({
      status: "rejected" as const,
      code: "LOCAL_DATABASE_UNAVAILABLE" as const,
    });
  }
  const source: ReflexionMemoryRecordSource = Object.freeze({
    readFailureRecords: () => Promise.resolve(readRecords(databasePath)),
  });
  const persistence: ReflexionMemoryPersistenceAuthority = Object.freeze({
    storeFailureRecordIfAbsent: (record: ReflexionFailureRecord) =>
      Promise.resolve(storeRecord(databasePath, record)),
  });
  return Object.freeze({
    status: "created" as const,
    query: createReflexionMemoryQuery(source),
    recorder: createReflexionMemoryRecorder(persistence),
  });
}

function readRecords(databasePath: string): readonly ReflexionFailureRecord[] {
  const database = new Database(databasePath, {
    readonly: true,
    strict: true,
  });
  try {
    const rows: unknown = database.query(selectRecords).all();
    if (!Array.isArray(rows)) {
      throw new Error("invalid local database rows");
    }
    const records: ReflexionFailureRecord[] = [];
    for (const row of rows) {
      const json = dataProperty(row, "record_json");
      if (typeof json !== "string") {
        throw new Error("invalid local database row");
      }
      const record = parseReflexionFailureRecord(freezeJson(JSON.parse(json)));
      if (record === undefined) {
        throw new Error("invalid local database record");
      }
      records.push(record);
    }
    return Object.freeze(records);
  } finally {
    database.close();
  }
}

function storeRecord(databasePath: string, record: ReflexionFailureRecord) {
  const database = new Database(databasePath, { strict: true });
  try {
    const result = database
      .query(insertRecord)
      .run(record.recordDigest, JSON.stringify(record));
    const rows: unknown = database.query(selectDigests).all();
    if (!Array.isArray(rows)) {
      throw new Error("invalid local database revision");
    }
    const digests = rows.map((row) => dataProperty(row, "record_digest"));
    if (digests.some((digest) => typeof digest !== "string")) {
      throw new Error("invalid local database digest");
    }
    return createReflexionPersistenceReceipt({
      disposition: result.changes === 1 ? "stored" : "duplicate",
      recordDigest: record.recordDigest,
      persistenceRevisionDigest: digestCanonical({ digests }),
    });
  } finally {
    database.close();
  }
}

function parseDatabasePath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !Object.isFrozen(input)) {
    return;
  }
  try {
    const keys = Reflect.ownKeys(input);
    const descriptor = Object.getOwnPropertyDescriptor(input, "databasePath");
    if (
      keys.length !== 1 ||
      keys[0] !== "databasePath" ||
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length === 0 ||
      descriptor.value.length > maximumDatabasePathLength ||
      descriptor.value.includes("\0") ||
      !descriptor.value.endsWith(".sqlite3") ||
      !isAbsolute(descriptor.value) ||
      normalize(descriptor.value) !== descriptor.value
    ) {
      return;
    }
    return descriptor.value;
  } catch {
    return;
  }
}

function dataProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeJson));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = freezeJson(child);
  }
  return Object.freeze(output);
}
