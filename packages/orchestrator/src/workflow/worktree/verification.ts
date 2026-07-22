import {
  isTaskWorktreeVerificationReceipt,
  type TaskWorktree,
  type TaskWorktreeReceipt,
  type TaskWorktreeSession,
  type TaskWorktreeVerificationObjective,
  type TaskWorktreeVerificationReceipt,
} from "@skizzles/task-worktree";
import type { Orchestrator } from "../../runtime.ts";
import type { ExecutionSession } from "../../state/execution.ts";
import type {
  WorkflowTaskVerificationBindings,
  WorkflowTaskVerificationReceipts,
  WorkflowVerificationObjectives,
  WorkflowVerificationProfileIds,
} from "../verification/task-contract.ts";

const maximumProfileIdLength = 128;
const profileIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;

type VerificationKind = TaskWorktreeVerificationReceipt["profileKind"];
type VerificationView = TaskWorktreeVerificationReceipt["view"];

interface VerificationExpectation {
  readonly id: string;
  readonly kind: VerificationKind;
  readonly view: VerificationView;
}

export type WorkflowTaskVerificationResult =
  | Readonly<{
      status: "verified";
      receipts: WorkflowTaskVerificationReceipts;
      execution: ExecutionSession;
    }>
  | Readonly<{
      status: "rejected";
      code: "EXECUTION_BUDGET_REJECTED" | "TASK_WORKTREE_REJECTED";
      execution: ExecutionSession;
    }>;

export interface ExecuteWorkflowTaskVerificationInput {
  readonly taskWorktree: TaskWorktree;
  readonly orchestrator: Orchestrator;
  readonly session: TaskWorktreeSession;
  readonly taskReceipt: TaskWorktreeReceipt;
  readonly bindings: WorkflowTaskVerificationBindings;
  readonly profileIds: WorkflowVerificationProfileIds;
  readonly execution: ExecutionSession;
  readonly objectives: WorkflowVerificationObjectives;
}

export interface RevalidateWorkflowTaskVerificationInput {
  readonly taskWorktree: TaskWorktree;
  readonly session: TaskWorktreeSession;
  readonly taskReceipt: TaskWorktreeReceipt;
  readonly bindings: WorkflowTaskVerificationBindings;
  readonly profileIds: WorkflowVerificationProfileIds;
  readonly receipts: WorkflowTaskVerificationReceipts;
}

export async function executeWorkflowTaskVerification(
  input: ExecuteWorkflowTaskVerificationInput,
): Promise<WorkflowTaskVerificationResult> {
  const expectations = verificationExpectations(input.profileIds);
  if (expectations === undefined) {
    return rejected("TASK_WORKTREE_REJECTED", input.execution);
  }
  const receipts: TaskWorktreeVerificationReceipt[] = [];
  let execution = input.execution;
  for (const expectation of expectations) {
    // Verification is deliberately causal: later profiles must not run after an
    // earlier objective or execution-budget failure.
    const result = await input.taskWorktree.executeVerification(
      Object.freeze({
        version: 1 as const,
        session: input.session,
        profileId: expectation.id,
        objective: objectiveFor(input.objectives, expectation.kind),
      }),
    );
    if (
      result.status !== "verified" ||
      !isTaskWorktreeVerificationReceipt(result.receipt) ||
      !verificationBinds(
        result.receipt,
        input.taskReceipt,
        input.bindings,
        expectation,
        objectiveFor(input.objectives, expectation.kind),
      ) ||
      !(await verifies(input.taskWorktree, input.session, result.receipt))
    ) {
      return rejected("TASK_WORKTREE_REJECTED", execution);
    }
    const recorded = input.orchestrator.recordExecution({
      execution,
      kind: "action",
    });
    if (recorded.status !== "accepted") {
      return rejected("EXECUTION_BUDGET_REJECTED", execution);
    }
    ({ execution } = recorded);
    receipts.push(result.receipt);
  }
  const [originalTests, mutation, property, coverage] = receipts;
  if (
    originalTests === undefined ||
    mutation === undefined ||
    property === undefined ||
    coverage === undefined
  ) {
    return rejected("TASK_WORKTREE_REJECTED", execution);
  }
  return Object.freeze({
    status: "verified" as const,
    receipts: Object.freeze({
      originalTests,
      mutation,
      property,
      coverage,
      ordered: Object.freeze([...receipts]),
      objectives: input.objectives,
    }),
    execution,
  });
}

function objectiveFor(
  objectives: WorkflowVerificationObjectives,
  kind: VerificationKind,
): TaskWorktreeVerificationObjective {
  if (kind === "original-tests") return objectives.originalTests;
  if (kind === "mutation") return objectives.mutation;
  if (kind === "property") return objectives.property;
  return objectives.coverage;
}

export async function revalidateWorkflowTaskVerification(
  input: RevalidateWorkflowTaskVerificationInput,
): Promise<boolean> {
  const expectations = verificationExpectations(input.profileIds);
  if (
    expectations === undefined ||
    input.receipts.ordered.length !== expectations.length ||
    input.receipts.ordered[0] !== input.receipts.originalTests ||
    input.receipts.ordered[1] !== input.receipts.mutation ||
    input.receipts.ordered[2] !== input.receipts.property ||
    input.receipts.ordered[3] !== input.receipts.coverage
  ) {
    return false;
  }
  for (const [index, expectation] of expectations.entries()) {
    const receipt = input.receipts.ordered[index];
    if (
      receipt === undefined ||
      !isTaskWorktreeVerificationReceipt(receipt) ||
      !verificationBinds(
        receipt,
        input.taskReceipt,
        input.bindings,
        expectation,
        objectiveFor(input.receipts.objectives, expectation.kind),
      ) ||
      // Revalidation is ordered to fail closed before invoking later profiles.
      !(await verifies(input.taskWorktree, input.session, receipt))
    ) {
      return false;
    }
  }
  return true;
}

function verificationExpectations(
  profileIds: WorkflowVerificationProfileIds,
): readonly VerificationExpectation[] | undefined {
  const values = [
    profileIds.originalTests,
    profileIds.mutation,
    profileIds.property,
    profileIds.coverage,
  ];
  if (
    values.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > maximumProfileIdLength ||
        !profileIdPattern.test(value),
    ) ||
    new Set(values).size !== values.length
  ) {
    return;
  }
  return Object.freeze([
    Object.freeze({
      id: profileIds.originalTests,
      kind: "original-tests" as const,
      view: "baseline-tests" as const,
    }),
    Object.freeze({
      id: profileIds.mutation,
      kind: "mutation" as const,
      view: "candidate" as const,
    }),
    Object.freeze({
      id: profileIds.property,
      kind: "property" as const,
      view: "candidate" as const,
    }),
    Object.freeze({
      id: profileIds.coverage,
      kind: "coverage" as const,
      view: "candidate" as const,
    }),
  ]);
}

function verificationBinds(
  receipt: TaskWorktreeVerificationReceipt,
  taskReceipt: TaskWorktreeReceipt,
  bindings: WorkflowTaskVerificationBindings,
  expectation: VerificationExpectation,
  objective: TaskWorktreeVerificationObjective,
): boolean {
  return (
    receipt.authorityId === taskReceipt.authorityId &&
    receipt.taskId === taskReceipt.taskId &&
    receipt.taskId === bindings.taskId &&
    receipt.taskEpochDigest === taskReceipt.taskEpochDigest &&
    receipt.taskEpochDigest === bindings.taskEpochDigest &&
    receipt.requestDigest === bindings.requestDigest &&
    receipt.repositoryId === bindings.repositoryId &&
    receipt.rootIdentity === bindings.rootIdentity &&
    receipt.treeDigest === bindings.treeDigest &&
    receipt.baselineDigest === bindings.baselineDigest &&
    receipt.candidateDigest === taskReceipt.candidateDigest &&
    receipt.candidateManifestDigest === taskReceipt.candidateManifestDigest &&
    receipt.baselineTestManifestDigest ===
      taskReceipt.baselineTestManifestDigest &&
    receipt.candidateTestManifestDigest ===
      taskReceipt.candidateTestManifestDigest &&
    receipt.specificationLockDigest === taskReceipt.specificationLockDigest &&
    receipt.profileId === expectation.id &&
    receipt.profileKind === expectation.kind &&
    receipt.view === expectation.view &&
    objectiveBinds(receipt, objective)
  );
}

function objectiveBinds(
  receipt: TaskWorktreeVerificationReceipt,
  objective: TaskWorktreeVerificationObjective,
): boolean {
  if (
    receipt.objective.kind !== objective.kind ||
    receipt.objective.structuralReceiptDigest !==
      objective.structuralReceiptDigest ||
    receipt.artifact.objectiveDigest !== receipt.objectiveDigest
  ) {
    return false;
  }
  if (objective.kind === "original-tests") {
    return (
      receipt.objective.kind === "original-tests" &&
      receipt.objective.containerImageDigest === objective.containerImageDigest
    );
  }
  return JSON.stringify(receipt.objective) === JSON.stringify(objective);
}

async function verifies(
  taskWorktree: TaskWorktree,
  session: TaskWorktreeSession,
  receipt: TaskWorktreeVerificationReceipt,
): Promise<boolean> {
  try {
    return (
      (await taskWorktree.verifyVerificationReceipt(
        Object.freeze({ version: 1 as const, session, receipt }),
      )) === true
    );
  } catch {
    return false;
  }
}

function rejected(
  code: "EXECUTION_BUDGET_REJECTED" | "TASK_WORKTREE_REJECTED",
  execution: ExecutionSession,
): WorkflowTaskVerificationResult {
  return Object.freeze({ status: "rejected" as const, code, execution });
}
