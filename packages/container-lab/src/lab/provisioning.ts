import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { internalImageTag } from "../compose/generation.ts";
import { loadLabConfig } from "../config.ts";
import {
  cleanupLabLabels,
  type DockerRunner,
  destroyLabStack,
  prepareLabRuntime,
  provisionLabStack,
} from "../docker.ts";
import { withFileLock } from "../locks.ts";
import { runCommand } from "../process.ts";
import { listLabs, readLab, writeLab } from "../state/lab-store.ts";
import {
  labLockPath,
  ownerLockPath,
  ownerRuntimeDirectory,
  type StateRoots,
} from "../state/layout.ts";
import { ensureOwner, readReapedOwner } from "../state/owner-store.ts";
import {
  applySync,
  initializeSyncBaseline,
  previewSync,
  recoverSyncTransactions,
} from "../sync/service.ts";
import type { LabMetadata } from "../types.ts";

const LAB_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

type ProvisioningContext = {
  owner: string;
  roots: StateRoots;
  docker: DockerRunner;
  environment: NodeJS.ProcessEnv;
  reconcileOwner: () => Promise<void>;
};

export async function createProvisionedLab(
  context: ProvisioningContext,
  name: string,
  source: string,
  signal?: AbortSignal,
): Promise<{ labId: string; state: LabMetadata["state"] }> {
  const requested = name.trim().toLowerCase();
  if (!LAB_NAME.test(requested)) {
    throw new Error(
      "name must use 1..32 lowercase letters, numbers, or hyphens",
    );
  }
  return await withFileLock(
    ownerLockPath(context.roots.stateRoot, context.owner),
    async () => {
      if (await readReapedOwner(context.roots.stateRoot, context.owner)) {
        throw new Error(
          "owner was archived and reaped; refusing to recreate its resources",
        );
      }
      await ensureOwner(context.roots.stateRoot, context.owner);
      await context.reconcileOwner();
      const existing = await listLabs(context.roots, context.owner);
      if (existing.length >= 8) {
        throw new Error("an owner may have at most 8 labs");
      }
      const sourceRoot = (
        await runCommand(
          "git",
          ["-C", source, "rev-parse", "--show-toplevel"],
          {
            timeoutMs: 10_000,
          },
        )
      ).stdout
        .toString()
        .trim();
      const commonGit = (
        await runCommand(
          "git",
          [
            "-C",
            sourceRoot,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ],
          { timeoutMs: 10_000 },
        )
      ).stdout
        .toString()
        .trim();
      const repoHash = createHash("sha256")
        .update(await realpath(commonGit))
        .digest("hex")
        .slice(0, 12);
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      const id = `${requested}-${suffix}`;
      const runtimeRoot = join(
        ownerRuntimeDirectory(context.roots.runtimeRoot, context.owner),
        id,
      );
      const lab: LabMetadata = {
        version: 1,
        id,
        name: requested,
        owner: context.owner,
        ownerKey: createHash("sha256").update(context.owner).digest("hex"),
        repoHash,
        composeProject: `ccl-${repoHash.slice(0, 8)}-${suffix}`,
        state: "provisioning",
        sourceRoot,
        runtimeRoot,
        workspace: join(runtimeRoot, "workspace"),
        manifestPath: join(sourceRoot, ".codex-container-lab.yaml"),
        commandService: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        endpoints: [],
        findings: [],
        secretEnvironment: [],
      };
      await withFileLock(
        labLockPath(context.roots.stateRoot, context.owner, id),
        async () => await writeLab(context.roots, lab),
      );
      await provisionLab(context, id, signal);
      const final = await readLab(context.roots, context.owner, id);
      return { labId: final.id, state: final.state };
    },
  );
}

async function provisionLab(
  context: ProvisioningContext,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  let lab = await readLab(context.roots, context.owner, id);
  let runtime: Awaited<ReturnType<typeof prepareLabRuntime>> | undefined;
  let dockerMaterializationStarted = false;
  let provisioningEnvironment: NodeJS.ProcessEnv | undefined;
  let secretEnvironmentNames: string[] = [];
  let failure: unknown;
  try {
    await assertProvisioning(context, id, signal);
    await mkdir(lab.runtimeRoot, { recursive: true, mode: 0o700 });
    const config = await loadLabConfig(lab.sourceRoot);
    secretEnvironmentNames = [...config.secretEnvironment];
    lab.manifestPath = config.manifestPath;
    lab.commandService = config.mode.commandService;
    lab.modeKind = config.mode.kind;
    lab.secretEnvironment = secretEnvironmentNames;
    if (config.mode.kind === "dockerfile") {
      lab.managedImage = internalImageTag(lab.ownerKey, lab.id);
    }
    lab = await updateProvisioning(context, id, (current) => {
      current.manifestPath = lab.manifestPath;
      current.commandService = lab.commandService;
      current.modeKind = config.mode.kind;
      current.secretEnvironment = [...lab.secretEnvironment];
      if (lab.managedImage === undefined) {
        delete current.managedImage;
      } else {
        current.managedImage = lab.managedImage;
      }
    });
    provisioningEnvironment = resolveProvisioningEnvironment(
      secretEnvironmentNames,
      context.environment,
    );
    await assertProvisioning(context, id, signal);
    const head = (
      await runCommand("git", ["-C", lab.sourceRoot, "rev-parse", "HEAD"], {
        timeoutMs: 10_000,
        ...(signal === undefined ? {} : { signal }),
      })
    ).stdout
      .toString()
      .trim();
    await runCommand(
      "git",
      [
        "clone",
        "--no-checkout",
        "--no-tags",
        "--no-hardlinks",
        lab.sourceRoot,
        lab.workspace,
      ],
      {
        timeoutMs: 120_000,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    await runCommand(
      "git",
      ["-C", lab.workspace, "remote", "remove", "origin"],
      {
        timeoutMs: 10_000,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    await runCommand(
      "git",
      ["-C", lab.workspace, "checkout", "--detach", head],
      {
        timeoutMs: 120_000,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    await assertProvisioning(context, id, signal);
    const identity = { stateRoot: lab.runtimeRoot, labId: lab.id };
    await initializeSyncBaseline(identity, lab.workspace);
    const seed = await previewSync({
      ...identity,
      direction: "push",
      sourceRoot: lab.sourceRoot,
      targetRoot: lab.workspace,
    });
    if (seed.conflicts.length > 0) {
      throw new Error(
        "initial workspace synchronization unexpectedly conflicted",
      );
    }
    await applySync({
      ...identity,
      direction: "push",
      token: seed.token,
      sourceRoot: lab.sourceRoot,
      targetRoot: lab.workspace,
      idleGuard: () => true,
    });
    await recoverSyncTransactions({
      ...identity,
      allowedTargetRoots: [lab.sourceRoot, lab.workspace],
    });
    await assertProvisioning(context, id, signal);
    dockerMaterializationStarted = true;
    runtime = await prepareLabRuntime(
      lab,
      config,
      context.docker,
      provisioningEnvironment,
    );
    lab.findings = runtime.findings;
    const persistedRuntime = {
      config: runtime.config,
      composeArgs: runtime.composeArgs,
      ...(runtime.baseFile === undefined ? {} : { baseFile: runtime.baseFile }),
      overrideFile: runtime.overrideFile,
      findings: runtime.findings,
    };
    lab.runtime = persistedRuntime;
    lab = await updateProvisioning(context, id, (current) => {
      current.findings = lab.findings;
      current.runtime = persistedRuntime;
    });
    await assertProvisioning(context, id, signal);
    lab.endpoints = await provisionLabStack(
      runtime,
      signal,
      context.docker,
      provisioningEnvironment,
    );
    await assertProvisioning(context, id, signal);
  } catch (error) {
    failure = error;
    if (runtime) {
      await destroyLabStack(runtime, context.docker).catch(() => undefined);
    } else if (dockerMaterializationStarted) {
      await cleanupLabLabels(
        lab,
        lab.modeKind === "dockerfile",
        context.docker,
        provisioningEnvironment,
      ).catch(() => undefined);
    }
  }
  await withFileLock(
    labLockPath(context.roots.stateRoot, context.owner, id),
    async () => {
      let current: LabMetadata;
      try {
        current = await readLab(context.roots, context.owner, id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return;
        }
        throw error;
      }
      if (current.state !== "provisioning") {
        return;
      }
      current = { ...current, ...lab };
      current.state = failure ? "failed" : "ready";
      if (failure) {
        current.error = compactError(failure);
      } else {
        delete current.error;
      }
      current.updatedAt = new Date().toISOString();
      await writeLab(context.roots, current);
    },
    { attempts: 600, delayMs: 50 },
  );
}

async function assertProvisioning(
  context: ProvisioningContext,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new Error("lab provisioning was cancelled");
  }
  const current = await readLab(context.roots, context.owner, id);
  if (current.state !== "provisioning") {
    throw new Error("lab provisioning was cancelled");
  }
}

async function updateProvisioning(
  context: ProvisioningContext,
  id: string,
  mutate: (lab: LabMetadata) => void,
): Promise<LabMetadata> {
  return await withFileLock(
    labLockPath(context.roots.stateRoot, context.owner, id),
    async () => {
      const current = await readLab(context.roots, context.owner, id);
      if (current.state !== "provisioning") {
        throw new Error("lab provisioning was cancelled");
      }
      mutate(current);
      current.updatedAt = new Date().toISOString();
      await writeLab(context.roots, current);
      return current;
    },
    { attempts: 600, delayMs: 50 },
  );
}

function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .split("\n")
    .slice(-8)
    .join("\n")
    .slice(-4000);
}

function resolveProvisioningEnvironment(
  names: readonly string[],
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const resolved = { ...environment };
  for (const name of names) {
    delete resolved[name];
    if (
      !Object.hasOwn(environment, name) ||
      typeof environment[name] !== "string"
    ) {
      throw new Error(`secret environment variable is unavailable: ${name}`);
    }
    resolved[name] = environment[name];
  }
  return resolved;
}
