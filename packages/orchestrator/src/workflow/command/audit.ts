import {
  type CommandObservationReceipt,
  observeCommand,
  recoverCommandOutput,
} from "@skizzles/command-supervisor";
import type { RunWorkspace } from "@skizzles/run-workspace";
import type {
  CommandAuditProfile,
  CommandScopeReceipt,
  WorkflowCommandAudit,
} from "../contract.ts";

export async function observeProfile(
  profile: CommandAuditProfile,
  workspace: RunWorkspace,
  ownedCwd: string,
  scope: CommandScopeReceipt,
): Promise<WorkflowCommandAudit | undefined> {
  let receipt: CommandObservationReceipt;
  try {
    receipt = await observeCommand({
      version: 1,
      argv: profile.argv,
      cwd: ownedCwd,
      env: profile.env,
      timeoutMilliseconds: profile.timeoutMilliseconds,
      maximumOutputBytes: profile.maximumOutputBytes,
      drainMilliseconds: profile.drainMilliseconds,
      signalGraceMilliseconds: profile.signalGraceMilliseconds,
      abortSignal: workspace.signal,
    });
  } catch {
    return;
  }
  if (
    receipt.outcome.kind !== "exited" ||
    receipt.outcome.exitCode === null ||
    !profile.allowedExitCodes.includes(receipt.outcome.exitCode) ||
    receipt.outcome.signal !== null ||
    receipt.outcome.failureCode !== null ||
    receipt.outcome.outputLimitStream !== null ||
    receipt.lifecycle.drain !== "complete" ||
    receipt.lifecycle.cleanup === "killed" ||
    !completeStream(receipt.stdout) ||
    !completeStream(receipt.stderr)
  ) {
    return;
  }
  let stderr: Uint8Array;
  try {
    stderr = recoverCommandOutput(receipt, "stderr");
    recoverCommandOutput(receipt, "stdout");
  } catch {
    return;
  }
  if (profile.stderr === "must-be-empty" && stderr.byteLength !== 0) return;
  const audit: WorkflowCommandAudit = Object.freeze({
    profileId: profile.id,
    receipt,
    stderrEvidence:
      profile.stderr === "evidence" ? Object.freeze(Array.from(stderr)) : null,
    scope,
    declaredTargetPaths: Object.freeze(
      scope.targets
        .map((target) => target.path)
        .filter((path) => profile.argv.includes(path)),
    ),
  });
  return audit;
}

function completeStream(stream: {
  readonly observedBytes: number;
  readonly retainedBytes: number;
  readonly truncated: boolean;
}): boolean {
  return (
    stream.truncated === false && stream.observedBytes === stream.retainedBytes
  );
}
