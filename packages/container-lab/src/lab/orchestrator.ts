import process from "node:process";
import {
  type DockerRunner,
  defaultDockerRunner,
  dockerAvailable,
  runtimeFromLab,
  stackLogs,
  stackStatus,
} from "../docker.ts";
import { withFileLock } from "../locks.ts";
import { redactPublicText } from "../public/output.ts";
import type { LabMetadata } from "../state/lab/contract.ts";
import { listLabs, readLab } from "../state/lab/store.ts";
import {
  activityLockPath,
  labLockPath,
  resolveRoots,
  type StateRoots,
} from "../state/layout.ts";
import {
  applySync,
  previewSync,
  publicSyncPreview,
  type SyncDirection,
} from "../sync/api.ts";
import {
  type RunOutput,
  runAttachedCommand,
  validateAttachedRunRequest,
} from "./attached-run.ts";
import {
  assertSourceRepositoryIdentity,
  destroyAllManagedLabs,
  destroyManagedLab,
  reconcileOwnerLabs,
  recoverLabSync as recoverManagedLabSync,
} from "./destruction.ts";
import { createProvisionedLab } from "./provisioning.ts";

export type { RunOutput } from "./attached-run.ts";

export async function recoverLabSync(
  roots: StateRoots,
  lab: LabMetadata,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await recoverManagedLabSync(roots, lab, environment);
}

export class ContainerLabService {
  readonly owner: string;
  readonly roots: StateRoots;
  private readonly docker: DockerRunner;
  private readonly environment: NodeJS.ProcessEnv;
  constructor(
    owner: string,
    roots = resolveRoots(),
    docker: DockerRunner = defaultDockerRunner,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.owner = owner;
    this.roots = roots;
    this.docker = docker;
    this.environment = environment;
  }

  async health(): Promise<{
    ok: true;
    dockerAvailable: boolean;
    labs: number;
  }> {
    await this.reconcileOwner();
    const labs = await listLabs(this.roots, this.owner);
    return {
      ok: true,
      dockerAvailable: await dockerAvailable(
        this.docker,
        this.environment,
      ).catch(() => false),
      labs: labs.length,
    };
  }

  async createLab(
    name = "lab",
    source = process.cwd(),
    signal?: AbortSignal,
  ): Promise<{ labId: string; state: LabMetadata["state"] }> {
    return await createProvisionedLab(
      {
        owner: this.owner,
        roots: this.roots,
        docker: this.docker,
        environment: this.environment,
        reconcileOwner: async () => await this.reconcileOwner(),
      },
      name,
      source,
      signal,
    );
  }

  async listLabs(): Promise<{
    labs: Array<{
      labId: string;
      name: string;
      state: LabMetadata["state"];
      updatedAt: string;
    }>;
  }> {
    await this.reconcileOwner();
    const labs = await listLabs(this.roots, this.owner);
    return {
      labs: labs.map((lab) => ({
        labId: lab.id,
        name: lab.name,
        state: lab.state,
        updatedAt: lab.updatedAt,
      })),
    };
  }

  async labStatus(id: string): Promise<unknown> {
    await this.reconcileOwner();
    const lab = await readLab(this.roots, this.owner, id);
    return compactLabStatus(
      lab,
      lab.state === "ready" && lab.runtime
        ? await stackStatus(runtimeFromLab(lab), this.docker, this.environment)
        : undefined,
    );
  }

  async run(
    id: string,
    argv: string[],
    // biome-ignore lint/style/useDefaultParameterLast: Parameter order is part of the existing public call contract.
    cwd = ".",
    // biome-ignore lint/style/useDefaultParameterLast: Parameter order is part of the existing public call contract.
    environment: Record<string, string> = {},
    // biome-ignore lint/style/useDefaultParameterLast: Parameter order is part of the existing public call contract.
    timeoutSeconds = 1800,
    output: RunOutput,
    signal?: AbortSignal,
  ): Promise<number> {
    validateAttachedRunRequest(argv, cwd, environment, timeoutSeconds);
    await this.reconcileOwner();
    return await runAttachedCommand(
      {
        owner: this.owner,
        roots: this.roots,
        docker: this.docker,
        environment: this.environment,
      },
      id,
      argv,
      cwd,
      environment,
      timeoutSeconds,
      output,
      signal,
    );
  }

  async logs(id: string, service: string, tailLines: number): Promise<unknown> {
    await this.reconcileOwner();
    const lab = await this.requireReady(id);
    const transcript = await stackLogs(
      runtimeFromLab(lab),
      service,
      tailLines,
      this.docker,
      this.environment,
    );
    return {
      labId: id,
      service,
      transcript: {
        ...transcript,
        bytes: Buffer.byteLength(transcript.text),
        lines: transcript.text ? transcript.text.split("\n").length : 0,
      },
    };
  }

  async preview(id: string, direction: SyncDirection) {
    await this.reconcileOwner();
    return await withFileLock(
      this.activityLock(id),
      async () => {
        return await withFileLock(
          this.labLock(id),
          async () => {
            const lab = await this.requireReady(id);
            await assertSourceRepositoryIdentity(lab, this.environment);
            await recoverManagedLabSync(this.roots, lab, this.environment);
            const sourceRoot =
              direction === "push" ? lab.sourceRoot : lab.workspace;
            const targetRoot =
              direction === "push" ? lab.workspace : lab.sourceRoot;
            const preview = await previewSync({
              stateRoot: lab.runtimeRoot,
              labId: lab.id,
              direction,
              sourceRoot,
              targetRoot,
              maxEntries: 100,
              environment: this.environment,
            });
            return publicSyncPreview(preview, id, direction);
          },
          { attempts: 600, delayMs: 50 },
        );
      },
      { attempts: 600, delayMs: 50 },
    );
  }

  async apply(id: string, direction: SyncDirection, token: string) {
    await this.reconcileOwner();
    return await withFileLock(
      this.activityLock(id),
      async () => {
        return await withFileLock(
          this.labLock(id),
          async () => {
            const lab = await this.requireReady(id);
            await assertSourceRepositoryIdentity(lab, this.environment);
            await recoverManagedLabSync(this.roots, lab, this.environment);
            const sourceRoot =
              direction === "push" ? lab.sourceRoot : lab.workspace;
            const targetRoot =
              direction === "push" ? lab.workspace : lab.sourceRoot;
            const result = await applySync({
              stateRoot: lab.runtimeRoot,
              labId: lab.id,
              direction,
              token,
              sourceRoot,
              targetRoot,
              idleGuard: () => true,
              environment: this.environment,
            });
            return { labId: id, direction, applied: result.applied };
          },
          { attempts: 600, delayMs: 50 },
        );
      },
      { attempts: 600, delayMs: 50 },
    );
  }

  async destroyLab(id: string): Promise<{ labId: string; destroyed: boolean }> {
    return await destroyManagedLab(this.domainContext(), id);
  }

  async destroyAll(): Promise<{ destroyed: number }> {
    return await destroyAllManagedLabs(
      this.domainContext(),
      async (id) => await this.destroyLab(id),
    );
  }

  private async requireReady(id: string): Promise<LabMetadata> {
    const lab = await readLab(this.roots, this.owner, id);
    if (lab.state !== "ready") {
      throw new Error(`lab is not ready: ${lab.state}`);
    }
    return lab;
  }

  private async reconcileOwner(): Promise<void> {
    await reconcileOwnerLabs(this.roots, this.owner);
  }

  private domainContext() {
    return {
      owner: this.owner,
      roots: this.roots,
      docker: this.docker,
      environment: this.environment,
    };
  }

  private labLock(id: string): string {
    return labLockPath(this.roots.stateRoot, this.owner, id);
  }

  private activityLock(id: string): string {
    return activityLockPath(this.roots.stateRoot, this.owner, id);
  }
}

function compactLabStatus(lab: LabMetadata, stack: unknown): unknown {
  const endpoints = lab.endpoints.slice(0, 8).map((endpoint) => ({
    name: endpoint.name.slice(0, 128),
    service: endpoint.service.slice(0, 128),
    target: endpoint.target,
    url: endpoint.url.slice(0, 256),
  }));
  const findings = lab.findings.slice(0, 12).map((finding) => ({
    ...(finding.service ? { service: finding.service.slice(0, 128) } : {}),
    surface: finding.surface,
    detail: finding.detail.slice(0, 256),
  }));
  return {
    labId: lab.id,
    name: lab.name,
    state: lab.state,
    updatedAt: lab.updatedAt,
    ...(endpoints.length > 0
      ? { endpoints, endpointCount: lab.endpoints.length }
      : {}),
    ...(findings.length > 0
      ? { findings, findingCount: lab.findings.length }
      : {}),
    ...(lab.error ? { error: publicError(lab.error) } : {}),
    ...(stack ? { stack } : {}),
  };
}

function publicError(value: string): string {
  return redactPublicText(value, 2_000, 6);
}
