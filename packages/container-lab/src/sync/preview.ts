import { randomBytes } from "node:crypto";
import path from "node:path";
import { canonicalRoot, sha256 } from "../files.ts";
import { serializePublicJson } from "../public/json.ts";
import { compareManifests } from "./comparison.ts";
import type {
  ApplySyncOptions,
  BaselineFile,
  PreviewSyncOptions,
  StoredPreview,
  SyncDirection,
  SyncIdentity,
  SyncPreview,
} from "./contract.ts";
import { writeDurableJson } from "./durability.ts";
import { buildGitManifest, manifestDigest } from "./git-manifest.ts";
import {
  captureDeleteParentDirectories,
  planCreatedDirectories,
} from "./staging.ts";
import { readRequiredUnknownJson, syncStatePaths } from "./state.ts";
import { parseBaselineFile } from "./validation/preview.ts";

const DEFAULT_TTL_MS = 5 * 60 * 1_000;

export async function initializeSyncBaseline(
  identity: SyncIdentity,
  root: string,
): Promise<void> {
  const state = await syncStatePaths(identity);
  const manifest = await buildGitManifest(root);
  await writeDurableJson(state.baseline, {
    version: 1,
    files: manifest.files,
  } satisfies BaselineFile);
}

export async function previewSync(
  options: PreviewSyncOptions,
): Promise<SyncPreview> {
  const state = await syncStatePaths(options);
  const [source, target, baselineValue] = await Promise.all([
    buildGitManifest(options.sourceRoot),
    buildGitManifest(options.targetRoot),
    readRequiredUnknownJson(
      state.baseline,
      "Synchronization baseline is missing; initialize it when the lab is created",
    ),
  ]);
  const baseline = parseBaselineFile(baselineValue);
  const comparison = compareManifests(
    baseline.files,
    source.files,
    target.files,
  );
  if (
    options.maxEntries !== undefined &&
    comparison.changes.length + comparison.conflicts.length > options.maxEntries
  ) {
    throw new Error(
      `Synchronization preview has more than ${options.maxEntries} entries; reduce the change set before applying`,
    );
  }
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(
    (options.now ?? new Date()).getTime() + (options.ttlMs ?? DEFAULT_TTL_MS),
  ).toISOString();
  const draft: Omit<StoredPreview, "binding"> = {
    version: 1,
    token,
    expiresAt,
    sourceDigest: source.digest,
    targetDigest: target.digest,
    ...comparison,
    labId: options.labId,
    direction: options.direction,
    sourceRoot: source.root,
    targetRoot: target.root,
    baselineDigest: manifestDigest(baseline.files),
    missingTargetDirectories: await planCreatedDirectories(
      target.root,
      comparison.changes,
    ),
    deleteParentDirectories: await captureDeleteParentDirectories(
      target.root,
      comparison.changes,
    ),
    expectedTargets: Object.fromEntries(
      comparison.changes.map((change) => [
        change.path,
        target.files[change.path] ?? null,
      ]),
    ),
  };
  const stored: StoredPreview = { ...draft, binding: previewBinding(draft) };
  // Public previews always provide maxEntries. Never persist their token when
  // the CLI could not expose every bounded path; internal provisioning previews
  // remain independent of the agent-facing response budget.
  if (options.maxEntries !== undefined) {
    assertPublicPreviewFitsBudget(publicPreview(stored), options);
  }
  await writeDurableJson(path.join(state.previews, `${token}.json`), stored);
  return publicPreview(stored);
}

export function previewBinding(
  preview: Omit<StoredPreview, "binding"> | StoredPreview,
): string {
  return sha256(JSON.stringify(previewSemanticPayload(preview)));
}

function previewSemanticPayload(
  preview: Omit<StoredPreview, "binding"> | StoredPreview,
) {
  return {
    version: preview.version,
    token: preview.token,
    expiresAt: preview.expiresAt,
    labId: preview.labId,
    direction: preview.direction,
    sourceRoot: preview.sourceRoot,
    targetRoot: preview.targetRoot,
    sourceDigest: preview.sourceDigest,
    targetDigest: preview.targetDigest,
    baselineDigest: preview.baselineDigest,
    missingTargetDirectories: preview.missingTargetDirectories,
    deleteParentDirectories: preview.deleteParentDirectories,
    changes: preview.changes,
    conflicts: preview.conflicts,
    expectedTargets: Object.fromEntries(
      Object.entries(preview.expectedTargets).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
}

export async function canonicalPreviewRoots(
  options: ApplySyncOptions,
): Promise<{ sourceRoot: string; targetRoot: string }> {
  const [sourceRoot, targetRoot] = await Promise.all([
    canonicalRoot(options.sourceRoot),
    canonicalRoot(options.targetRoot),
  ]);
  return { sourceRoot, targetRoot };
}

export function assertPreviewBinding(
  preview: StoredPreview,
  options: ApplySyncOptions,
  sourceRoot: string,
  targetRoot: string,
): void {
  if (
    preview.token !== options.token ||
    preview.labId !== options.labId ||
    preview.direction !== options.direction ||
    preview.sourceRoot !== sourceRoot ||
    preview.targetRoot !== targetRoot
  ) {
    throw new Error(
      "Synchronization preview token does not match the requested lab, direction, or roots",
    );
  }
}

function publicPreview(value: StoredPreview): SyncPreview {
  return {
    token: value.token,
    expiresAt: value.expiresAt,
    sourceDigest: value.sourceDigest,
    targetDigest: value.targetDigest,
    changes: value.changes,
    conflicts: value.conflicts,
  };
}

export function publicSyncPreview(
  preview: SyncPreview,
  labId: string,
  direction: SyncDirection,
) {
  return {
    labId,
    direction,
    token: preview.token,
    expiresAt: preview.expiresAt,
    changes: preview.changes,
    conflicts: preview.conflicts,
    changeCount: preview.changes.length,
    conflictCount: preview.conflicts.length,
    truncated: false,
  };
}

function assertPublicPreviewFitsBudget(
  preview: SyncPreview,
  options: Pick<PreviewSyncOptions, "labId" | "direction">,
): void {
  try {
    serializePublicJson(
      publicSyncPreview(preview, options.labId, options.direction),
    );
  } catch {
    throw new Error(
      "Synchronization preview cannot be exposed within the 16 KiB public output budget; reduce the change set before applying",
    );
  }
}
