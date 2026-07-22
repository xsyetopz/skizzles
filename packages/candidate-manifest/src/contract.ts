export type CandidateManifestDigest = `sha256:${string}`;

export type CandidateManifestOperation = "delete" | "write";

export interface CandidateManifestEntry {
  readonly path: string;
  readonly operation: CandidateManifestOperation;
  readonly contentDigest: CandidateManifestDigest | null;
}

export interface CandidateManifest {
  readonly schema: "skizzles.candidate-manifest/manifest";
  readonly domain: "candidate-file-manifest";
  readonly version: 1;
  readonly entries: readonly CandidateManifestEntry[];
  readonly manifestDigest: CandidateManifestDigest;
}
