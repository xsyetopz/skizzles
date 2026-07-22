import { join, relative, sep } from "node:path";
import type {
  TaskWorktreeFailureCode,
  TaskWorktreeVerificationResult,
} from "../contract.ts";
import { digestTaskWorktreeValue } from "../digest.ts";
import { pathExists } from "../git/repository.ts";
import { validateSessionBindings } from "../lifecycle/candidate/validation.ts";
import {
  type TaskWorktreeSessionBindings,
  taskWorktreeSessionBindings,
} from "../lifecycle/state.ts";
import { sandboxVerificationObjectiveDigest } from "../sandbox/objective.ts";
import {
  prepareArtifactDestination,
  readVerificationArtifact,
} from "./artifact.ts";
import {
  materializeVerificationObjective,
  parseTaskWorktreeVerificationObjective,
} from "./objective.ts";
import {
  createVerificationReceipt,
  verificationReceiptState,
} from "./receipt.ts";
import { verificationView } from "./view.ts";

export async function executeVerification(
  owner: object,
  raw: unknown,
): Promise<TaskWorktreeVerificationResult> {
  const parsed = parseVerificationInput(raw);
  const bindings =
    parsed === undefined ? undefined : ownedBindings(owner, parsed.session);
  const profileId = parsed?.profileId;
  const requestedObjective = parseTaskWorktreeVerificationObjective(
    parsed?.objective,
  );
  if (
    bindings === undefined ||
    typeof profileId !== "string" ||
    requestedObjective === undefined
  )
    return rejected("INVALID_INPUT");
  const profile = bindings.verificationProfiles.find(
    (candidate) => candidate.id === profileId,
  );
  if (profile === undefined || profile.kind !== requestedObjective.kind)
    return rejected("VERIFICATION_REJECTED");
  if ((await validateSessionBindings(bindings)) === undefined)
    return rejected("CANDIDATE_REJECTED");
  const view = await verificationView(bindings, profile.view);
  if (view === undefined) return rejected("VERIFICATION_REJECTED");
  if (
    profile.kind === "original-tests" &&
    bindings.candidate.sandboxReceipt.mechanism !== "container-user-namespace"
  )
    return rejected("VERIFICATION_REJECTED");
  const containerEvidenceDigest = digestTaskWorktreeValue({
    mechanism: bindings.candidate.sandboxReceipt.mechanism,
    evidence: bindings.candidate.sandboxReceipt.evidence,
    attestationReceiptDigest: bindings.candidate.sandboxReceipt.receiptDigest,
  });
  const objective = materializeVerificationObjective(requestedObjective, {
    baselineTestManifestDigest:
      bindings.candidate.protection.baselineManifest.testDigest,
    productionOverlayDigest: view.receiptDigest,
    containerEvidenceDigest,
  });
  const objectiveDigest = sandboxVerificationObjectiveDigest(objective);
  const artifactTarget = join(
    bindings.writableRoot,
    profile.artifact.relativePath,
  );
  if (
    (await pathExists(artifactTarget)) ||
    !(await prepareArtifactDestination(
      bindings.writableRoot,
      profile.artifact.relativePath,
    ))
  )
    return rejected("VERIFICATION_REJECTED");
  const cwd = profile.cwd === "." ? view.root : join(view.root, profile.cwd);
  const fromRoot = relative(view.root, cwd);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`))
    return rejected("VERIFICATION_REJECTED");
  const execution = await bindings.sandbox.execute(
    Object.freeze({
      attestation: bindings.candidate.sandboxReceipt,
      command: Object.freeze({
        profile: profile.profile,
        executable: profile.executable,
        arguments: profile.arguments,
        cwd: profile.cwd,
      }),
      timeoutMilliseconds: profile.timeoutMilliseconds,
      maximumOutputBytes: profile.maximumOutputBytes,
      drainMilliseconds: profile.drainMilliseconds,
      signalGraceMilliseconds: profile.signalGraceMilliseconds,
      worktreeRoot: view.root,
      writeRoot: bindings.writableRoot,
      verificationObjective: objective,
      objectiveDigest,
    }),
  );
  if (execution.status !== "executed" || execution.receipt.exitCode !== 0)
    return rejected("VERIFICATION_REJECTED");
  const artifact = await readVerificationArtifact(
    bindings.writableRoot,
    profile,
    Object.freeze({ objective, objectiveDigest }),
  );
  if (artifact === undefined) return rejected("VERIFICATION_REJECTED");
  const currentView = await verificationView(bindings, profile.view);
  if (
    currentView === undefined ||
    currentView.root !== view.root ||
    currentView.receiptDigest !== view.receiptDigest
  )
    return rejected("VERIFICATION_REJECTED");
  const commandDigest = digestTaskWorktreeValue({
    profile: profile.profile,
    executable: profile.executable,
    arguments: profile.arguments,
    cwd: profile.cwd,
    limits: {
      timeoutMilliseconds: profile.timeoutMilliseconds,
      maximumOutputBytes: profile.maximumOutputBytes,
      drainMilliseconds: profile.drainMilliseconds,
      signalGraceMilliseconds: profile.signalGraceMilliseconds,
    },
  });
  const sandboxOutcomeDigest = digestTaskWorktreeValue(execution.receipt);
  const executionReceiptDigest = digestTaskWorktreeValue({
    profileId: profile.id,
    kind: profile.kind,
    objectiveDigest,
    candidateManifestDigest: bindings.candidate.candidateManifestDigest,
    viewReceiptDigest: view.receiptDigest,
    commandDigest,
    sandboxOutcomeDigest,
    artifactReceiptDigest: artifact.receiptDigest,
  });
  const receipt = createVerificationReceipt(
    Object.freeze({
      owner,
      session: bindings.session,
      profile,
      viewRoot: view.root,
      artifactRoot: bindings.writableRoot,
      artifact,
      objective,
      objectiveDigest,
    }),
    Object.freeze({
      authorityId: bindings.summary.authorityId,
      taskId: bindings.input.taskId,
      taskEpochDigest: bindings.input.taskEpochDigest,
      requestDigest: bindings.input.requestDigest,
      repositoryId: bindings.input.repositoryId,
      rootIdentity: bindings.input.rootIdentity,
      treeDigest: bindings.input.treeDigest,
      baselineDigest: bindings.input.baselineDigest,
      candidateDigest: bindings.candidate.candidateDigest,
      candidateManifestDigest: bindings.candidate.candidateManifestDigest,
      baselineTestManifestDigest:
        bindings.candidate.protection.baselineManifest.testDigest,
      candidateTestManifestDigest:
        bindings.candidate.protection.candidateManifest.testDigest,
      specificationLockDigest:
        bindings.candidate.protection.candidateManifest.specificationDigest,
      view: profile.view,
      profileId: profile.id,
      profileKind: profile.kind,
      commandDigest,
      sandboxOutcomeDigest,
      viewReceiptDigest: view.receiptDigest,
      artifactReceiptDigest: artifact.receiptDigest,
      executionReceiptDigest,
      objective,
      objectiveDigest,
      isolation:
        objective.kind === "original-tests"
          ? Object.freeze({
              mechanism: "container-user-namespace" as const,
              containerImageDigest: objective.containerImageDigest,
              containerEvidenceDigest: objective.containerEvidenceDigest,
            })
          : null,
    }),
  );
  bindings.verification.receipts.push(receipt);
  return Object.freeze({ status: "verified", receipt });
}

export async function verifyVerificationReceipt(
  owner: object,
  raw: unknown,
): Promise<boolean> {
  const parsed = parseInput(raw, "receipt");
  const bindings =
    parsed === undefined ? undefined : ownedBindings(owner, parsed.session);
  const receipt = parsed?.extra;
  if (bindings === undefined || receipt === undefined) return false;
  const state = verificationReceiptState(receipt);
  if (
    state === undefined ||
    state.owner !== owner ||
    state.session !== bindings.session ||
    !bindings.verification.receipts.includes(receipt as never)
  )
    return false;
  const view = await verificationView(bindings, state.profile.view);
  if (
    view === undefined ||
    view.root !== state.viewRoot ||
    view.receiptDigest !==
      (receipt as { viewReceiptDigest?: unknown }).viewReceiptDigest
  )
    return false;
  const artifact = await readVerificationArtifact(
    state.artifactRoot,
    state.profile,
    Object.freeze({
      objective: state.objective,
      objectiveDigest: state.objectiveDigest,
    }),
  );
  return (
    artifact !== undefined &&
    artifact.receiptDigest === state.artifact.receiptDigest &&
    state.artifact.receiptDigest ===
      (receipt as { artifactReceiptDigest?: unknown }).artifactReceiptDigest &&
    (receipt as { receiptDigest?: unknown }).receiptDigest ===
      digestTaskWorktreeValue(
        Object.fromEntries(
          Object.entries(receipt as object).filter(
            ([key]) => key !== "receiptDigest",
          ),
        ),
      )
  );
}

function parseVerificationInput(raw: unknown):
  | Readonly<{
      session: unknown;
      profileId: unknown;
      objective: unknown;
    }>
  | undefined {
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    !Object.isFrozen(raw) ||
    Reflect.ownKeys(raw).length !== 4 ||
    data(raw, "version") !== 1
  )
    return;
  return Object.freeze({
    session: data(raw, "session"),
    profileId: data(raw, "profileId"),
    objective: data(raw, "objective"),
  });
}

function ownedBindings(
  owner: object,
  session: unknown,
): TaskWorktreeSessionBindings | undefined {
  const bindings = taskWorktreeSessionBindings(session);
  return bindings !== undefined && bindings.owner === owner && !bindings.closed
    ? bindings
    : undefined;
}

function parseInput(
  raw: unknown,
  extraKey: "profileId" | "receipt",
): Readonly<{ session: unknown; extra: unknown }> | undefined {
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    !Object.isFrozen(raw) ||
    Reflect.ownKeys(raw).length !== 3
  )
    return;
  const version = data(raw, "version");
  const session = data(raw, "session");
  const extra = data(raw, extraKey);
  return version === 1 ? Object.freeze({ session, extra }) : undefined;
}

function data(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function rejected(
  code: TaskWorktreeFailureCode,
): Readonly<{ status: "rejected"; code: TaskWorktreeFailureCode }> {
  return Object.freeze({ status: "rejected", code });
}
