import type {
  ChangeAssuranceExtension,
  ChangeAssuranceExtensionConfig,
  ChangeAssuranceExtensionCreationResult,
  ChangeAssuranceExtensionInput,
  ChangeAssuranceExtensionResult,
} from "./contract.ts";
import { assuranceDomains } from "./declaration.ts";
import { isDigest } from "./digest.ts";

interface ExtensionBindings {
  readonly assess: (
    input: ChangeAssuranceExtensionInput,
  ) => ChangeAssuranceExtensionResult | Promise<ChangeAssuranceExtensionResult>;
}

const extensions = new WeakMap<object, ExtensionBindings>();

export function createChangeAssuranceExtension(
  input: unknown,
): ChangeAssuranceExtensionCreationResult {
  try {
    if (!isExtensionConfig(input)) {
      return { status: "rejected", code: "INVALID_EXTENSION_CONFIG" };
    }
    const extension: ChangeAssuranceExtension = Object.freeze({
      domain: input.domain,
      id: input.id,
      version: input.version,
    });
    extensions.set(extension, { assess: input.assess });
    return { status: "created", extension };
  } catch {
    return { status: "rejected", code: "INVALID_EXTENSION_CONFIG" };
  }
}

export function isChangeAssuranceExtension(
  input: unknown,
): input is ChangeAssuranceExtension {
  return typeof input === "object" && input !== null && extensions.has(input);
}

export async function invokeExtension(
  extension: ChangeAssuranceExtension,
  input: ChangeAssuranceExtensionInput,
): Promise<ChangeAssuranceExtensionResult> {
  const bindings = extensions.get(extension);
  if (bindings === undefined) {
    return { status: "rejected", code: "FORGED_EXTENSION" };
  }
  try {
    const result: unknown = await bindings.assess(input);
    if (
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result)
    ) {
      return { status: "rejected", code: "INVALID_EXTENSION_RESULT" };
    }
    const own = Reflect.ownKeys(result);
    const status = dataValue(result, "status");
    if (
      status === "accepted" &&
      own.length === 2 &&
      own.includes("evidenceDigest") &&
      isDigest(dataValue(result, "evidenceDigest"))
    ) {
      const evidenceDigest = dataValue(result, "evidenceDigest");
      if (!isDigest(evidenceDigest)) {
        return { status: "rejected", code: "INVALID_EXTENSION_RESULT" };
      }
      return Object.freeze({ status: "accepted", evidenceDigest });
    }
    if (
      status === "rejected" &&
      own.length === 2 &&
      own.includes("code") &&
      typeof dataValue(result, "code") === "string"
    ) {
      const code = dataValue(result, "code");
      if (typeof code !== "string") {
        return { status: "rejected", code: "INVALID_EXTENSION_RESULT" };
      }
      return Object.freeze({ status: "rejected", code });
    }
    return { status: "rejected", code: "INVALID_EXTENSION_RESULT" };
  } catch {
    return { status: "rejected", code: "EXTENSION_EXCEPTION" };
  }
}

function isExtensionConfig(
  input: unknown,
): input is ChangeAssuranceExtensionConfig {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input)
  ) {
    return false;
  }
  const own = Reflect.ownKeys(input);
  if (
    own.length !== 4 ||
    !["domain", "id", "version", "assess"].every((key) => own.includes(key))
  ) {
    return false;
  }
  const domain = dataValue(input, "domain");
  const id = dataValue(input, "id");
  const version = dataValue(input, "version");
  return (
    assuranceDomains.some((candidate) => candidate === domain) &&
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 128 &&
    typeof version === "string" &&
    version.length > 0 &&
    version.length <= 64 &&
    typeof dataValue(input, "assess") === "function"
  );
}

function dataValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

import { types } from "node:util";
