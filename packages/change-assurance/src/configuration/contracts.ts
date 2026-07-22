import type { AssuranceDigest } from "../digest.ts";

export type ConfigurationValue =
  | string
  | number
  | boolean
  | null
  | readonly ConfigurationValue[]
  | { readonly [key: string]: ConfigurationValue };

export type ConfigurationValueKind = "string" | "number" | "boolean" | "json";

export interface ConfigurationDefinition {
  readonly key: string;
  readonly path: string;
  readonly kind: ConfigurationValueKind;
}

export interface ConfigurationRegistryConfig {
  readonly definitions: readonly ConfigurationDefinition[];
}

export interface ConfigurationRegistrationInput {
  readonly key: string;
  readonly value: ConfigurationValue;
}

export interface ConfigurationRegistrationReceipt {
  readonly key: string;
  readonly path: string;
  readonly valueDigest: AssuranceDigest;
  readonly registryDigest: AssuranceDigest;
  readonly receiptDigest: AssuranceDigest;
}

export interface ConfigurationWriteReceipt {
  readonly path: string;
  readonly materializedDigest: AssuranceDigest;
  readonly registryDigest: AssuranceDigest;
  readonly registrationDigests: readonly AssuranceDigest[];
  readonly receiptDigest: AssuranceDigest;
}

export type ConfigurationRegistrationResult =
  | { readonly ok: true; readonly receipt: ConfigurationRegistrationReceipt }
  | {
      readonly ok: false;
      readonly code: "UNKNOWN_KEY" | "INVALID_VALUE" | "DUPLICATE_KEY";
      readonly message: string;
    };

export type ConfigurationMaterializationResult =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly receipt: ConfigurationWriteReceipt;
    }
  | {
      readonly ok: false;
      readonly code: "UNREGISTERED_KEY" | "EMPTY_PATH";
      readonly message: string;
    };

export interface ConfigurationRegistrySnapshot {
  readonly definitions: readonly ConfigurationDefinition[];
  readonly registrations: readonly ConfigurationRegistrationReceipt[];
  readonly registryDigest: AssuranceDigest;
}

export interface ConfigurationRegistry {
  readonly register: (
    input: ConfigurationRegistrationInput,
  ) => ConfigurationRegistrationResult;
  readonly materialize: (input: {
    readonly key: string;
  }) => ConfigurationMaterializationResult;
  readonly snapshot: () => ConfigurationRegistrySnapshot;
}
