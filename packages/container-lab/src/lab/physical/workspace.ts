import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { readLab } from "../../state/lab/store.ts";
import type { StateRoots } from "../../state/layout.ts";
import type {
  PhysicalCandidateEvidence,
  PhysicalCandidateMeasurement,
  PhysicalCandidateTarget,
} from "./contract.ts";
import {
  candidateDigestOf,
  compareText,
  digestBytes,
  digestValue,
  targetSetDigestOf,
} from "./input.ts";

export interface CandidateWorkspaceInput {
  readonly roots: StateRoots;
  readonly owner: string;
  readonly labId: string;
  readonly ownerKey: string;
  readonly composeProject: string;
  readonly sourceRepositoryIdentity: string;
  readonly labUpdatedAt: string;
  readonly declarationDigest: string;
  readonly manifestDigest: string;
  readonly profileDigest: string;
  readonly provenanceDigest: string;
  readonly targets: readonly PhysicalCandidateTarget[];
}

export async function synchronizeCandidateWorkspace(
  input: CandidateWorkspaceInput,
): Promise<PhysicalCandidateEvidence> {
  const lab = await readLab(input.roots, input.owner, input.labId);
  if (
    lab.state !== "ready" ||
    lab.runtime === undefined ||
    lab.ownerKey !== input.ownerKey ||
    lab.composeProject !== input.composeProject ||
    lab.sourceRepositoryIdentity !== input.sourceRepositoryIdentity ||
    lab.updatedAt !== input.labUpdatedAt
  ) {
    throw new Error("candidate workspace identity changed");
  }
  const expectedWorkspace = resolve(lab.workspace);
  const workspace = await realpath(expectedWorkspace);
  const workspaceState = await lstat(expectedWorkspace);
  if (!workspaceState.isDirectory() || workspaceState.isSymbolicLink()) {
    throw new Error("candidate workspace is not an authentic directory");
  }
  const measurements: PhysicalCandidateMeasurement[] = [];
  for (const target of input.targets) {
    const destination = containedDestination(workspace, target.path);
    await ensureContainedParents(workspace, dirname(destination));
    await publishCandidate(destination, target.bytes);
    if ((await realpath(destination)) !== destination) {
      throw new Error("candidate destination rebound after publication");
    }
    const observed = await readNoFollow(destination);
    const observedDigest = digestBytes(observed);
    if (
      observed.length !== target.byteLength ||
      observedDigest !== target.digest ||
      !sameBytes(observed, target.bytes)
    ) {
      throw new Error("candidate bytes drifted after workspace publication");
    }
    measurements.push(
      Object.freeze({
        path: target.path,
        digest: observedDigest,
        byteLength: observed.length,
      }),
    );
  }
  measurements.sort((left, right) => compareText(left.path, right.path));
  const targets = Object.freeze(measurements);
  const candidateDigest = candidateDigestOf(targets);
  const targetSetDigest = targetSetDigestOf(targets);
  const workspaceIdentityDigest = digestValue({
    owner: lab.owner,
    ownerKey: lab.ownerKey,
    labId: lab.id,
    composeProject: lab.composeProject,
    sourceRepositoryIdentity: lab.sourceRepositoryIdentity,
    labUpdatedAt: lab.updatedAt,
    workspacePathDigest: digestValue(workspace),
  });
  const provenanceMeasurementDigest = digestValue({
    declarationDigest: input.declarationDigest,
    manifestDigest: input.manifestDigest,
    profileDigest: input.profileDigest,
    declaredProvenanceDigest: input.provenanceDigest,
    workspaceIdentityDigest,
    targetSetDigest,
    candidateDigest,
  });
  return Object.freeze({
    targetSetDigest,
    candidateDigest,
    workspaceIdentityDigest,
    provenanceMeasurementDigest,
    targets,
  });
}

async function publishCandidate(
  destination: string,
  bytes: readonly number[],
): Promise<void> {
  const existing = await lstat(destination).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  });
  if (
    existing !== undefined &&
    (!existing.isFile() || existing.isSymbolicLink())
  ) {
    throw new Error("candidate destination is not a regular file");
  }
  const temporary = join(
    dirname(destination),
    `.codex-candidate-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(Uint8Array.from(bytes));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readNoFollow(path: string): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = await handle.stat();
    if (!state.isFile() || state.nlink !== 1) {
      throw new Error("candidate destination changed identity");
    }
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

async function ensureContainedParents(
  workspace: string,
  destinationParent: string,
): Promise<void> {
  const relativeParent = relative(workspace, destinationParent);
  if (
    relativeParent === ".." ||
    relativeParent.startsWith(`..${sep}`) ||
    resolve(workspace, relativeParent) !== destinationParent
  ) {
    throw new Error("candidate parent escapes workspace");
  }
  let current = workspace;
  for (const segment of relativeParent.split(sep).filter(Boolean)) {
    current = join(current, segment);
    await mkdir(current).catch((error: unknown) => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
    const state = await lstat(current);
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new Error("candidate parent is not a real directory");
    }
  }
  const observed = await realpath(destinationParent);
  if (observed !== destinationParent) {
    throw new Error("candidate parent rebound through a link");
  }
}

function containedDestination(workspace: string, path: string): string {
  const destination = resolve(workspace, ...path.split("/"));
  const relativePath = relative(workspace, destination);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    resolve(workspace, relativePath) !== destination
  ) {
    throw new Error("candidate path escapes workspace");
  }
  return destination;
}

function sameBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor !== undefined && "value" in descriptor
    ? String(descriptor.value)
    : undefined;
}
