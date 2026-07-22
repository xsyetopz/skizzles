import { hasOnlyKeys, isPlainDataRecord } from "../policy/value.ts";
import type {
  SandboxCapabilityAuthority,
  SandboxCapabilityAuthorityConfig,
} from "./contract.ts";

const capabilityAuthorities = new WeakMap<
  object,
  SandboxCapabilityAuthorityConfig
>();

export function createSandboxCapabilityAuthority(
  input: unknown,
):
  | Readonly<{ status: "created"; authority: SandboxCapabilityAuthority }>
  | Readonly<{ status: "rejected"; code: "INVALID_SANDBOX_AUTHORITY" }> {
  if (
    !isPlainDataRecord(input) ||
    !hasOnlyKeys(input, ["id", "attest", "execute"]) ||
    typeof input["id"] !== "string" ||
    input["id"].length === 0 ||
    typeof input["attest"] !== "function" ||
    typeof input["execute"] !== "function"
  )
    return Object.freeze({
      status: "rejected",
      code: "INVALID_SANDBOX_AUTHORITY",
    });
  const authority = Object.freeze({ id: input["id"] });
  capabilityAuthorities.set(authority, {
    id: input["id"],
    attest: input["attest"] as SandboxCapabilityAuthorityConfig["attest"],
    execute: input["execute"] as SandboxCapabilityAuthorityConfig["execute"],
  });
  return Object.freeze({ status: "created", authority });
}

export function sandboxAuthorityConfig(
  authority: unknown,
): SandboxCapabilityAuthorityConfig | undefined {
  return typeof authority === "object" && authority !== null
    ? capabilityAuthorities.get(authority)
    : undefined;
}
