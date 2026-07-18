import { join } from "node:path";
import { validateText } from "../assets/manifest.ts";
import {
  assertKeys,
  numberValue,
  record,
  stringValue,
} from "../json-contract.ts";
import type { TransactionOperation } from "../lifecycle-contract.ts";
import {
  isTransactionOperation,
  PromptLayerError,
  TRANSACTION_JOURNAL_PATH,
  TRANSACTION_PATHS,
} from "../lifecycle-contract.ts";
import {
  assertContainedPath,
  errorMessage,
  readRequiredFile,
} from "../repository-boundary.ts";

const TRANSACTION_VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/;

export interface TransactionEntry {
  path: string;
  oldPath: string;
  oldSha256: string;
  oldBytes: number;
  newPath: string;
  newSha256: string;
  newBytes: number;
}

export interface TransactionJournal {
  version: number;
  operation: TransactionOperation;
  state: "prepared" | "committed";
  entries: TransactionEntry[];
}

export async function readTransactionJournal(
  root: string,
): Promise<TransactionJournal> {
  await assertContainedPath(root, TRANSACTION_JOURNAL_PATH, true);
  const bytes = await readRequiredFile(
    join(root, TRANSACTION_JOURNAL_PATH),
    "prompt transaction journal",
  );
  validateText(bytes, "prompt transaction journal");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new PromptLayerError(
      `Prompt transaction journal is invalid; refusing unsafe recovery: ${errorMessage(error)}`,
    );
  }
  const object = record(parsed, "prompt transaction journal");
  assertKeys(
    object,
    ["version", "operation", "state", "entries"],
    "transaction journal",
  );
  const version = numberValue(object["version"], "transaction version");
  const operation = stringValue(object["operation"], "transaction operation");
  const state = stringValue(object["state"], "transaction state");
  const rawEntries = object["entries"];
  if (
    version !== TRANSACTION_VERSION ||
    !isTransactionOperation(operation) ||
    (state !== "prepared" && state !== "committed") ||
    !Array.isArray(rawEntries) ||
    rawEntries.length === 0
  ) {
    throw new PromptLayerError(
      "Prompt transaction journal has an unsupported shape; refusing unsafe recovery.",
    );
  }
  const entries = rawEntries.map((value, index) =>
    transactionEntryValue(value, index),
  );
  validateTransactionPaths(
    operation,
    entries.map((entry) => entry.path),
  );
  return { version, operation, state, entries };
}

function transactionEntryValue(
  value: unknown,
  index: number,
): TransactionEntry {
  const object = record(value, `transaction entry ${index}`);
  assertKeys(
    object,
    [
      "path",
      "oldPath",
      "oldSha256",
      "oldBytes",
      "newPath",
      "newSha256",
      "newBytes",
    ],
    `transaction entry ${index}`,
  );
  const entry = {
    path: stringValue(object["path"], "transaction target path"),
    oldPath: stringValue(object["oldPath"], "transaction backup path"),
    oldSha256: stringValue(object["oldSha256"], "transaction old digest"),
    oldBytes: numberValue(object["oldBytes"], "transaction old bytes"),
    newPath: stringValue(object["newPath"], "transaction staged path"),
    newSha256: stringValue(object["newSha256"], "transaction new digest"),
    newBytes: numberValue(object["newBytes"], "transaction new bytes"),
  };
  if (
    entry.oldPath !== `old-${index}` ||
    entry.newPath !== `new-${index}` ||
    !SHA256.test(entry.oldSha256) ||
    !SHA256.test(entry.newSha256) ||
    !Number.isSafeInteger(entry.oldBytes) ||
    !Number.isSafeInteger(entry.newBytes) ||
    entry.oldBytes < 1 ||
    entry.newBytes < 1
  ) {
    throw new PromptLayerError(
      "Prompt transaction entry is invalid; refusing unsafe recovery.",
    );
  }
  return entry;
}

export function validateTransactionPaths(
  operation: TransactionOperation,
  paths: string[],
): void {
  const expected = TRANSACTION_PATHS[operation];
  if (
    paths.length !== expected.length ||
    paths.some((path, index) => path !== expected[index])
  ) {
    throw new PromptLayerError(
      `Prompt ${operation} transaction does not match its exact ordered write set.`,
    );
  }
}

export function transactionJournalBytes(journal: TransactionJournal): Buffer {
  return Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
}
