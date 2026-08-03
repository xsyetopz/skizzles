import { join, resolve } from "node:path";
import {
  assertManagedParentsAreReal,
  canonicalExistingPath,
  pathEntryExists,
} from "../managed-filesystem";
import {
  CodexAppServerAdapter,
  resolveCodexBinary,
  selectUserConfigLayer,
} from "./codex-app-server";
import { assertSupportedCodexBinary } from "./codex-version";
import {
  desiredConfigEdits,
  resolveInstructionAssets,
  sameJsonValue,
  valueAt,
  type ConfigEdit,
  type JsonValue,
} from "./edit-policy";
import {
  activateConfigReceipt,
  configReceiptPath,
  configReconcilePendingPath,
  readConfigReceipt,
  readPendingConfigReconciliation,
  removePendingConfigReconciliation,
  writePendingConfigReconciliation,
  type ConfigReconcileChange,
  type PendingConfigReconciliation,
  type ConfigReceipt,
} from "./receipt";
import { configureCodex } from "./orchestration";
import type { ConfigureOptions, EnsureConfigResult } from "./orchestration";

/**
 * Reconcile an active receipt with a newly selected profile.
 *
 * The active receipt is the restoration boundary.  Its `before` values are
 * never replaced; keys that leave the new profile are restored to those
 * values and removed from active ownership.  Receipt-owned values may be
 * replaced when they differ because this operation is an explicit local
 * suite refresh.  Unreceipted values are only captured as a new baseline.
 */
export async function reconcileCodex(options: ConfigureOptions): Promise<ConfigReceipt> {
  return (await reconcileCodexInternal(options)).receipt;
}

export async function ensureCodexConfigured(options: ConfigureOptions): Promise<EnsureConfigResult> {
  const codexHome = canonicalExistingPath(options.codexHome);
  const receiptPath = configReceiptPath(codexHome);
  if (readPendingConfigReconciliation(codexHome)) {
    throw new Error(`pending Skizzles config reconciliation requires unconfigure recovery: ${configReconcilePendingPath(codexHome)}`);
  }
  if (!pathEntryExists(receiptPath)) {
    return { receipt: await configureCodex(options), status: "install" };
  }
  const existing = readConfigReceipt(codexHome);
  if (existing.state !== "active") {
    throw new Error(`cannot reconcile non-active Skizzles config receipt: ${existing.state}`);
  }
  const result = await reconcileCodexInternal(options, existing);
  return { receipt: result.receipt, status: result.changed ? "reconcile" : "noop" };
}

interface ReconcileResult {
  receipt: ConfigReceipt;
  changed: boolean;
}

async function reconcileCodexInternal(
  options: ConfigureOptions,
  existingReceipt?: ConfigReceipt,
): Promise<ReconcileResult> {
  const codexHome = canonicalExistingPath(options.codexHome);
  const codexBinary = resolveCodexBinary(options.codexBinary);
  await assertSupportedCodexBinary(codexBinary);
  const instructions = options.instructions ?? "native";
  if (instructions === "skizzles" && !options.sourceRoot) {
    throw new Error("--source-root is required with --instructions skizzles");
  }
  const instructionAssets = instructions === "skizzles"
    ? resolveInstructionAssets(options.sourceRoot!)
    : undefined;
  assertManagedParentsAreReal(codexHome, [".skizzles"]);
  const receiptPath = configReceiptPath(codexHome);
  if (readPendingConfigReconciliation(codexHome)) {
    throw new Error(`pending Skizzles config reconciliation requires unconfigure recovery: ${configReconcilePendingPath(codexHome)}`);
  }
  const receipt = existingReceipt ?? readConfigReceipt(codexHome);
  if (receipt.state !== "active") {
    throw new Error(`cannot reconcile non-active Skizzles config receipt: ${receipt.state}`);
  }
  if (resolve(receipt.codexBinary) !== codexBinary) {
    throw new Error(`use the Codex binary recorded by the config receipt: ${receipt.codexBinary}`);
  }
  const configPath = join(codexHome, "config.toml");
  if (resolve(receipt.configPath) !== configPath) {
    throw new Error("config receipt points outside the selected CODEX_HOME");
  }

  const rpc = await (options.rpcFactory ?? CodexAppServerAdapter.create)(codexHome, codexBinary);
  try {
    const layer = selectUserConfigLayer(await rpc.read(), configPath);
    const desired = desiredConfigEdits(options.orchestration, instructionAssets, layer.config);
    // Receipts written by older installers owned an initially absent `agents`
    // table (or role) as one broad value.  Split that known generated shape
    // into independent leaves before planning, so later user descendants are
    // never absorbed into the restoration boundary.
    const ownershipReceipt = migrateLegacyAgentOwnership(receipt);
    const plan = reconcileValues(ownershipReceipt, desired, layer.config);
    const wantsAgentRoles = desired.some(({ keyPath }) => keyPath.startsWith("agents."));
    const desiredRolePaths = roleCleanupPaths(desired);
    const cleanupPaths = wantsAgentRoles
      ? (ownershipReceipt.cleanupPaths ?? []).filter((path) => path !== "agents" && desiredRolePaths.includes(path))
      : [];
    if (wantsAgentRoles) {
      if (!valueAt(layer.config, "agents").present || (ownershipReceipt.cleanupPaths ?? []).includes("agents")) {
        cleanupPaths.unshift("agents");
      }
      for (const rolePath of desiredRolePaths) {
        const roleHasAbsentLeaf = desired.some(({ keyPath }) =>
          keyPath.startsWith(`${rolePath}.`) && !valueAt(layer.config, keyPath).present,
        );
        if (roleHasAbsentLeaf && !cleanupPaths.includes(rolePath)) cleanupPaths.push(rolePath);
      }
    }
    const nextReceipt: ConfigReceipt = {
      version: 1,
      state: "active",
      orchestration: options.orchestration,
      instructions,
      ...(instructionAssets ? { sourceRoot: instructionAssets.sourceRoot } : {}),
      codexBinary,
      configPath,
      values: plan.values,
      ...(cleanupPaths.length > 0 ? { cleanupPaths } : {}),
    };
    const receiptChanged = JSON.stringify(nextReceipt) !== JSON.stringify(receipt);
    if (options.dryRun) return { receipt: nextReceipt, changed: plan.edits.length > 0 || receiptChanged };
    const pendingPath = configReconcilePendingPath(codexHome);
    let pendingWritten = false;
    if (plan.edits.length > 0) {
      // Do not touch the active receipt until Codex accepts the optimistic
      // version.  A conflict therefore leaves a valid, recoverable receipt.
      const transaction: PendingConfigReconciliation = {
        version: 1,
        previous: ownershipReceipt,
        next: nextReceipt,
        changes: plan.edits.map((edit) => {
          const before = valueAt(layer.config, edit.keyPath);
          return {
            keyPath: edit.keyPath,
            beforePresent: before.present,
            before: before.value,
            afterPresent: edit.value !== null,
            after: edit.value,
          } satisfies ConfigReconcileChange;
        }),
      };
      writePendingConfigReconciliation(pendingPath, transaction);
      pendingWritten = true;
      try {
        await rpc.batchWrite({
          edits: plan.edits,
          filePath: configPath,
          expectedVersion: layer.version,
          reloadUserConfig: true,
        });
      } catch (error) {
        if (isVersionConflict(error)) {
          try { removePendingConfigReconciliation(codexHome, true); } catch {}
        }
        throw error;
      }
    }
    // Update profile metadata and active `after` values only when something
    // actually changed.  A healthy second run is a true no-op, including its
    // receipt mtime.  The replacement remains atomic and keeps `before`.
    if (plan.edits.length > 0 || receiptChanged) {
      try {
        activateConfigReceipt(receiptPath, nextReceipt);
      } catch (error) {
        throw new Error(
          `configuration write succeeded but the active receipt could not be updated: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
    if (pendingWritten) {
      try { removePendingConfigReconciliation(codexHome); } catch (error) {
        throw new Error(
          `configuration and receipt committed but pending recovery marker could not be removed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
    return { receipt: receiptChanged ? nextReceipt : receipt, changed: plan.edits.length > 0 || receiptChanged };
  } finally {
    await rpc.close();
  }
}

/**
 * Migrate v1 receipts that owned a generated agents table/role wholesale.
 *
 * The old installer emitted `agents` when the table was absent and
 * `agents.<role>` when only that role was absent.  Those parent values cannot
 * be retained safely once a user adds a nickname or another role.  Their
 * generated shape is intentionally narrow, so split only objects containing
 * exactly the generated description/config_file leaves and inherit the
 * parent's absent baseline.  Any unexpected shape fails closed rather than
 * guessing at ownership.
 */
export function migrateLegacyAgentOwnership(receipt: ConfigReceipt): ConfigReceipt {
  if (receipt.instructions !== "skizzles") return receipt;

  const migratedValues: ConfigReceipt["values"] = [];
  const cleanupPaths = new Set(receipt.cleanupPaths ?? []);
  let changed = false;
  const seenPaths = new Set<string>();

  for (const value of receipt.values) {
    const segments = value.keyPath.split(".");
    const isLegacyParent =
      !value.beforePresent &&
      (value.keyPath === "agents" || (segments.length === 2 && segments[0] === "agents"));
    if (!isLegacyParent) {
      if (seenPaths.has(value.keyPath)) throw new Error(`invalid Skizzles config receipt has duplicate key: ${value.keyPath}`);
      seenPaths.add(value.keyPath);
      migratedValues.push(value);
      continue;
    }

    const parentAfter = asJsonRecord(value.after);
    if (!parentAfter || Object.keys(parentAfter).length === 0) {
      throw new Error(`cannot migrate legacy Skizzles agents ownership: ${value.keyPath}`);
    }
    cleanupPaths.add(value.keyPath);
    const roles = value.keyPath === "agents"
      ? Object.entries(parentAfter).map(([role, roleValue]) => ({ role, generated: asJsonRecord(roleValue) }))
      : [{ role: segments[1]!, generated: parentAfter }];
    for (const { role, generated } of roles) {
      if (!/^[a-z][a-z0-9_]*$/.test(role)) {
        throw new Error(`cannot migrate legacy Skizzles agents ownership: ${value.keyPath}`);
      }
      if (!generated || Object.keys(generated).some((key) => key !== "description" && key !== "config_file") ||
        !Object.hasOwn(generated, "description") || !Object.hasOwn(generated, "config_file")) {
        throw new Error(`cannot migrate legacy Skizzles agents ownership: ${value.keyPath}`);
      }
      for (const field of ["description", "config_file"] as const) {
        const keyPath = value.keyPath === "agents"
          ? `agents.${role}.${field}`
          : `${value.keyPath}.${field}`;
        if (seenPaths.has(keyPath)) throw new Error(`invalid Skizzles config receipt has duplicate key: ${keyPath}`);
        seenPaths.add(keyPath);
        migratedValues.push({
          keyPath,
          beforePresent: false,
          before: null,
          after: structuredClone(generated[field]!),
        });
      }
    }
    changed = true;
  }

  if (!changed) return receipt;
  return {
    ...receipt,
    values: migratedValues,
    ...(cleanupPaths.size > 0 ? { cleanupPaths: [...cleanupPaths] } : {}),
  };
}

function asJsonRecord(value: JsonValue): { [key: string]: JsonValue } | undefined {
  return value !== null && !Array.isArray(value) && typeof value === "object" ? value : undefined;
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof Error && /config.?version.?conflict|version.?conflict/i.test(error.message);
}

function roleCleanupPaths(edits: Array<{ keyPath: string }>): string[] {
  return [...new Set(
    edits
      .filter(({ keyPath }) => keyPath.startsWith("agents."))
      .map(({ keyPath }) => keyPath.split(".").slice(0, 2).join(".")),
  )];
}

interface ReconcilePlan {
  edits: ConfigEdit[];
  values: ConfigReceipt["values"];
}

/** Build a versioned batchWrite while preserving receipt ownership shape. */
function reconcileValues(
  receipt: ConfigReceipt,
  desired: ConfigEdit[],
  current: JsonValue,
): ReconcilePlan {
  const planned = cloneJson(current);
  for (const edit of desired) applyJsonEdit(planned, edit.keyPath, edit.value);

  const oldPaths = receipt.values.map(({ keyPath }) => keyPath);
  const desiredPaths = desired.map(({ keyPath }) => keyPath);
  const retained = new Set<string>();
  const removed = new Set<string>();
  const cleanupRolePaths = new Set<string>();
  for (const oldPath of oldPaths) {
    const exactOrAncestor = desiredPaths.some(
      (desiredPath) => desiredPath === oldPath || isDescendant(desiredPath, oldPath),
    );
    const desiredAncestor = desiredPaths.some((desiredPath) => isDescendant(oldPath, desiredPath));
    if (desiredAncestor && !exactOrAncestor) {
      throw new Error(`cannot reconcile config receipt ownership shape: ${oldPath}`);
    }
    if (exactOrAncestor) retained.add(oldPath);
    else {
      removed.add(oldPath);
      const old = receipt.values.find(({ keyPath }) => keyPath === oldPath)!;
      applyJsonEdit(planned, oldPath, old.beforePresent ? old.before : null);
      const parent = oldPath.split(".").slice(0, -1).join(".");
      if (parent && !desiredPaths.some((desiredPath) => desiredPath === parent || isDescendant(desiredPath, parent))) {
        const currentParent = valueAt(current, parent);
        if (currentParent.present && isReceiptOwnedTable(currentParent.value, parent, receipt.values)) {
          cleanupRolePaths.add(parent);
        }
      }
    }
  }
  // A Skizzles instruction install records the initially absent `agents`
  // table as cleanup-owned.  On a profile downgrade, remove that table only
  // when every remaining value is still receipt-owned; user-created roles or
  // sibling fields therefore survive the downgrade unchanged.
  if (
    !desiredPaths.some((path) => path.startsWith("agents.")) &&
    (receipt.cleanupPaths ?? []).includes("agents")
  ) {
    const currentAgents = valueAt(current, "agents");
    if (
      currentAgents.present &&
      isReceiptOwnedTable(currentAgents.value, "agents", receipt.values)
    ) {
      cleanupRolePaths.add("agents");
    }
  }
  for (const parent of cleanupRolePaths) applyJsonEdit(planned, parent, null);

  const edits: ConfigEdit[] = [];
  for (const edit of desired) {
    const currentValue = valueAt(current, edit.keyPath);
    const targetValue = valueAt(planned, edit.keyPath);
    if (!samePresenceAndValue(currentValue, targetValue)) {
      edits.push({ ...edit, value: targetValue.present ? targetValue.value : null });
    }
  }
  for (const oldPath of removed) {
    const currentValue = valueAt(current, oldPath);
    const targetValue = valueAt(planned, oldPath);
    if (!samePresenceAndValue(currentValue, targetValue)) {
      edits.push({ keyPath: oldPath, value: targetValue.present ? targetValue.value : null, mergeStrategy: "replace" });
    }
  }
  for (const parent of cleanupRolePaths) {
    const currentValue = valueAt(current, parent);
    const targetValue = valueAt(planned, parent);
    if (!samePresenceAndValue(currentValue, targetValue)) {
      edits.push({ keyPath: parent, value: targetValue.present ? targetValue.value : null, mergeStrategy: "replace" });
    }
  }

  const values: ConfigReceipt["values"] = [];
  for (const old of receipt.values) {
    if (!retained.has(old.keyPath)) continue;
    const after = valueAt(planned, old.keyPath);
    values.push({ ...old, after: after.present ? after.value : null });
  }
  for (const edit of desired) {
    if (receipt.values.some((old) => old.keyPath === edit.keyPath || isDescendant(edit.keyPath, old.keyPath))) continue;
    if (receipt.values.some((old) => isDescendant(old.keyPath, edit.keyPath))) {
      throw new Error(`cannot reconcile config receipt ownership shape: ${edit.keyPath}`);
    }
    const before = valueAt(current, edit.keyPath);
    const after = valueAt(planned, edit.keyPath);
    values.push({
      keyPath: edit.keyPath,
      beforePresent: before.present,
      before: before.value,
      after: after.present ? after.value : null,
    });
  }
  return { edits, values };
}

function cloneJson(value: JsonValue): JsonValue {
  return structuredClone(value);
}

function isDescendant(path: string, parent: string): boolean {
  return path.startsWith(`${parent}.`);
}

function samePresenceAndValue(
  left: { present: boolean; value: JsonValue },
  right: { present: boolean; value: JsonValue },
): boolean {
  return left.present === right.present && (!left.present || sameJsonValue(left.value, right.value));
}

function applyJsonEdit(root: JsonValue, keyPath: string, value: JsonValue): void {
  const segments = keyPath.split(".");
  if (root === null || Array.isArray(root) || typeof root !== "object") {
    throw new Error(`cannot edit non-object config at ${keyPath}`);
  }
  let current = root as { [key: string]: JsonValue };
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (child === null || Array.isArray(child) || typeof child !== "object") current[segment] = {};
    current = current[segment] as { [key: string]: JsonValue };
  }
  const final = segments.at(-1)!;
  if (value === null) delete current[final];
  else current[final] = cloneJson(value);
}

/**
 * Return true only when a structurally absent table contains no unreceipted
 * top-level child.  This lets an initially absent `agents` table disappear
 * cleanly while preserving a role or sibling created after installation.
 */
export function isReceiptOwnedTable(
  value: JsonValue,
  tablePath: string,
  values: ConfigReceipt["values"],
): boolean {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  const ownedLeaves = new Set(
    values
      .filter(({ keyPath }) => isDescendant(keyPath, tablePath))
      .map(({ keyPath }) => keyPath),
  );
  const walk = (node: JsonValue, path: string): boolean => {
    if (node === null || Array.isArray(node) || typeof node !== "object") return ownedLeaves.has(path);
    return Object.entries(node).every(([key, child]) => walk(child, `${path}.${key}`));
  };
  return walk(value, tablePath);
}
