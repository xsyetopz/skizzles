import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256, validateText } from "../content-integrity.ts";
import type {
  TransactionFault,
  TransactionOperation,
  WriteEntry,
} from "../lifecycle-contract.ts";
import {
  PromptLayerError,
  SimulatedTransactionCrash,
  TRANSACTION_JOURNAL_PATH,
  TRANSACTION_PATH,
} from "../lifecycle-contract.ts";
import {
  assertCanonicalContainment,
  assertContainedPath,
  errorMessage,
  pathExists,
  readRequiredFile,
  removeTreeDurably,
  syncDirectory,
  writeAtomically,
  writeDurably,
} from "../repository-boundary.ts";
import type { TransactionEntry, TransactionJournal } from "./journal.ts";
import {
  readTransactionJournal,
  TRANSACTION_VERSION,
  transactionJournalBytes,
  validateTransactionPaths,
} from "./journal.ts";

type TransactionTargetState = "old" | "new" | "both";
export async function commitWriteSet(
  root: string,
  operation: TransactionOperation,
  writes: WriteEntry[],
  fault?: TransactionFault,
): Promise<void> {
  validateWriteSet(operation, writes);
  await assertNoPendingTransaction(root);
  const transactionRoot = join(root, TRANSACTION_PATH);
  await assertCanonicalContainment(root);
  await assertContainedPath(root, TRANSACTION_PATH, false);
  await mkdir(dirname(transactionRoot), { recursive: true });
  await mkdir(transactionRoot);
  await syncDirectory(dirname(transactionRoot));
  let journalWritten = false;
  try {
    const journal = await stageTransaction(
      root,
      transactionRoot,
      operation,
      writes,
    );
    await assertContainedPath(root, TRANSACTION_JOURNAL_PATH, false);
    await writeAtomically(
      join(root, TRANSACTION_JOURNAL_PATH),
      transactionJournalBytes(journal),
    );
    journalWritten = true;
    await promoteTransaction(root, transactionRoot, journal.entries, fault);
    await verifyTransactionTargets(root, journal.entries, "new");
    journal.state = "committed";
    await assertContainedPath(root, TRANSACTION_JOURNAL_PATH, true);
    await writeAtomically(
      join(root, TRANSACTION_JOURNAL_PATH),
      transactionJournalBytes(journal),
    );
    await removeTreeDurably(root, TRANSACTION_PATH);
  } catch (error) {
    await handleTransactionFailure(root, journalWritten, error);
    throw error;
  }
}

async function stageTransaction(
  root: string,
  transactionRoot: string,
  operation: TransactionOperation,
  writes: WriteEntry[],
): Promise<TransactionJournal> {
  const entries: TransactionEntry[] = [];
  for (const [index, write] of writes.entries()) {
    validateText(write.bytes, `transaction target ${write.path}`);
    await assertContainedPath(root, write.path, true);
    const original = await readRequiredFile(
      join(root, write.path),
      `transaction original ${write.path}`,
    );
    const oldPath = `old-${index}`;
    const newPath = `new-${index}`;
    await assertContainedPath(root, `${TRANSACTION_PATH}/${oldPath}`, false);
    await assertContainedPath(root, `${TRANSACTION_PATH}/${newPath}`, false);
    await writeDurably(join(transactionRoot, oldPath), original);
    await writeDurably(join(transactionRoot, newPath), write.bytes);
    entries.push({
      path: write.path,
      oldPath,
      oldSha256: sha256(original),
      oldBytes: original.byteLength,
      newPath,
      newSha256: sha256(write.bytes),
      newBytes: write.bytes.byteLength,
    });
  }
  return {
    version: TRANSACTION_VERSION,
    operation,
    state: "prepared",
    entries,
  };
}

async function promoteTransaction(
  root: string,
  transactionRoot: string,
  entries: TransactionEntry[],
  fault?: TransactionFault,
): Promise<void> {
  for (const [index, entry] of entries.entries()) {
    throwInjectedPromotionFault(fault, index);
    await assertContainedPath(
      root,
      `${TRANSACTION_PATH}/${entry.newPath}`,
      true,
    );
    await assertContainedPath(root, entry.path, true);
    await rename(join(transactionRoot, entry.newPath), join(root, entry.path));
    await syncDirectory(dirname(join(root, entry.path)));
    await syncDirectory(transactionRoot);
  }
}

function throwInjectedPromotionFault(
  fault: TransactionFault | undefined,
  index: number,
): void {
  if (fault?.promotionIndex !== index) {
    return;
  }
  if (fault.simulateCrash === true) {
    throw new SimulatedTransactionCrash(
      `Simulated transaction crash before promotion ${index}.`,
    );
  }
  throw new PromptLayerError(
    `Injected transaction promotion failure at ${index}.`,
  );
}

async function handleTransactionFailure(
  root: string,
  journalWritten: boolean,
  error: unknown,
): Promise<void> {
  if (error instanceof SimulatedTransactionCrash) {
    throw error;
  }
  if (!journalWritten) {
    await removeTreeDurably(root, TRANSACTION_PATH);
    return;
  }
  try {
    await rollbackPreparedTransaction(root);
  } catch (rollbackError) {
    throw new PromptLayerError(
      `Prompt transaction failed and rollback could not complete safely: ${errorMessage(error)}; rollback: ${errorMessage(rollbackError)}`,
    );
  }
}

export async function recoverPendingTransaction(root: string): Promise<void> {
  const transactionRoot = join(root, TRANSACTION_PATH);
  if (!(await pathExists(transactionRoot))) {
    return;
  }
  const journal = await readTransactionJournal(root);
  if (journal.state === "prepared") {
    await rollbackPreparedTransaction(root, journal);
    return;
  }
  const states = await preflightTransactionTargets(root, journal.entries);
  await preflightTransactionNewArtifacts(root, journal.entries, states);
  if (states.some((state) => state === "old")) {
    throw new PromptLayerError(
      "Committed prompt transaction targets are not all in the journaled new state; refusing cleanup.",
    );
  }
  await verifyTransactionTargets(root, journal.entries, "new");
  await removeTreeDurably(root, TRANSACTION_PATH);
}

export async function assertNoPendingTransaction(root: string): Promise<void> {
  if (await pathExists(join(root, TRANSACTION_PATH))) {
    throw new PromptLayerError(
      "A prompt transaction is pending; prompt:check refuses to write or recover it. Run prompt:build to recover safely.",
    );
  }
}

async function rollbackPreparedTransaction(
  root: string,
  supplied?: TransactionJournal,
): Promise<void> {
  const journal = supplied ?? (await readTransactionJournal(root));
  if (journal.state !== "prepared") {
    throw new PromptLayerError(
      "Only a prepared prompt transaction can roll back.",
    );
  }
  const backups = await preflightTransactionBackups(root, journal.entries);
  const states = await preflightTransactionTargets(root, journal.entries);
  await preflightTransactionNewArtifacts(root, journal.entries, states);
  for (const [index, entry] of journal.entries.entries()) {
    if (states[index] === "new") {
      await assertContainedPath(root, entry.path, true);
      const backup = backups[index];
      if (backup === undefined) {
        throw new PromptLayerError(
          "Transaction rollback is missing a validated backup.",
        );
      }
      await writeAtomically(join(root, entry.path), backup);
    }
  }
  await verifyTransactionTargets(root, journal.entries, "old");
  await removeTreeDurably(root, TRANSACTION_PATH);
}

async function preflightTransactionBackups(
  root: string,
  entries: TransactionEntry[],
): Promise<Buffer[]> {
  const backups: Buffer[] = [];
  for (const entry of entries) {
    const backupPath = `${TRANSACTION_PATH}/${entry.oldPath}`;
    await assertContainedPath(root, backupPath, true);
    const original = await readRequiredFile(
      join(root, backupPath),
      `transaction backup ${entry.path}`,
    );
    if (
      original.byteLength !== entry.oldBytes ||
      sha256(original) !== entry.oldSha256
    ) {
      throw new PromptLayerError(
        `Prompt transaction backup for ${entry.path} is invalid; refusing unsafe recovery.`,
      );
    }
    backups.push(original);
  }
  return backups;
}

async function preflightTransactionTargets(
  root: string,
  entries: TransactionEntry[],
): Promise<TransactionTargetState[]> {
  const states: TransactionTargetState[] = [];
  for (const entry of entries) {
    await assertContainedPath(root, entry.path, true);
    const bytes = await readRequiredFile(
      join(root, entry.path),
      `transaction target ${entry.path}`,
    );
    const digest = sha256(bytes);
    const matchesOld =
      bytes.byteLength === entry.oldBytes && digest === entry.oldSha256;
    const matchesNew =
      bytes.byteLength === entry.newBytes && digest === entry.newSha256;
    if (matchesOld && matchesNew) {
      states.push("both");
      continue;
    }
    if (matchesOld) {
      states.push("old");
      continue;
    }
    if (matchesNew) {
      states.push("new");
      continue;
    }
    throw new PromptLayerError(
      `Prompt transaction target ${entry.path} is missing or externally changed; refusing recovery before any write.`,
    );
  }
  return states;
}

async function preflightTransactionNewArtifacts(
  root: string,
  entries: TransactionEntry[],
  states: TransactionTargetState[],
): Promise<void> {
  for (const [index, entry] of entries.entries()) {
    const stagedPath = `${TRANSACTION_PATH}/${entry.newPath}`;
    if (!(await pathExists(join(root, stagedPath)))) {
      if (states[index] === "old") {
        throw new PromptLayerError(
          `Prompt transaction staged content for ${entry.path} is missing before promotion.`,
        );
      }
      continue;
    }
    await assertContainedPath(root, stagedPath, true);
    const staged = await readRequiredFile(
      join(root, stagedPath),
      `transaction staged content ${entry.path}`,
    );
    if (
      staged.byteLength !== entry.newBytes ||
      sha256(staged) !== entry.newSha256
    ) {
      throw new PromptLayerError(
        `Prompt transaction staged content for ${entry.path} is invalid; refusing recovery.`,
      );
    }
  }
}

async function verifyTransactionTargets(
  root: string,
  entries: TransactionEntry[],
  version: "old" | "new",
): Promise<void> {
  for (const entry of entries) {
    const bytes = await readRequiredFile(
      join(root, entry.path),
      `transaction target ${entry.path}`,
    );
    const expectedBytes = version === "old" ? entry.oldBytes : entry.newBytes;
    const expectedSha = version === "old" ? entry.oldSha256 : entry.newSha256;
    if (bytes.byteLength !== expectedBytes || sha256(bytes) !== expectedSha) {
      throw new PromptLayerError(
        `Prompt transaction ${version} state for ${entry.path} cannot be verified.`,
      );
    }
  }
}

function validateWriteSet(
  operation: TransactionOperation,
  writes: WriteEntry[],
): void {
  validateTransactionPaths(
    operation,
    writes.map((write) => write.path),
  );
}
