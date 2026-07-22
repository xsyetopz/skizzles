import type { Digest } from "../../digest.ts";

export type RegisteredLiteralValue = string | number;

export type LiteralSyntaxExemption =
  | "collection-index"
  | "diagnostic-message"
  | "discriminant-tag"
  | "module-specifier"
  | "structural-number";

export interface RegisteredLiteralEntry {
  readonly key: string;
  readonly kind: "number" | "string";
  readonly value: RegisteredLiteralValue;
  readonly description: string;
  readonly registrationDigest: Digest;
}

export interface LiteralRegistrySnapshot {
  readonly registryId: string;
  readonly registryPath: string;
  readonly exportName: string;
  readonly revision: number;
  readonly entries: readonly RegisteredLiteralEntry[];
  readonly syntaxExemptions: readonly LiteralSyntaxExemption[];
  readonly registryDigest: Digest;
}

export interface LiteralRegistrationReceipt extends RegisteredLiteralEntry {
  readonly registryId: string;
  readonly registryPath: string;
  readonly exportName: string;
  readonly revision: number;
  readonly previousRegistryDigest: Digest;
  readonly registryDigest: Digest;
  readonly propertySource: string;
  readonly receiptDigest: Digest;
}

export interface LiteralRegistry {
  readonly register: (input: unknown) => LiteralRegistrationResult;
  readonly snapshot: () => LiteralRegistrySnapshot;
}

export type LiteralRegistryCreationResult =
  | Readonly<{ status: "created"; registry: LiteralRegistry }>
  | Readonly<{ status: "rejected"; code: "INVALID_LITERAL_REGISTRY_CONFIG" }>;

export type LiteralRegistrationResult =
  | Readonly<{
      status: "registered";
      receipt: LiteralRegistrationReceipt;
      snapshot: LiteralRegistrySnapshot;
    }>
  | Readonly<{
      status: "rejected";
      code:
        | "DUPLICATE_LITERAL_KEY"
        | "DUPLICATE_LITERAL_VALUE"
        | "INVALID_LITERAL_REGISTRATION"
        | "LITERAL_REGISTRY_CAPACITY_EXCEEDED";
    }>;

export type LiteralRegistrySnapshotRecovery =
  | Readonly<{
      status: "recovered";
      registryPath: string;
      exportName: string;
      entriesByKey: ReadonlyMap<string, RegisteredLiteralEntry>;
    }>
  | Readonly<{ status: "rejected"; code: "FORGED_LITERAL_REGISTRY_SNAPSHOT" }>;
