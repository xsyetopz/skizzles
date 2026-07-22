import type { CandidateManifestDigest } from "@skizzles/candidate-manifest";
import type { Digest } from "./digest.ts";

export type ChangeAssuranceDomain =
  | "middleware-security"
  | "migration-configuration-secrets"
  | "performance"
  | "supply-chain";

export type ChangeOperation = "write" | "delete";

export type AssuranceJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AssuranceJsonValue[]
  | { readonly [key: string]: AssuranceJsonValue };

export interface ChangeDeclarationTarget {
  readonly path: string;
  readonly operation: ChangeOperation;
}

export interface ChangeDeclaration {
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly targetSetDigest: Digest;
  readonly planDigests: Readonly<Record<ChangeAssuranceDomain, Digest>>;
  readonly declarationDigest: Digest;
}

export interface ChangeDeclarationInput {
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly targets: readonly ChangeDeclarationTarget[];
  readonly plans: Readonly<Record<ChangeAssuranceDomain, AssuranceJsonValue>>;
}

export type ChangeDeclarationCreationResult =
  | Readonly<{ status: "created"; declaration: ChangeDeclaration }>
  | Readonly<{ status: "rejected"; code: "INVALID_DECLARATION" }>;

export interface ChangeAssuranceTarget {
  readonly path: string;
  readonly operation: ChangeOperation;
  readonly baselineBytes: readonly number[] | null;
  readonly candidateBytes: readonly number[] | null;
}

export interface ChangeAssuranceAssessmentInput {
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly treeDigest: Digest;
  readonly baselineDigest: Digest;
  readonly declaration: ChangeDeclaration;
  readonly targets: readonly ChangeAssuranceTarget[];
}

export interface ChangeAssuranceExtensionInput
  extends Omit<ChangeAssuranceAssessmentInput, "declaration"> {
  readonly declarationDigest: Digest;
  readonly domain: ChangeAssuranceDomain;
  readonly plan: unknown;
}

export type ChangeAssuranceExtensionResult =
  | Readonly<{ status: "accepted"; evidenceDigest: Digest }>
  | Readonly<{ status: "rejected"; code: string }>;

export interface ChangeAssuranceExtensionConfig {
  readonly domain: ChangeAssuranceDomain;
  readonly id: string;
  readonly version: string;
  readonly assess: (
    input: ChangeAssuranceExtensionInput,
  ) => ChangeAssuranceExtensionResult | Promise<ChangeAssuranceExtensionResult>;
}

export interface ChangeAssuranceExtension {
  readonly domain: ChangeAssuranceDomain;
  readonly id: string;
  readonly version: string;
}

export type ChangeAssuranceExtensionCreationResult =
  | Readonly<{
      status: "created";
      extension: ChangeAssuranceExtension;
    }>
  | Readonly<{ status: "rejected"; code: "INVALID_EXTENSION_CONFIG" }>;

export interface ChangeAssuranceConfig {
  readonly extensions: readonly ChangeAssuranceExtension[];
}

export interface ChangeAssuranceExtensionReceipt {
  readonly domain: ChangeAssuranceDomain;
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly evidenceDigest: Digest;
}

export interface ChangeAssuranceReceipt {
  readonly requestDigest: Digest;
  readonly repositoryId: string;
  readonly treeDigest: Digest;
  readonly baselineDigest: Digest;
  readonly targetSetDigest: Digest;
  readonly candidateDigest: Digest;
  readonly candidateManifestDigest: CandidateManifestDigest;
  readonly declarationDigest: Digest;
  readonly extensionReceipts: readonly ChangeAssuranceExtensionReceipt[];
  readonly receiptDigest: Digest;
}

export type ChangeAssuranceFailureCode =
  | "INVALID_CONFIG"
  | "INVALID_INPUT"
  | "DECLARATION_REJECTED"
  | "TARGET_BINDING_REJECTED"
  | "MIDDLEWARE_SECURITY_REJECTED"
  | "MIGRATION_CONFIGURATION_SECRETS_REJECTED"
  | "PERFORMANCE_REJECTED"
  | "SUPPLY_CHAIN_REJECTED";

export type ChangeAssuranceResult =
  | Readonly<{ status: "accepted"; receipt: ChangeAssuranceReceipt }>
  | Readonly<{ status: "rejected"; code: ChangeAssuranceFailureCode }>;

export interface ChangeAssurance {
  readonly assess: (input: unknown) => Promise<ChangeAssuranceResult>;
  readonly verify: (input: unknown) => boolean;
}

export type ChangeAssuranceCreationResult =
  | Readonly<{ status: "created"; changeAssurance: ChangeAssurance }>
  | Readonly<{ status: "rejected"; code: "INVALID_CONFIG" }>;
