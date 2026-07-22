import type { TaskWorktreeDigest } from "../contract.ts";
import type { TaskWorktreeProtectedPathMode } from "./public-contract.ts";

export interface ProtectedManifestEntry {
  readonly path: string;
  readonly byteLength: number;
  readonly digest: TaskWorktreeDigest;
}

export interface ProtectedManifest {
  readonly entries: readonly ProtectedManifestEntry[];
  readonly testDigest: TaskWorktreeDigest;
  readonly specificationDigest: TaskWorktreeDigest;
  readonly digest: TaskWorktreeDigest;
}

export interface ProtectedCandidateState {
  readonly mode: TaskWorktreeProtectedPathMode;
  readonly testPaths: readonly string[];
  readonly specificationPaths: readonly string[];
  readonly authorizationDigest: TaskWorktreeDigest;
  readonly baselineManifest: ProtectedManifest;
  readonly candidateManifest: ProtectedManifest;
  readonly policyDigest: TaskWorktreeDigest;
}
