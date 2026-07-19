import { basename, dirname, join } from "node:path";
import type {
  CleanupReport,
  CleanupStaleOptions,
  SkipReason,
} from "./contract.ts";
import { RunWorkspaceError } from "./errors.ts";
import {
  type Marker,
  markerPath,
  readMarker,
  sameProcessIdentity,
  serializeMarker,
  verifyMarkedRoot,
} from "./marker.ts";
import {
  managedDirectoryName,
  managedParent,
  type Runtime,
  systemRuntime,
} from "./platform.ts";
import { inspectPrivateDirectory } from "./safety.ts";

const defaultMinimumAgeMs = 60 * 60 * 1000;
const defaultScanLimit = 128;

function integerOption(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > maximum) {
    throw new RunWorkspaceError(
      "INVALID_OPTION",
      `${name} must be an integer from 0 to ${maximum}`,
    );
  }
  return selected;
}

function candidateName(name: string): boolean {
  return name.startsWith("run-") || name.startsWith("reaping-");
}

function transitionalRoot(
  runtime: Runtime,
  root: string,
  marker: Marker,
): string | undefined {
  if (marker.root === root) return undefined;
  const parent = managedParent(runtime);
  if (
    dirname(root) === parent &&
    dirname(marker.root) === parent &&
    basename(root).startsWith(`reaping-${marker.runId}-`) &&
    candidateName(basename(marker.root))
  ) {
    return marker.root;
  }
  return undefined;
}

async function verifyCandidate(
  runtime: Runtime,
  root: string,
  marker: Marker,
): Promise<void> {
  const transition = transitionalRoot(runtime, root, marker);
  if (marker.root !== root && transition === undefined) {
    throw new RunWorkspaceError(
      "ROOT_IDENTITY_CHANGED",
      "Run workspace identity changed",
    );
  }
  await verifyMarkedRoot(runtime, root, marker.runId, transition);
}

async function classify(
  runtime: Runtime,
  root: string,
  minimumAgeMs: number,
): Promise<{ readonly clean: boolean; readonly skip?: SkipReason }> {
  if (!(await runtime.isFile(markerPath(root))))
    return { clean: false, skip: "unmarked" };
  const marker = await readMarker(runtime, root);
  if (marker === undefined) return { clean: false, skip: "malformed-marker" };
  if (marker.state === "preserved") return { clean: false, skip: "preserved" };
  if (runtime.now() - marker.createdAtMs < minimumAgeMs)
    return { clean: false, skip: "too-young" };
  try {
    await verifyCandidate(runtime, root, marker);
  } catch {
    return { clean: false, skip: "identity-mismatch" };
  }
  const currentIdentity = await runtime.processIdentity(marker.ownerPid);
  if (currentIdentity !== undefined) {
    if (sameProcessIdentity(currentIdentity, marker.ownerIdentity)) {
      return { clean: false, skip: "live-owner" };
    }
    return { clean: true };
  }
  const exists = await runtime.processExists(marker.ownerPid);
  if (exists === false) return { clean: true };
  return { clean: false, skip: "unknown-owner" };
}

async function reap(
  runtime: Runtime,
  root: string,
): Promise<"deleted" | "claimed"> {
  const marker = await readMarker(runtime, root);
  if (marker === undefined) {
    if ((await runtime.pathExists(root)) === false) return "claimed";
    throw new RunWorkspaceError(
      "MALFORMED_MARKER",
      "Marker vanished before cleanup",
    );
  }
  try {
    await verifyCandidate(runtime, root, marker);
  } catch (error) {
    if ((await runtime.pathExists(root)) === false) return "claimed";
    throw error;
  }
  const claimed = join(
    managedParent(runtime),
    `reaping-${marker.runId}-${crypto.randomUUID()}`,
  );
  try {
    await runtime.rename(root, claimed);
  } catch (error) {
    if ((await runtime.pathExists(root)) === false) return "claimed";
    throw error;
  }
  const verified = await verifyMarkedRoot(
    runtime,
    claimed,
    marker.runId,
    marker.root,
  );
  const reapingMarker: Marker = {
    ...verified,
    root: claimed,
    state: "reaping",
  };
  await runtime.writeReplace(
    markerPath(claimed),
    serializeMarker(reapingMarker),
  );
  await verifyMarkedRoot(runtime, claimed, marker.runId);
  try {
    await runtime.removeRoot(claimed);
  } catch (error) {
    const failedMarker: Marker = {
      ...reapingMarker,
      state: "cleanup-failed",
      reason: "CLEANUP_FAILED",
    };
    await runtime
      .writeReplace(markerPath(claimed), serializeMarker(failedMarker))
      .catch(() => undefined);
    throw error;
  }
  return "deleted";
}

export async function cleanupStaleWithRuntime(
  options: CleanupStaleOptions,
  runtime: Runtime,
): Promise<CleanupReport> {
  const minimumAgeMs = integerOption(
    options.minimumAgeMs,
    defaultMinimumAgeMs,
    "minimumAgeMs",
    365 * 24 * 60 * 60 * 1000,
  );
  const scanLimit = integerOption(
    options.scanLimit,
    defaultScanLimit,
    "scanLimit",
    10_000,
  );
  const parent = managedParent(runtime);
  const parentExists = await runtime.pathExists(parent);
  if (parentExists === false) {
    return { deleted: [], skipped: [], failed: [], truncated: false };
  }
  if ((await inspectPrivateDirectory(runtime, parent)) === undefined) {
    return {
      deleted: [],
      skipped: [],
      failed: [{ rootName: managedDirectoryName, error: "CLEANUP_FAILED" }],
      truncated: false,
    };
  }
  let scan: { readonly names: readonly string[]; readonly truncated: boolean };
  try {
    scan = await runtime.scanDirectory(parent, scanLimit);
  } catch (error) {
    if (runtime.errorCode(error) === "ENOENT") {
      return { deleted: [], skipped: [], failed: [], truncated: false };
    }
    return {
      deleted: [],
      skipped: [],
      failed: [{ rootName: managedDirectoryName, error: "CLEANUP_FAILED" }],
      truncated: false,
    };
  }
  const selected = scan.names.filter(candidateName).sort();
  const deleted: string[] = [];
  const skipped: Array<{ rootName: string; reason: SkipReason }> = [];
  const failed: Array<{ rootName: string; error: "CLEANUP_FAILED" }> = [];
  for (const name of selected) {
    const root = join(parent, name);
    if (!(await runtime.isDirectory(root))) {
      skipped.push({ rootName: name, reason: "unmarked" });
      continue;
    }
    const classification = await classify(runtime, root, minimumAgeMs);
    if (!classification.clean) {
      skipped.push({
        rootName: name,
        reason: classification.skip ?? "unknown-owner",
      });
      continue;
    }
    try {
      const result = await reap(runtime, root);
      if (result === "deleted") deleted.push(name);
      else skipped.push({ rootName: name, reason: "claimed" });
    } catch {
      failed.push({ rootName: name, error: "CLEANUP_FAILED" });
    }
  }
  return { deleted, skipped, failed, truncated: scan.truncated };
}

export function cleanupStale(
  options: CleanupStaleOptions = {},
): Promise<CleanupReport> {
  return cleanupStaleWithRuntime(options, systemRuntime());
}
