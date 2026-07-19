import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import {
  cleanupStale,
  create,
  type RunWorkspace,
  RunWorkspaceAbortedError,
} from "@skizzles/run-workspace";
import { runActionlintGate } from "./actionlint/gate.ts";
import { runGitleaksGate } from "./gitleaks/gate.ts";
import { assertOwnedProcessScopesSupported } from "./process.ts";
import {
  loadRepositorySecurityToolManifest,
  resolveSecurityToolTarget,
} from "./tool/manifest.ts";
import { installRepositorySecurityTools } from "./tool/runtime.ts";

interface RepositorySecurityLifecycle {
  cleanupStale: typeof cleanupStale;
  create: typeof create;
}

type RepositorySecurityOperation = (
  workspaceRoot: string,
  runWorkspace: RunWorkspace,
) => Promise<void>;

const systemLifecycle: RepositorySecurityLifecycle = { cleanupStale, create };

async function executeRepositorySecurityGate(
  workspaceRoot: string,
  runWorkspace: RunWorkspace,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  assertOwnedProcessScopesSupported(platform);
  const root = resolve(workspaceRoot);
  const manifest = await loadRepositorySecurityToolManifest(root);
  const target = resolveSecurityToolTarget(platform, process.arch);
  const toolsRoot = runWorkspace.path("tools");
  const actionlintProbes = runWorkspace.path("probes", "actionlint");
  const gitleaksProbes = runWorkspace.path("probes", "gitleaks");
  await Promise.all([
    mkdir(toolsRoot, { recursive: true, mode: 0o700 }),
    mkdir(actionlintProbes, { recursive: true, mode: 0o700 }),
    mkdir(gitleaksProbes, { recursive: true, mode: 0o700 }),
  ]);
  const tools = await installRepositorySecurityTools(
    runWorkspace,
    manifest,
    target,
    toolsRoot,
  );
  await runActionlintGate(
    runWorkspace,
    root,
    actionlintProbes,
    tools.actionlint,
    tools.shellcheck,
  );
  await runGitleaksGate(runWorkspace, root, gitleaksProbes, tools.gitleaks);
}

async function runRepositorySecurityGateWithLifecycle(
  workspaceRoot: string,
  lifecycle: RepositorySecurityLifecycle,
  operation: RepositorySecurityOperation,
): Promise<void> {
  const staleReport = await lifecycle.cleanupStale();
  if (staleReport.failed.length > 0) {
    throw new Error(
      `repository security stale workspace cleanup failed: ${staleReport.failed
        .map((failure) => `${failure.rootName}:${failure.error}`)
        .join(", ")}`,
    );
  }
  const runWorkspace = await lifecycle.create({ handleSignals: true });
  let operationSucceeded = false;
  let operationFailure: unknown;
  try {
    await operation(workspaceRoot, runWorkspace);
    operationSucceeded = true;
  } catch (error) {
    operationFailure = error;
  }
  const report = await runWorkspace.close();
  if (report.state === "cleanup-failed") {
    throw new Error(
      `repository security temporary cleanup failed: ${report.error ?? "CLEANUP_FAILED"}`,
      { cause: operationFailure },
    );
  }
  const abortReason = runWorkspace.signal.reason;
  if (abortReason instanceof RunWorkspaceAbortedError) {
    throw abortReason;
  }
  if (!operationSucceeded) {
    throw operationFailure;
  }
}

async function runRepositorySecurityGate(workspaceRoot: string): Promise<void> {
  await runRepositorySecurityGateWithLifecycle(
    workspaceRoot,
    systemLifecycle,
    executeRepositorySecurityGate,
  );
}

export type { RepositorySecurityLifecycle, RepositorySecurityOperation };
export {
  executeRepositorySecurityGate,
  runRepositorySecurityGate,
  runRepositorySecurityGateWithLifecycle,
};
