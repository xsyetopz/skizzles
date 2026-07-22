import { types } from "node:util";
import type {
  TaskWorktreeApprovalAuthorityRequest,
  TaskWorktreeApprovalBinding,
  TaskWorktreeDigest,
  TaskWorktreePromotionPermit,
  TaskWorktreeSession,
} from "../contract.ts";
import { digestTaskWorktreeValue } from "../digest.ts";
import { isTaskWorktreeDigest } from "./configuration/actions.ts";
import type { TaskWorktreeSessionBindings } from "./state.ts";

interface PermitState {
  readonly owner: object;
  readonly session: TaskWorktreeSession;
  readonly bindingDigest: TaskWorktreeDigest;
  readonly approvalDigest: TaskWorktreeDigest;
  consumed: boolean;
}

const permits = new WeakMap<object, PermitState>();

export function createApprovalBinding(
  bindings: TaskWorktreeSessionBindings,
  revalidationDigest: TaskWorktreeDigest,
): TaskWorktreeApprovalBinding | undefined {
  const run = bindings.latestRun;
  if (run === null) return;
  const material = Object.freeze({
    authorityId: bindings.summary.authorityId,
    taskId: bindings.input.taskId,
    requestDigest: bindings.input.requestDigest,
    repositoryId: bindings.input.repositoryId,
    rootIdentity: bindings.input.rootIdentity,
    treeDigest: bindings.input.treeDigest,
    baselineDigest: bindings.input.baselineDigest,
    preparationDigest: bindings.prepareDigest,
    candidateDigest: bindings.candidate.candidateDigest,
    diffDigest: bindings.candidate.diffReceipt.diffDigest,
    revalidationDigest,
    commitPlanDigest: bindings.candidate.commitReceipt.plan.planDigest,
    runDigest: run.digest,
    runProfileIds: run.profileIds,
    runOutcomeDigests: run.outcomeDigests,
    runReceiptDigest: run.receiptDigest,
  });
  return Object.freeze({
    ...material,
    bindingDigest: digestTaskWorktreeValue(material),
  });
}

export async function issuePromotionPermit(
  owner: object,
  session: TaskWorktreeSession,
  bindings: TaskWorktreeSessionBindings,
  binding: TaskWorktreeApprovalBinding,
  approvalEvidence: unknown,
): Promise<TaskWorktreePromotionPermit | undefined> {
  const request: TaskWorktreeApprovalAuthorityRequest = Object.freeze({
    authorityId: bindings.approvalAuthority.id,
    binding,
    approvalEvidence,
  });
  let raw: unknown;
  try {
    raw = await bindings.approvalAuthority.authorize(request);
  } catch {
    return;
  }
  const decision = parseDecision(raw, binding.bindingDigest);
  if (decision === undefined) return;
  const permit: TaskWorktreePromotionPermit = Object.freeze({
    schema: "skizzles.task-worktree/promotion-permit" as const,
    permitDigest: digestTaskWorktreeValue({
      bindingDigest: binding.bindingDigest,
      approvalDigest: decision.approvalDigest,
      authorityId: bindings.approvalAuthority.id,
    }),
  });
  permits.set(permit, {
    owner,
    session,
    bindingDigest: binding.bindingDigest,
    approvalDigest: decision.approvalDigest,
    consumed: false,
  });
  return permit;
}

export function consumePromotionPermit(
  owner: object,
  session: TaskWorktreeSession,
  permit: unknown,
  bindingDigest: TaskWorktreeDigest,
): TaskWorktreeDigest | undefined {
  if (typeof permit !== "object" || permit === null) return;
  const state = permits.get(permit);
  if (
    state === undefined ||
    state.owner !== owner ||
    state.session !== session ||
    state.bindingDigest !== bindingDigest ||
    state.consumed
  ) {
    return;
  }
  state.consumed = true;
  return state.approvalDigest;
}

function parseDecision(
  input: unknown,
  bindingDigest: TaskWorktreeDigest,
): Readonly<{ approvalDigest: TaskWorktreeDigest }> | undefined {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input) ||
    !Object.isFrozen(input) ||
    Reflect.ownKeys(input).length !== 3
  ) {
    return;
  }
  const status = dataValue(input, "status");
  const returnedBinding = dataValue(input, "bindingDigest");
  const approvalDigest = dataValue(input, "approvalDigest");
  if (
    status !== "approved" ||
    returnedBinding !== bindingDigest ||
    !isTaskWorktreeDigest(approvalDigest)
  ) {
    return;
  }
  return Object.freeze({ approvalDigest });
}

function dataValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}
