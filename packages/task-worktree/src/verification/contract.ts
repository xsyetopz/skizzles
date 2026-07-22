import type { TaskWorktreeDigest } from "../digest.ts";
import type { CommandProfile } from "../sandbox/command-policy.ts";
import type { SandboxVerificationObjective } from "../sandbox/contract.ts";

export type TaskWorktreeVerificationObjective =
  | Readonly<{
      readonly kind: "original-tests";
      readonly structuralReceiptDigest: TaskWorktreeDigest;
      readonly containerImageDigest: TaskWorktreeDigest;
    }>
  | Extract<SandboxVerificationObjective, { kind: "mutation" }>
  | Extract<SandboxVerificationObjective, { kind: "property" }>
  | Extract<SandboxVerificationObjective, { kind: "coverage" }>;

export interface TaskWorktreeVerificationProfile {
  readonly id: string;
  readonly kind: "coverage" | "mutation" | "original-tests" | "property";
  readonly view: "baseline-tests" | "candidate";
  readonly profile: CommandProfile;
  readonly executable: "bun" | "git";
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly timeoutMilliseconds: number;
  readonly maximumOutputBytes: number;
  readonly drainMilliseconds: number;
  readonly signalGraceMilliseconds: number;
  readonly artifact: Readonly<{
    readonly schema: string;
    readonly relativePath: string;
    readonly maximumBytes: number;
  }>;
}

export interface TaskWorktreeVerificationArtifactReceipt {
  readonly schema: "skizzles.task-worktree/verification-artifact";
  readonly artifactSchema: string;
  readonly byteLength: number;
  readonly contentDigest: TaskWorktreeDigest;
  readonly objectiveDigest: TaskWorktreeDigest;
  readonly report: TaskWorktreeVerificationReport;
  readonly receiptDigest: TaskWorktreeDigest;
}

export type TaskWorktreeVerificationReport =
  | Readonly<{
      kind: "original-tests";
      outcome: "failed" | "passed";
      passedCount: number;
      failedCount: number;
      testIds: readonly string[];
      baselineTestManifestDigest: TaskWorktreeDigest;
      productionOverlayDigest: TaskWorktreeDigest;
      containerImageDigest: TaskWorktreeDigest;
      containerEvidenceDigest: TaskWorktreeDigest;
    }>
  | Readonly<{
      kind: "mutation";
      outcome: "failed" | "passed";
      inventoryDigest: TaskWorktreeDigest;
      outcomes: readonly Readonly<{
        mutantId: TaskWorktreeDigest;
        outcome: "invalid" | "killed" | "survived" | "timeout";
        evidenceDigest: TaskWorktreeDigest;
      }>[];
    }>
  | Readonly<{
      kind: "property";
      outcome: "failed" | "passed";
      seedScheduleDigest: TaskWorktreeDigest;
      requiredCaseCount: number;
      extremeVectorInventoryDigest: TaskWorktreeDigest;
      properties: readonly Readonly<{
        propertyId: string;
        nodeIds: readonly TaskWorktreeDigest[];
        branchIds: readonly TaskWorktreeDigest[];
        completed: true;
        executedCases: number;
        executedRandomCases: number;
        executedExtremeCases: number;
        executedExtremeVectorDigests: readonly TaskWorktreeDigest[];
        counterexampleDigest: TaskWorktreeDigest | null;
      }>[];
    }>
  | Readonly<{
      kind: "coverage";
      outcome: "failed" | "passed";
      nodes: readonly Readonly<{
        nodeId: TaskWorktreeDigest;
        hits: number;
        lines: readonly Readonly<{
          lineId: TaskWorktreeDigest;
          hits: number;
        }>[];
        branches: readonly Readonly<{
          branchId: TaskWorktreeDigest;
          hits: number;
        }>[];
      }>[];
    }>;

export interface TaskWorktreeVerificationReceipt {
  readonly schema: "skizzles.task-worktree/verification-receipt";
  readonly authorityId: string;
  readonly taskId: string;
  readonly taskEpochDigest: TaskWorktreeDigest;
  readonly requestDigest: TaskWorktreeDigest;
  readonly repositoryId: string;
  readonly rootIdentity: string;
  readonly treeDigest: TaskWorktreeDigest;
  readonly baselineDigest: TaskWorktreeDigest;
  readonly candidateDigest: TaskWorktreeDigest;
  readonly candidateManifestDigest: TaskWorktreeDigest;
  readonly baselineTestManifestDigest: TaskWorktreeDigest;
  readonly candidateTestManifestDigest: TaskWorktreeDigest;
  readonly specificationLockDigest: TaskWorktreeDigest;
  readonly view: "baseline-tests" | "candidate";
  readonly profileId: string;
  readonly profileKind: TaskWorktreeVerificationProfile["kind"];
  readonly commandDigest: TaskWorktreeDigest;
  readonly sandboxOutcomeDigest: TaskWorktreeDigest;
  readonly viewReceiptDigest: TaskWorktreeDigest;
  readonly artifactReceiptDigest: TaskWorktreeDigest;
  readonly executionReceiptDigest: TaskWorktreeDigest;
  readonly objective: SandboxVerificationObjective;
  readonly objectiveDigest: TaskWorktreeDigest;
  readonly isolation: Readonly<{
    readonly mechanism: "container-user-namespace";
    readonly containerImageDigest: TaskWorktreeDigest;
    readonly containerEvidenceDigest: TaskWorktreeDigest;
  }> | null;
  readonly artifact: TaskWorktreeVerificationArtifactReceipt;
  readonly receiptDigest: TaskWorktreeDigest;
}
