import { join } from "node:path";
import { validateText } from "../content-integrity.ts";
import {
  assertKeys,
  numberValue,
  record,
  stringValue,
} from "../json-contract.ts";
import type { TransactionOperation } from "../lifecycle/contract.ts";
import {
  isTransactionOperation,
  PromptLayerError,
} from "../lifecycle/contract.ts";
import {
  assertContainedPath,
  errorMessage,
  readRequiredFile,
} from "../repository-boundary.ts";
import { validProcessStartIdentity } from "./process-identity.ts";

export const LOCK_VERSION = 1;
export const TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface MutationLockOwner {
  version: number;
  operation: TransactionOperation;
  pid: number;
  processStartIdentity: string;
  token: string;
  createdAtUnixMs: number;
}

export interface ReclaimClaim {
  version: number;
  pid: number;
  processStartIdentity: string;
  token: string;
  createdAtUnixMs: number;
}

export function reclaimClaimValue(value: unknown): ReclaimClaim {
  const object = record(value, "prompt lock reclaim claim");
  assertKeys(
    object,
    [
      "version",
      "pid",
      "processStartIdentity",
      "token",
      // biome-ignore lint/security/noSecrets: This is a lock-protocol field name, not a credential.
      "createdAtUnixMs",
    ],
    "prompt lock reclaim claim",
  );
  const claim = {
    version: numberValue(object["version"], "reclaim version"),
    pid: numberValue(object["pid"], "reclaim pid"),
    processStartIdentity: stringValue(
      object["processStartIdentity"],
      "reclaim process start identity",
    ),
    token: stringValue(object["token"], "reclaim token"),
    createdAtUnixMs: numberValue(
      // biome-ignore lint/security/noSecrets: This is a lock-protocol field name, not a credential.
      object["createdAtUnixMs"],
      "reclaim creation time",
    ),
  };
  if (
    claim.version !== LOCK_VERSION ||
    !Number.isSafeInteger(claim.pid) ||
    claim.pid < 1 ||
    !validProcessStartIdentity(claim.processStartIdentity) ||
    !TOKEN.test(claim.token) ||
    !Number.isSafeInteger(claim.createdAtUnixMs) ||
    claim.createdAtUnixMs < 1
  ) {
    throw new PromptLayerError("Prompt lock reclaim claim is invalid.");
  }
  return claim;
}

export function lockOwnerValue(value: unknown): MutationLockOwner {
  const object = record(value, "prompt mutation lock owner");
  assertKeys(
    object,
    [
      "version",
      "operation",
      "pid",
      "processStartIdentity",
      "token",
      // biome-ignore lint/security/noSecrets: This is a lock-protocol field name, not a credential.
      "createdAtUnixMs",
    ],
    "prompt mutation lock owner",
  );
  const version = numberValue(object["version"], "lock version");
  const operation = stringValue(object["operation"], "lock operation");
  const pid = numberValue(object["pid"], "lock pid");
  const processStartIdentity = stringValue(
    object["processStartIdentity"],
    "lock process start identity",
  );
  const token = stringValue(object["token"], "lock token");
  const createdAtUnixMs = numberValue(
    // biome-ignore lint/security/noSecrets: This is a lock-protocol field name, not a credential.
    object["createdAtUnixMs"],
    "lock creation time",
  );
  if (
    version !== LOCK_VERSION ||
    !isTransactionOperation(operation) ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !validProcessStartIdentity(processStartIdentity) ||
    !TOKEN.test(token) ||
    !Number.isSafeInteger(createdAtUnixMs) ||
    createdAtUnixMs < 1
  ) {
    throw new PromptLayerError("Prompt mutation lock owner is invalid.");
  }
  return {
    version,
    operation,
    pid,
    processStartIdentity,
    token,
    createdAtUnixMs,
  };
}

export async function readMutationOwner(
  root: string,
  relativeOwnerPath: string,
): Promise<MutationLockOwner> {
  await assertContainedPath(root, relativeOwnerPath, true);
  const bytes = await readRequiredFile(
    join(root, relativeOwnerPath),
    "prompt mutation lock owner",
  );
  validateText(bytes, "prompt mutation lock owner");
  try {
    return lockOwnerValue(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new PromptLayerError(
      `Prompt mutation lock owner is invalid: ${errorMessage(error)}`,
    );
  }
}

export function sameLockOwner(
  actual: MutationLockOwner | undefined,
  expected: MutationLockOwner,
): boolean {
  return (
    actual !== undefined &&
    actual.version === expected.version &&
    actual.operation === expected.operation &&
    actual.pid === expected.pid &&
    actual.processStartIdentity === expected.processStartIdentity &&
    actual.token === expected.token &&
    actual.createdAtUnixMs === expected.createdAtUnixMs
  );
}

export function lockOwnerBytes(owner: MutationLockOwner): Buffer {
  return Buffer.from(`${JSON.stringify(owner, null, 2)}\n`);
}
