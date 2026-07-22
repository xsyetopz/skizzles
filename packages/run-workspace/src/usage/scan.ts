import { types } from "node:util";
import type {
  InvalidWorkspaceUsage,
  MeasuredWorkspaceUsage,
  WorkspaceUsage,
  WorkspaceUsageLimits,
} from "../contract.ts";
import { type Marker, sameFileIdentity, verifyMarkedRoot } from "../marker.ts";
import type { Runtime } from "../platform.ts";
import type { UsageDirectory, UsageEntry } from "./contract.ts";

const maximumScanLimit = 1_000_000;
const maximumSafeBytes = BigInt(Number.MAX_SAFE_INTEGER);
const limitNames = ["byteLimit", "entryLimit", "scanLimit"] as const;
const limitNameSet = new Set<string>(limitNames);
const unsafeEntryName = /[\\/\0]/u;

interface Totals {
  logicalBytes: bigint;
  allocatedBytes: bigint;
  entryCount: number;
}

interface ScanContext {
  readonly limits: WorkspaceUsageLimits;
  readonly totals: Totals;
  readonly measuredIdentities: Map<string, UsageEntry>;
  readonly directoryIdentities: Set<string>;
}

function integerLimit(value: unknown, maximum: number): number | undefined {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return;
  }
  const selected = Number(value);
  if (selected > maximum) {
    return;
  }
  return selected;
}

export function parseUsageLimits(
  value: unknown,
): WorkspaceUsageLimits | undefined {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== limitNames.length ||
      keys.some((key) => typeof key !== "string" || !limitNameSet.has(key))
    ) {
      return;
    }
    const values = new Map<string, unknown>();
    for (const name of limitNames) {
      const descriptor = descriptors[name];
      if (descriptor === undefined || !("value" in descriptor)) {
        return;
      }
      values.set(name, descriptor.value);
    }
    const byteLimit = integerLimit(
      values.get("byteLimit"),
      Number.MAX_SAFE_INTEGER,
    );
    const entryLimit = integerLimit(
      values.get("entryLimit"),
      Number.MAX_SAFE_INTEGER,
    );
    const scanLimit = integerLimit(values.get("scanLimit"), maximumScanLimit);
    if (
      byteLimit === undefined ||
      entryLimit === undefined ||
      scanLimit === undefined
    ) {
      return;
    }
    return { byteLimit, entryLimit, scanLimit };
  } catch {
    return;
  }
}

export function invalidUsage(): InvalidWorkspaceUsage {
  return {
    state: "unknown",
    code: "INVALID_USAGE_LIMIT",
    logicalBytes: 0,
    allocatedBytes: 0,
    entryCount: 0,
  };
}

function boundedNumber(value: bigint): number | undefined {
  if (value > maximumSafeBytes) {
    return;
  }
  return Number(value);
}

function report(
  state: MeasuredWorkspaceUsage["state"],
  limits: WorkspaceUsageLimits,
  totals: Totals,
): MeasuredWorkspaceUsage {
  return {
    state,
    logicalBytes: boundedNumber(totals.logicalBytes) ?? Number.MAX_SAFE_INTEGER,
    allocatedBytes:
      boundedNumber(totals.allocatedBytes) ?? Number.MAX_SAFE_INTEGER,
    entryCount: totals.entryCount,
    ...limits,
  };
}

export function unknownUsage(
  limits: WorkspaceUsageLimits,
  totals: Totals = {
    logicalBytes: 0n,
    allocatedBytes: 0n,
    entryCount: 0,
  },
): MeasuredWorkspaceUsage {
  return report("unknown", limits, totals);
}

function sameEntry(left: UsageEntry, right: UsageEntry): boolean {
  return (
    left.kind === right.kind &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs &&
    left.changeTimeNs === right.changeTimeNs &&
    left.modifiedTimeNs === right.modifiedTimeNs &&
    left.logicalBytes === right.logicalBytes &&
    left.allocatedBytes === right.allocatedBytes
  );
}

function identity(entry: UsageEntry): string {
  return `${entry.device}:${entry.inode}`;
}

function validEntry(entry: UsageEntry): boolean {
  return (
    entry.device.length > 0 &&
    entry.inode.length > 0 &&
    entry.birthtimeNs.length > 0 &&
    entry.changeTimeNs.length > 0 &&
    entry.modifiedTimeNs.length > 0 &&
    entry.logicalBytes >= 0n &&
    entry.allocatedBytes >= 0n
  );
}

function rootMatchesMarker(entry: UsageEntry, marker: Marker): boolean {
  return (
    entry.kind === "directory" &&
    sameFileIdentity(
      {
        device: entry.device,
        inode: entry.inode,
        birthtimeNs: entry.birthtimeNs,
      },
      marker.rootIdentity,
    )
  );
}

function addEntry(entry: UsageEntry, context: ScanContext): boolean {
  const key = identity(entry);
  const measured = context.measuredIdentities.get(key);
  if (measured !== undefined) {
    return sameEntry(measured, entry);
  }
  context.measuredIdentities.set(key, entry);
  context.totals.logicalBytes += entry.logicalBytes;
  context.totals.allocatedBytes += entry.allocatedBytes;
  return (
    context.totals.logicalBytes <= maximumSafeBytes &&
    context.totals.allocatedBytes <= maximumSafeBytes
  );
}

function safeName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !unsafeEntryName.test(name)
  );
}

async function closeDirectory(directory: UsageDirectory): Promise<boolean> {
  try {
    await directory.close();
    return true;
  } catch {
    return false;
  }
}

async function inspectDirectory(
  directory: UsageDirectory,
  expected: UsageEntry,
  context: ScanContext,
): Promise<boolean> {
  if (!validEntry(directory.entry) || !sameEntry(directory.entry, expected)) {
    return false;
  }
  const remaining = context.limits.scanLimit - context.totals.entryCount;
  const scanned = await directory.scan(remaining);
  if (scanned.truncated || scanned.names.length > remaining) {
    return false;
  }
  const entries = new Map<string, UsageEntry>();
  for (const name of scanned.names) {
    if (!safeName(name) || entries.has(name)) {
      return false;
    }
    const entry = await directory.inspect(name);
    if (entry === undefined || !validEntry(entry)) {
      return false;
    }
    entries.set(name, entry);
    context.totals.entryCount += 1;
    if (!addEntry(entry, context)) {
      return false;
    }
    if (entry.kind === "directory") {
      const key = identity(entry);
      if (context.directoryIdentities.has(key)) {
        return false;
      }
      context.directoryIdentities.add(key);
      const child = await directory.open(name);
      if (child === undefined) {
        return false;
      }
      let childValid = false;
      try {
        childValid = await inspectDirectory(child, entry, context);
      } finally {
        if (!(await closeDirectory(child))) {
          childValid = false;
        }
      }
      if (!childValid) {
        return false;
      }
    }
  }
  for (const [name, entry] of entries) {
    const current = await directory.inspect(name);
    if (current === undefined || !sameEntry(entry, current)) {
      return false;
    }
  }
  const current = await directory.stat();
  return current !== undefined && sameEntry(directory.entry, current);
}

export async function inspectWorkspaceUsage(
  runtime: Runtime,
  root: string,
  runId: string,
  expectedRoot: string,
  limits: WorkspaceUsageLimits,
): Promise<WorkspaceUsage> {
  const totals: Totals = {
    logicalBytes: 0n,
    allocatedBytes: 0n,
    entryCount: 0,
  };
  try {
    const marker = await verifyMarkedRoot(runtime, root, runId, expectedRoot);
    const rootEntry = await runtime.lstatUsage(root);
    if (
      rootEntry === undefined ||
      !validEntry(rootEntry) ||
      !rootMatchesMarker(rootEntry, marker)
    ) {
      return unknownUsage(limits, totals);
    }
    const directory = await runtime.openUsageDirectory(root);
    if (directory === undefined) {
      return unknownUsage(limits, totals);
    }
    const context: ScanContext = {
      limits,
      totals,
      measuredIdentities: new Map<string, UsageEntry>(),
      directoryIdentities: new Set<string>([identity(rootEntry)]),
    };
    let valid = false;
    try {
      valid = await inspectDirectory(directory, rootEntry, context);
    } finally {
      if (!(await closeDirectory(directory))) {
        valid = false;
      }
    }
    if (!valid) {
      return unknownUsage(limits, totals);
    }
    await verifyMarkedRoot(runtime, root, runId, expectedRoot);
    const logicalBytes = boundedNumber(totals.logicalBytes);
    const allocatedBytes = boundedNumber(totals.allocatedBytes);
    if (logicalBytes === undefined || allocatedBytes === undefined) {
      return unknownUsage(limits, totals);
    }
    const exceeded =
      logicalBytes > limits.byteLimit ||
      allocatedBytes > limits.byteLimit ||
      totals.entryCount > limits.entryLimit;
    if (exceeded) {
      return report("exceeded", limits, totals);
    }
    return report("within", limits, totals);
  } catch {
    return unknownUsage(limits, totals);
  }
}
