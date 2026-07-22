import {
  createWorkspaceTransaction,
  type WorkspaceTransaction,
} from "@skizzles/workspace-publication";
import { TransactionApprovalBridge } from "../approval/bridge.ts";
import { WorkflowCoordinator } from "../coordinator.ts";
import { parseWorkflowConfig } from "./config.ts";
import type {
  CausalWorkflow,
  CausalWorkflowConfig,
  CausalWorkflowResult,
} from "./contract.ts";

const invalidWorkflowInput = Object.freeze({
  status: "rejected" as const,
  code: "INVALID_WORKFLOW_INPUT" as const,
});

const invalidWorkflowInputWithCleanup = Object.freeze({
  ...invalidWorkflowInput,
  cleanup: null,
});

export function createCausalWorkflow(input: unknown): CausalWorkflowResult {
  let config: CausalWorkflowConfig | undefined;
  try {
    config = parseWorkflowConfig(input);
  } catch {
    config = undefined;
  }
  if (config === undefined) {
    return { status: "rejected", code: "INVALID_WORKFLOW_CONFIG" };
  }
  const bridge = new TransactionApprovalBridge();
  const transaction = createTransaction(config, bridge);
  const coordinator = new WorkflowCoordinator(config, transaction, bridge);
  return {
    status: "accepted",
    workflow: createPublicWorkflow(coordinator),
  };
}

function createPublicWorkflow(
  coordinator: WorkflowCoordinator,
): CausalWorkflow {
  return Object.freeze({
    prepare: (value: unknown) =>
      safeWorkflowCall(
        () => coordinator.prepare(value),
        invalidWorkflowInputWithCleanup,
      ),
    approveAndPromote: (value: unknown) =>
      safeWorkflowCall(
        () => coordinator.approveAndPromote(value),
        invalidWorkflowInputWithCleanup,
      ),
    reject: (value: unknown) =>
      safeWorkflowCall(
        () => coordinator.reject(value),
        invalidWorkflowInputWithCleanup,
      ),
    recover: (value: unknown) =>
      safeWorkflowCall(() => coordinator.recover(value), invalidWorkflowInput),
    retryCleanup: (value: unknown) =>
      safeWorkflowCall(
        () => coordinator.retryCleanup(value),
        invalidWorkflowInput,
      ),
  });
}

async function safeWorkflowCall<Result>(
  operation: () => Promise<Result>,
  fallback: Result,
): Promise<Result> {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}

function createTransaction(
  config: CausalWorkflowConfig,
  bridge: TransactionApprovalBridge,
): WorkspaceTransaction {
  return createWorkspaceTransaction({
    destination: config.transaction.destination,
    leases: config.transaction.leases,
    approvals: {
      verifyAndConsume: (bindings) => bridge.verifyAndConsume(bindings),
    },
    ...(config.transaction.crashInjection === undefined
      ? {}
      : { crashInjection: config.transaction.crashInjection }),
  });
}
