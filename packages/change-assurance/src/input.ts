import { types } from "node:util";
import type {
  ChangeAssuranceAssessmentInput,
  ChangeAssuranceTarget,
} from "./contract.ts";
import { isChangeDeclaration } from "./declaration.ts";
import { isDigest } from "./digest.ts";
import { normalizeTargetPath } from "./path.ts";

const maximumBytes = 4_194_304;

export function parseAssessmentInput(
  input: unknown,
): ChangeAssuranceAssessmentInput | undefined {
  if (
    !(
      exactRecord(input, [
        "requestDigest",
        "repositoryId",
        "treeDigest",
        "baselineDigest",
        "declaration",
        "targets",
      ]) && Object.isFrozen(input)
    )
  ) {
    return;
  }
  const declaration = input["declaration"];
  if (
    !(
      isDigest(input["requestDigest"]) &&
      isDigest(input["treeDigest"]) &&
      isDigest(input["baselineDigest"])
    ) ||
    typeof input["repositoryId"] !== "string" ||
    input["repositoryId"].length === 0 ||
    !isChangeDeclaration(declaration) ||
    !Array.isArray(input["targets"]) ||
    !Object.isFrozen(input["targets"]) ||
    input["targets"].length === 0 ||
    input["targets"].length > 256
  ) {
    return;
  }
  const targets: ChangeAssuranceTarget[] = [];
  let totalBytes = 0;
  for (const raw of input["targets"]) {
    if (
      !(
        exactRecord(raw, [
          "path",
          "operation",
          "baselineBytes",
          "candidateBytes",
        ]) && Object.isFrozen(raw)
      )
    ) {
      return;
    }
    const path = normalizeTargetPath(raw["path"]);
    const baselineBytes = parseBytes(raw["baselineBytes"]);
    const candidateBytes = parseBytes(raw["candidateBytes"]);
    if (
      path === undefined ||
      (raw["operation"] !== "write" && raw["operation"] !== "delete") ||
      (raw["baselineBytes"] !== null && baselineBytes === undefined) ||
      (raw["candidateBytes"] !== null && candidateBytes === undefined) ||
      (raw["operation"] === "write" && candidateBytes === null) ||
      (raw["operation"] === "delete" &&
        (baselineBytes === null || candidateBytes !== null))
    ) {
      return;
    }
    totalBytes += (baselineBytes?.length ?? 0) + (candidateBytes?.length ?? 0);
    if (totalBytes > maximumBytes) {
      return;
    }
    if (baselineBytes === undefined || candidateBytes === undefined) {
      return;
    }
    targets.push(
      Object.freeze({
        path,
        operation: raw["operation"],
        baselineBytes,
        candidateBytes,
      }),
    );
  }
  targets.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    requestDigest: input["requestDigest"],
    repositoryId: input["repositoryId"],
    treeDigest: input["treeDigest"],
    baselineDigest: input["baselineDigest"],
    declaration,
    targets: Object.freeze(targets),
  });
}

function parseBytes(input: unknown): readonly number[] | null | undefined {
  if (input === null) {
    return null;
  }
  if (!(Array.isArray(input) && Object.isFrozen(input))) {
    return;
  }
  for (const value of input) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return;
    }
  }
  return input;
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
): input is Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    types.isProxy(input)
  ) {
    return false;
  }
  const own = Reflect.ownKeys(input);
  return (
    own.length === keys.length &&
    own.every((key) => typeof key === "string" && keys.includes(key)) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return descriptor !== undefined && "value" in descriptor;
    })
  );
}
