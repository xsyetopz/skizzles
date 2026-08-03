import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalExistingPath } from "../managed-filesystem";
import type { InstructionMode, JsonValue, OrchestrationMode } from "./edit-policy";

export interface OwnedConfigValue {
  keyPath: string;
  beforePresent: boolean;
  before: JsonValue;
  after: JsonValue;
}

export interface ConfigReceipt {
  version: 1;
  state: "pending" | "active" | "restoring";
  orchestration: OrchestrationMode;
  instructions?: InstructionMode;
  sourceRoot?: string;
  codexBinary: string;
  configPath: string;
  values: OwnedConfigValue[];
  /** Tables that were absent before role-level ownership was installed. */
  cleanupPaths?: string[];
}

export interface ConfigReconcileChange {
  keyPath: string;
  beforePresent: boolean;
  before: JsonValue;
  afterPresent: boolean;
  after: JsonValue;
}

export interface PendingConfigReconciliation {
  version: 1;
  previous: ConfigReceipt;
  next: ConfigReceipt;
  changes: ConfigReconcileChange[];
}

export function configReceiptPath(codexHome: string): string {
  return join(canonicalExistingPath(codexHome), ".skizzles", "config-receipt.json");
}

export function configReconcilePendingPath(codexHome: string): string {
  return join(canonicalExistingPath(codexHome), ".skizzles", "config-reconcile-pending.json");
}

export function readConfigReceipt(codexHome: string): ConfigReceipt {
  const path = configReceiptPath(codexHome);
  if (!existsSync(path)) throw new Error(`Skizzles config receipt is missing: ${path}`);
  return parseReceipt(path);
}

export function readPendingConfigReconciliation(codexHome: string): PendingConfigReconciliation | undefined {
  const path = configReconcilePendingPath(codexHome);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PendingConfigReconciliation>;
  if (
    parsed.version !== 1 ||
    !parsed.previous ||
    !parsed.next ||
    !Array.isArray(parsed.changes)
  ) throw new Error(`invalid Skizzles pending config reconciliation: ${path}`);
  validateReceipt(parsed.previous, path);
  validateReceipt(parsed.next, path);
  if (!parsed.changes.every((change) =>
    !!change &&
    typeof change.keyPath === "string" &&
    typeof change.beforePresent === "boolean" &&
    typeof change.afterPresent === "boolean" &&
    "before" in change &&
    "after" in change,
  )) throw new Error(`invalid Skizzles pending config reconciliation: ${path}`);
  return parsed as PendingConfigReconciliation;
}

export function writePendingConfigReconciliation(path: string, transaction: PendingConfigReconciliation): void {
  if (transaction.previous.state !== "active" || transaction.next.state !== "active") {
    throw new Error("pending reconciliation must contain active receipts");
  }
  persistReceipt(path, transaction, true);
}

export function removePendingConfigReconciliation(codexHome: string, force = false): void {
  rmSync(configReconcilePendingPath(codexHome), { force });
}

function parseReceipt(path: string): ConfigReceipt {
  const receipt = JSON.parse(readFileSync(path, "utf8")) as Partial<ConfigReceipt>;
  validateReceipt(receipt, path);
  return receipt as ConfigReceipt;
}

function validateReceipt(receipt: Partial<ConfigReceipt>, path: string): void {
  if (
    receipt.version !== 1 ||
    !["pending", "active", "restoring"].includes(receipt.state ?? "") ||
    !["aggressive", "passive"].includes(receipt.orchestration ?? "") ||
    (receipt.instructions !== undefined && !["native", "skizzles"].includes(receipt.instructions)) ||
    !Array.isArray(receipt.values) ||
    (receipt.cleanupPaths !== undefined && !Array.isArray(receipt.cleanupPaths)) ||
    (receipt.cleanupPaths !== undefined && !receipt.cleanupPaths.every((path) => typeof path === "string" && path.length > 0))
  ) {
    throw new Error(`invalid Skizzles config receipt: ${path}`);
  }
}

export function writePendingConfigReceipt(path: string, receipt: ConfigReceipt): void {
  if (receipt.state !== "pending") throw new Error("new config receipt must be pending");
  persistReceipt(path, receipt, true);
}

export function activateConfigReceipt(path: string, receipt: ConfigReceipt): ConfigReceipt {
  const activeReceipt = { ...receipt, state: "active" as const };
  persistReceipt(path, activeReceipt);
  return activeReceipt;
}

export function beginConfigRestoration(path: string, receipt: ConfigReceipt): ConfigReceipt {
  const restoringReceipt = { ...receipt, state: "restoring" as const };
  persistReceipt(path, restoringReceipt);
  return restoringReceipt;
}

export function removeConfigReceipt(path: string, force = false): void {
  rmSync(path, { force });
}

function persistReceipt(path: string, receipt: object, exclusive = false): void {
  mkdirSync(dirname(path), { recursive: true });
  const contents = `${JSON.stringify(receipt, null, 2)}\n`;
  if (exclusive) {
    writeFileSync(path, contents, { flag: "wx" });
    return;
  }

  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { flag: "wx" });
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
