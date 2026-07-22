import { createCausalWorkflow } from "../workflow/causal/create.ts";
import type {
  EngineeringContinuationCancelResult,
  EngineeringDescribeResult,
  EngineeringPrepareResult,
  EngineeringWorkflow,
  EngineeringWorkflowResult,
} from "./contract.ts";
import { EngineeringCoordinator } from "./coordinator.ts";
import { parseEngineeringConfig } from "./input/parse.ts";

const invalidPrepare = Object.freeze({
  status: "rejected" as const,
  code: "INVALID_WORKFLOW_INPUT" as const,
  cleanup: null,
});
const workflows = new WeakSet<object>();

export function createEngineeringWorkflow(
  input: unknown,
): EngineeringWorkflowResult {
  try {
    const config = parseEngineeringConfig(input);
    if (config === undefined) return invalidConfig();
    const causal = createCausalWorkflow(config.causal);
    if (causal.status !== "accepted") return invalidConfig();
    const coordinator = new EngineeringCoordinator(config, causal.workflow);
    const workflow = publicWorkflow(coordinator);
    workflows.add(workflow);
    return {
      status: "accepted",
      workflow,
    };
  } catch {
    return invalidConfig();
  }
}

export function isEngineeringWorkflow(
  value: unknown,
): value is EngineeringWorkflow {
  return typeof value === "object" && value !== null && workflows.has(value);
}

function publicWorkflow(
  coordinator: EngineeringCoordinator,
): EngineeringWorkflow {
  return Object.freeze({
    describe: (input: unknown) =>
      safeCall<EngineeringDescribeResult>(() => coordinator.describe(input), {
        status: "rejected",
        code: "INVALID_WORKFLOW_INPUT",
      }),
    prepare: (input: unknown) =>
      safeCall<EngineeringPrepareResult>(
        () => coordinator.prepare(input),
        invalidPrepare,
      ),
    continue: (input: unknown) =>
      safeCall<EngineeringPrepareResult>(
        () => coordinator.continue(input),
        invalidPrepare,
      ),
    cancelContinuation: (input: unknown) =>
      safeCall<EngineeringContinuationCancelResult>(
        () => coordinator.cancelContinuation(input),
        { status: "rejected", code: "INVALID_WORKFLOW_INPUT" },
      ),
    approveAndPromote: (input: unknown) =>
      safeCall(() => coordinator.approveAndPromote(input), invalidPrepare),
    reject: (input: unknown) =>
      safeCall(() => coordinator.reject(input), invalidPrepare),
    recover: (input: unknown) =>
      safeCall(() => coordinator.recover(input), {
        status: "rejected" as const,
        code: "INVALID_WORKFLOW_INPUT" as const,
      }),
    retryCleanup: (input: unknown) =>
      safeCall(() => coordinator.retryCleanup(input), {
        status: "rejected" as const,
        code: "INVALID_WORKFLOW_INPUT" as const,
      }),
    resetContext: (input: unknown) =>
      safeCall(() => coordinator.resetContext(input), {
        status: "rejected" as const,
        code: "INVALID_CONTEXT_RESET_INPUT" as const,
      }),
    resumeContextReset: (input: unknown) =>
      safeCall(() => coordinator.resumeContextReset(input), {
        status: "rejected" as const,
        code: "INVALID_CONTEXT_RESET_INPUT" as const,
      }),
  });
}

async function safeCall<Result>(
  operation: () => Promise<Result>,
  fallback: Result,
): Promise<Result> {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}

function invalidConfig(): EngineeringWorkflowResult {
  return { status: "rejected", code: "INVALID_WORKFLOW_CONFIG" };
}
