import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupLabLabels,
  type DockerRunner,
  destroyLabStack,
  runtimeFromLab,
} from "./docker.ts";
import { removeIfPresent } from "./files.ts";
import { withFileLock } from "./locks.ts";
import { runCommand } from "./process.ts";
import {
  activityLockPath,
  assertOwnerStateDirectory,
  assertReadyLabFilesystem,
  expectedLabRuntimeRoot,
  inspectTrustedLabRuntimeDirectories,
  labLockPath,
  listLabs,
  readLab,
  removeLabState,
  type StateRoots,
  writeLab,
} from "./state.ts";
import { recoverSyncTransactions } from "./sync.ts";
import type { LabMetadata } from "./types.ts";

type DestructionContext = {
  owner: string;
  roots: StateRoots;
  docker: DockerRunner;
  environment: NodeJS.ProcessEnv;
};

export async function destroyManagedLab(
  context: DestructionContext,
  id: string,
): Promise<{ labId: string; destroyed: boolean }> {
  let claimed: LabMetadata | undefined;
  const exists = await withFileLock(
    labLock(context, id),
    async () => {
      let lab: LabMetadata;
      try {
        lab = await readLab(context.roots, context.owner, id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      await assertDestroyFilesystem(context.roots, lab);
      lab.state = "destroying";
      lab.updatedAt = new Date().toISOString();
      await writeLab(context.roots, lab);
      claimed = lab;
      return true;
    },
    { attempts: 600, delayMs: 50 },
  );
  if (!(exists && claimed)) return { labId: id, destroyed: false };

  // Remove exact Docker resources before waiting on attached activity. This
  // terminates an attached exec without touching synchronization or files.
  await cleanupDockerResources(context, claimed);

  return await withFileLock(
    activityLock(context, id),
    async () =>
      await withFileLock(
        labLock(context, id),
        async () => {
          let lab: LabMetadata;
          try {
            lab = await readLab(context.roots, context.owner, id);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              return { labId: id, destroyed: false };
            }
            throw error;
          }
          const runtimePresent = await assertDestroyFilesystem(
            context.roots,
            lab,
          );
          await recoverLabSync(context.roots, lab);
          await cleanupDockerResources(context, lab);
          if (runtimePresent) {
            if (
              !(await inspectTrustedLabRuntimeDirectories(context.roots, lab, {
                canonicalMismatch: "unsafe-indirection",
                inspectWorkspace: false,
              }))
            ) {
              throw new Error("lab runtime directory changed during cleanup");
            }
            await removeIfPresent(lab.runtimeRoot, { recursive: true });
          }
          await assertOwnerStateDirectory(
            context.roots.stateRoot,
            lab.ownerKey,
            "owner state directory changed during cleanup",
            { canonicalMismatch: "unsafe-indirection" },
          );
          await removeLabState(context.roots.stateRoot, context.owner, id);
          return { labId: id, destroyed: true };
        },
        { attempts: 600, delayMs: 50 },
      ),
    { attempts: 600, delayMs: 50 },
  );
}

export async function destroyAllManagedLabs(
  context: DestructionContext,
  destroyLab: (
    id: string,
  ) => Promise<{ labId: string; destroyed: boolean }> = async (id) =>
    await destroyManagedLab(context, id),
): Promise<{ destroyed: number }> {
  const ids = (await listLabs(context.roots, context.owner)).map(
    (lab) => lab.id,
  );
  let destroyed = 0;
  for (const id of ids) {
    if ((await destroyLab(id)).destroyed) destroyed++;
  }
  return { destroyed };
}

export async function reconcileOwnerLabs(
  roots: StateRoots,
  owner: string,
): Promise<void> {
  const labs = await listLabs(roots, owner);
  for (const snapshot of labs) {
    if (snapshot.state !== "ready") continue;
    const unavailable = await readyRuntimeProblem(roots, snapshot);
    if (unavailable) await failReadyLab(roots, snapshot, unavailable);
  }
}

export async function recoverLabSync(
  roots: StateRoots,
  lab: LabMetadata,
): Promise<void> {
  if (
    lab.runtimeRoot !== expectedLabRuntimeRoot(roots, lab.owner, lab.id) ||
    lab.workspace !== join(lab.runtimeRoot, "workspace")
  ) {
    throw new Error("lab runtime containment is invalid");
  }
  try {
    if (!(await stat(lab.workspace)).isDirectory()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const journalDirectory = join(lab.runtimeRoot, "sync", lab.id, "journals");
  let journals: string[];
  try {
    journals = await readdir(journalDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (journals.length === 0) return;
  await assertSourceRepositoryIdentity(lab);
  await recoverSyncTransactions({
    stateRoot: lab.runtimeRoot,
    labId: lab.id,
    allowedTargetRoots: [lab.sourceRoot, lab.workspace],
  });
}

export async function assertSourceRepositoryIdentity(
  lab: LabMetadata,
): Promise<void> {
  const commonGit = (
    await runCommand(
      "git",
      [
        "-C",
        lab.sourceRoot,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { timeoutMs: 10_000 },
    )
  ).stdout
    .toString()
    .trim();
  const actual = createHash("sha256")
    .update(await realpath(commonGit))
    .digest("hex")
    .slice(0, 12);
  if (actual !== lab.repoHash) {
    throw new Error(
      "lab source repository identity no longer matches durable state",
    );
  }
}

export async function cleanupManagedLabDockerResources(
  lab: LabMetadata,
  docker: DockerRunner,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await cleanupLabLabels(
    lab,
    lab.modeKind === "dockerfile",
    docker,
    environment,
  );
}

async function cleanupDockerResources(
  context: DestructionContext,
  lab: LabMetadata,
): Promise<void> {
  if (lab.runtime) {
    await destroyLabStack(runtimeFromLab(lab), context.docker);
    return;
  }
  await cleanupManagedLabDockerResources(
    lab,
    context.docker,
    context.environment,
  );
}

async function failReadyLab(
  roots: StateRoots,
  snapshot: LabMetadata,
  problem: string,
): Promise<LabMetadata> {
  return await withFileLock(
    labLockPath(roots.stateRoot, snapshot.owner, snapshot.id),
    async () => {
      const current = await readLab(roots, snapshot.owner, snapshot.id);
      if (current.state !== "ready") return current;
      const stillUnavailable = await readyRuntimeProblem(roots, current);
      if (!stillUnavailable) return current;
      current.state = "failed";
      current.error = `${problem}; the disposable runtime was lost and the lab must be destroyed and recreated`;
      current.updatedAt = new Date().toISOString();
      await writeLab(roots, current);
      return current;
    },
  );
}

async function readyRuntimeProblem(
  roots: StateRoots,
  lab: LabMetadata,
): Promise<string | undefined> {
  try {
    await assertReadyLabFilesystem(roots, lab);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "runtime or workspace is missing";
    }
    return error instanceof Error ? error.message : String(error);
  }
}

async function assertDestroyFilesystem(
  roots: StateRoots,
  lab: LabMetadata,
): Promise<boolean> {
  await assertOwnerStateDirectory(
    roots.stateRoot,
    lab.ownerKey,
    "owner state directory is missing or unsafe",
    { canonicalMismatch: "unsafe-indirection" },
  );
  return await inspectTrustedLabRuntimeDirectories(roots, lab, {
    canonicalMismatch: "unsafe-indirection",
  });
}

function labLock(context: DestructionContext, id: string): string {
  return labLockPath(context.roots.stateRoot, context.owner, id);
}

function activityLock(context: DestructionContext, id: string): string {
  return activityLockPath(context.roots.stateRoot, context.owner, id);
}
