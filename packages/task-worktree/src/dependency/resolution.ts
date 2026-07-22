import { digestJson, hasOnlyKeys, isPlainDataRecord } from "../policy/value.ts";

export type DependencyEcosystem = "npm";
export interface DependencyResolutionRequest {
  readonly ecosystem: DependencyEcosystem;
  readonly name: string;
  readonly requestedRange: string;
}
export interface DependencyRegistryRecord {
  readonly ecosystem: DependencyEcosystem;
  readonly name: string;
  readonly requestedRange: string;
  readonly resolvedVersion: string | null;
  readonly registry: string;
}
export interface DependencyResolverAuthority {
  readonly id: string;
}
export interface DependencyResolverAuthorityConfig {
  readonly id: string;
  readonly resolve: (
    request: DependencyResolutionRequest,
  ) => unknown | Promise<unknown>;
}
const dependencyAuthorities = new WeakMap<
  object,
  DependencyResolverAuthorityConfig
>();

export function createDependencyResolverAuthority(
  input: unknown,
):
  | Readonly<{ status: "created"; authority: DependencyResolverAuthority }>
  | Readonly<{ status: "rejected"; code: "INVALID_RESOLVER_AUTHORITY" }> {
  if (
    !isPlainDataRecord(input) ||
    !hasOnlyKeys(input, ["id", "resolve"]) ||
    typeof input["id"] !== "string" ||
    input["id"].length === 0 ||
    typeof input["resolve"] !== "function"
  )
    return Object.freeze({
      status: "rejected",
      code: "INVALID_RESOLVER_AUTHORITY",
    });
  const authority = Object.freeze({ id: input["id"] });
  dependencyAuthorities.set(authority, {
    id: input["id"],
    resolve: input["resolve"] as DependencyResolverAuthorityConfig["resolve"],
  });
  return Object.freeze({ status: "created", authority });
}

export interface DependencyResolutionReceipt {
  readonly request: DependencyResolutionRequest;
  readonly registryRecord: DependencyRegistryRecord;
  readonly outcome: "matched" | "mismatch" | "unavailable";
  readonly warning: string | null;
  readonly authorityId: string;
  readonly receiptDigest: string;
}
export type DependencyResolutionResult =
  | Readonly<{ status: "resolved"; receipt: DependencyResolutionReceipt }>
  | Readonly<{
      status: "rejected";
      code:
        | "INVALID_DEPENDENCY_REQUEST"
        | "RESOLVER_FAILED"
        | "INVALID_REGISTRY_RECORD";
    }>;
export interface DependencyResolutionService {
  readonly resolve: (input: unknown) => Promise<DependencyResolutionResult>;
}

function parseRequest(input: unknown): DependencyResolutionRequest | null {
  if (
    !isPlainDataRecord(input) ||
    !hasOnlyKeys(input, ["ecosystem", "name", "requestedRange"]) ||
    input["ecosystem"] !== "npm" ||
    typeof input["name"] !== "string" ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/.test(
      input["name"],
    ) ||
    typeof input["requestedRange"] !== "string" ||
    input["requestedRange"].length === 0 ||
    input["requestedRange"].length > 128
  )
    return null;
  return Object.freeze({
    ecosystem: "npm",
    name: input["name"],
    requestedRange: input["requestedRange"],
  });
}

function parseRecord(
  input: unknown,
  request: DependencyResolutionRequest,
): DependencyRegistryRecord | null {
  if (
    !isPlainDataRecord(input) ||
    !hasOnlyKeys(input, [
      "ecosystem",
      "name",
      "requestedRange",
      "resolvedVersion",
      "registry",
    ]) ||
    input["ecosystem"] !== request.ecosystem ||
    typeof input["name"] !== "string" ||
    typeof input["requestedRange"] !== "string" ||
    (input["resolvedVersion"] !== null &&
      typeof input["resolvedVersion"] !== "string") ||
    typeof input["registry"] !== "string" ||
    input["registry"].length === 0
  )
    return null;
  return Object.freeze({
    ecosystem: "npm",
    name: input["name"],
    requestedRange: input["requestedRange"],
    resolvedVersion: input["resolvedVersion"] as string | null,
    registry: input["registry"],
  });
}

export function createDependencyResolutionService(
  input: unknown,
):
  | Readonly<{ status: "created"; service: DependencyResolutionService }>
  | Readonly<{ status: "rejected"; code: "INVALID_RESOLVER_AUTHORITY" }> {
  if (!isPlainDataRecord(input) || !hasOnlyKeys(input, ["authority"]))
    return Object.freeze({
      status: "rejected",
      code: "INVALID_RESOLVER_AUTHORITY",
    });
  const authority = input["authority"];
  const authorityConfig =
    typeof authority === "object" && authority !== null
      ? dependencyAuthorities.get(authority)
      : undefined;
  if (authorityConfig === undefined)
    return Object.freeze({
      status: "rejected",
      code: "INVALID_RESOLVER_AUTHORITY",
    });
  return Object.freeze({
    status: "created",
    service: Object.freeze({
      resolve: async (raw: unknown): Promise<DependencyResolutionResult> => {
        const request = parseRequest(raw);
        if (request === null)
          return Object.freeze({
            status: "rejected",
            code: "INVALID_DEPENDENCY_REQUEST",
          });
        let resolved: unknown;
        try {
          resolved = await authorityConfig.resolve(request);
        } catch {
          return Object.freeze({ status: "rejected", code: "RESOLVER_FAILED" });
        }
        const record = parseRecord(resolved, request);
        if (record === null)
          return Object.freeze({
            status: "rejected",
            code: "INVALID_REGISTRY_RECORD",
          });
        const exact =
          record.name === request.name &&
          record.requestedRange === request.requestedRange;
        const outcome = !exact
          ? "mismatch"
          : record.resolvedVersion === null
            ? "unavailable"
            : "matched";
        const warning =
          outcome === "matched"
            ? null
            : outcome === "mismatch"
              ? "registry response did not match the exact dependency request"
              : "dependency was unavailable; developer intervention is required";
        const body = {
          request,
          registryRecord: record,
          outcome,
          warning,
          authorityId: authorityConfig.id,
        } as const;
        return Object.freeze({
          status: "resolved",
          receipt: Object.freeze({ ...body, receiptDigest: digestJson(body) }),
        });
      },
    }),
  });
}
