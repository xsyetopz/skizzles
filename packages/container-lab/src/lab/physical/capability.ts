import type { StateRoots } from "../../state/layout.ts";
import type { RunOutput } from "../attached-run.ts";
import type {
  PhysicalCandidateEvidence,
  PhysicalCandidateTarget,
} from "./contract.ts";

export interface PhysicalServiceSurface {
  readonly owner: string;
  readonly roots: Readonly<StateRoots>;
  readonly run: PhysicalServiceCapability["run"];
  readonly destroyLab: PhysicalServiceCapability["destroyLab"];
  readonly listLabs: PhysicalServiceCapability["listLabs"];
}

export interface PhysicalServiceCapability {
  readonly owner: string;
  readonly roots: Readonly<StateRoots>;
  readonly run: (
    id: string,
    argv: string[],
    cwd: string,
    environment: Record<string, string>,
    timeoutSeconds: number,
    output: RunOutput,
    signal?: AbortSignal,
  ) => Promise<number>;
  readonly destroyLab: (
    id: string,
  ) => Promise<{ labId: string; destroyed: boolean }>;
  readonly listLabs: () => Promise<{
    labs: Array<{
      labId: string;
      name: string;
      state: "provisioning" | "ready" | "failed" | "destroying";
      updatedAt: string;
    }>;
  }>;
  readonly synchronizeCandidates: (input: {
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
  }) => Promise<PhysicalCandidateEvidence>;
}

export type PhysicalServiceRegistration = Omit<
  PhysicalServiceCapability,
  "synchronizeCandidates"
>;
