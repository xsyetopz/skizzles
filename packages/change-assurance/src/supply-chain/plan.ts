import type { Digest } from "../digest.ts";
import { digestValue } from "../digest.ts";
import type {
  PackageChange,
  SupplyChainPlan,
  SupplyChainPlanCreationResult,
} from "./contract.ts";
import {
  exactRecord,
  maximumPackages,
  validPackage,
  validVersion,
} from "./values.ts";

export function parseSupplyPlan(value: unknown): SupplyChainPlan | undefined {
  const record = exactRecord(value, ["schemaVersion", "changes"]);
  if (!record || record.get("schemaVersion") !== 1) return;
  const rawChanges = record.get("changes");
  if (
    !(Array.isArray(rawChanges) && Object.isFrozen(rawChanges)) ||
    rawChanges.length === 0 ||
    rawChanges.length > maximumPackages
  )
    return;
  const changes: PackageChange[] = [];
  let previous = "";
  for (const raw of rawChanges) {
    const change = parseChange(raw);
    if (change === undefined) return;
    const identity = `${change.name}@${change.version}`;
    if (identity <= previous) return;
    previous = identity;
    changes.push(change);
  }
  return Object.freeze({ schemaVersion: 1, changes: Object.freeze(changes) });
}

export function createSupplyChainPlan(
  value: unknown,
): SupplyChainPlanCreationResult {
  const plan = parseSupplyPlan(value);
  return plan === undefined
    ? Object.freeze({ status: "rejected", code: "INVALID_SUPPLY_PLAN" })
    : Object.freeze({ status: "created", plan });
}

export function digestSupplyPlan(plan: SupplyChainPlan): Digest {
  return digestValue({
    schemaVersion: plan.schemaVersion,
    changes: plan.changes,
  });
}

function parseChange(value: unknown): PackageChange | undefined {
  const record = exactRecord(value, ["name", "version", "operation"]);
  if (!record) return;
  const name = record.get("name");
  const version = record.get("version");
  const operation = record.get("operation");
  if (
    !(validPackage(name) && validVersion(version)) ||
    (operation !== "add" && operation !== "update")
  )
    return;
  return Object.freeze({ name, version, operation });
}
