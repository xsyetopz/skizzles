import {
  digestJson,
  freezeBytes,
  hasOnlyKeys,
  isDensePlainArray,
  isPlainDataRecord,
  isSafeRelativePath,
} from "./value.ts";

export type CandidateOperation = "write" | "delete";

export interface DeclaredPathTarget {
  readonly path: string;
  readonly operation: CandidateOperation;
}

export interface PathInspection {
  readonly requestedPath: string;
  readonly resolvedPath: string;
  readonly symlinkEncountered: boolean;
}

export interface PathInspectionAuthority {
  readonly id: string;
}

export interface PathInspectionAuthorityConfig {
  readonly id: string;
  readonly inspect: (path: string) => PathInspection | Promise<PathInspection>;
}

export type PathInspectionAuthorityCreationResult =
  | Readonly<{ status: "created"; authority: PathInspectionAuthority }>
  | Readonly<{ status: "rejected"; code: "INVALID_PATH_AUTHORITY" }>;

const pathAuthorities = new WeakMap<object, PathInspectionAuthorityConfig>();

export function createPathInspectionAuthority(
  input: unknown,
): PathInspectionAuthorityCreationResult {
  if (
    !isPlainDataRecord(input) ||
    !hasOnlyKeys(input, ["id", "inspect"]) ||
    typeof input["id"] !== "string" ||
    input["id"].length === 0 ||
    typeof input["inspect"] !== "function"
  ) {
    return Object.freeze({
      status: "rejected",
      code: "INVALID_PATH_AUTHORITY",
    });
  }
  const authority = Object.freeze({ id: input["id"] });
  pathAuthorities.set(authority, {
    id: input["id"],
    inspect: input["inspect"] as PathInspectionAuthorityConfig["inspect"],
  });
  return Object.freeze({ status: "created", authority });
}

export interface CandidateMutationRequest {
  readonly path: string;
  readonly operation: CandidateOperation;
  readonly candidateBytes?: readonly number[];
}

export interface CandidateMutationReceipt {
  readonly path: string;
  readonly operation: CandidateOperation;
  readonly candidateDigest: string | null;
  readonly authorityId: string;
  readonly scopeDigest: string;
  readonly receiptDigest: string;
}

export type CandidateMutationResult =
  | Readonly<{ status: "authorized"; receipt: CandidateMutationReceipt }>
  | Readonly<{
      status: "rejected";
      code:
        | "INVALID_MUTATION"
        | "OUTSIDE_DECLARED_SCOPE"
        | "PATH_INSPECTION_FAILED"
        | "PATH_REDIRECTION_REJECTED";
    }>;

export interface CandidateMutationGateway {
  readonly authorize: (input: unknown) => Promise<CandidateMutationResult>;
}

export interface CandidateMutationGatewayConfig {
  readonly targets: readonly DeclaredPathTarget[];
  readonly pathAuthority: PathInspectionAuthority;
}

export type CandidateMutationGatewayCreationResult =
  | Readonly<{ status: "created"; gateway: CandidateMutationGateway }>
  | Readonly<{ status: "rejected"; code: "INVALID_PATH_SCOPE" }>;

function parseTargets(value: unknown): readonly DeclaredPathTarget[] | null {
  if (!isDensePlainArray(value) || value.length === 0) return null;
  const targets: DeclaredPathTarget[] = [];
  const keys = new Set<string>();
  for (const item of value) {
    if (
      !isPlainDataRecord(item) ||
      !hasOnlyKeys(item, ["path", "operation"]) ||
      !isSafeRelativePath(item["path"]) ||
      (item["operation"] !== "write" && item["operation"] !== "delete")
    )
      return null;
    const key = item["path"].normalize("NFC").toLowerCase();
    if (keys.has(key)) return null;
    keys.add(key);
    targets.push(
      Object.freeze({ path: item["path"], operation: item["operation"] }),
    );
  }
  return Object.freeze(targets);
}

function parseInspection(
  value: unknown,
  requestedPath: string,
): PathInspection | null {
  if (
    !isPlainDataRecord(value) ||
    !hasOnlyKeys(value, [
      "requestedPath",
      "resolvedPath",
      "symlinkEncountered",
    ]) ||
    value["requestedPath"] !== requestedPath ||
    !isSafeRelativePath(value["resolvedPath"]) ||
    typeof value["symlinkEncountered"] !== "boolean"
  )
    return null;
  return Object.freeze({
    requestedPath,
    resolvedPath: value["resolvedPath"],
    symlinkEncountered: value["symlinkEncountered"],
  });
}

export function createCandidateMutationGateway(
  input: unknown,
): CandidateMutationGatewayCreationResult {
  if (
    !isPlainDataRecord(input) ||
    !hasOnlyKeys(input, ["targets", "pathAuthority"])
  )
    return Object.freeze({ status: "rejected", code: "INVALID_PATH_SCOPE" });
  const targets = parseTargets(input["targets"]);
  const pathAuthority = input["pathAuthority"];
  const authorityConfig =
    typeof pathAuthority === "object" && pathAuthority !== null
      ? pathAuthorities.get(pathAuthority)
      : undefined;
  if (targets === null || authorityConfig === undefined)
    return Object.freeze({ status: "rejected", code: "INVALID_PATH_SCOPE" });
  const allowed = new Set(
    targets.map((target) => `${target.operation}:${target.path}`),
  );
  const scopeDigest = digestJson(targets);
  const gateway: CandidateMutationGateway = Object.freeze({
    authorize: async (request: unknown): Promise<CandidateMutationResult> => {
      if (
        !isPlainDataRecord(request) ||
        !hasOnlyKeys(request, ["path", "operation", "candidateBytes"]) ||
        !isSafeRelativePath(request["path"]) ||
        (request["operation"] !== "write" && request["operation"] !== "delete")
      ) {
        return Object.freeze({ status: "rejected", code: "INVALID_MUTATION" });
      }
      const candidateBytes =
        request["operation"] === "write"
          ? freezeBytes(request["candidateBytes"] as readonly number[])
          : null;
      if (
        (request["operation"] === "write" && candidateBytes === null) ||
        (request["operation"] === "delete" &&
          request["candidateBytes"] !== undefined)
      ) {
        return Object.freeze({ status: "rejected", code: "INVALID_MUTATION" });
      }
      if (!allowed.has(`${request["operation"]}:${request["path"]}`))
        return Object.freeze({
          status: "rejected",
          code: "OUTSIDE_DECLARED_SCOPE",
        });
      let inspection: PathInspection | null = null;
      try {
        inspection = parseInspection(
          await authorityConfig.inspect(request["path"]),
          request["path"],
        );
      } catch {
        return Object.freeze({
          status: "rejected",
          code: "PATH_INSPECTION_FAILED",
        });
      }
      if (inspection === null)
        return Object.freeze({
          status: "rejected",
          code: "PATH_INSPECTION_FAILED",
        });
      if (
        inspection.symlinkEncountered ||
        inspection.resolvedPath !== request["path"]
      ) {
        return Object.freeze({
          status: "rejected",
          code: "PATH_REDIRECTION_REJECTED",
        });
      }
      const candidateDigest =
        candidateBytes === null ? null : digestJson(candidateBytes);
      const body = {
        path: request["path"],
        operation: request["operation"],
        candidateDigest,
        authorityId: authorityConfig.id,
        scopeDigest,
      } as const;
      return Object.freeze({
        status: "authorized",
        receipt: Object.freeze({ ...body, receiptDigest: digestJson(body) }),
      });
    },
  });
  return Object.freeze({ status: "created", gateway });
}
