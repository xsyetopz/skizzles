import { invokeAuthority } from "../authority.ts";
import type {
  VerificationAuthorityKind,
  VerificationAuthorityRequest,
  VerificationBindings,
} from "../contract.ts";
import { bindingDigest } from "./report.ts";

export function authorityRequest(
  purpose: VerificationAuthorityKind,
  bindings: VerificationBindings,
  payload: unknown,
): VerificationAuthorityRequest {
  return Object.freeze({
    purpose,
    bindings,
    bindingDigest: bindingDigest(bindings),
    payload,
  });
}

export async function safeInvoke(
  authority: Parameters<typeof invokeAuthority>[0],
  request: VerificationAuthorityRequest,
): Promise<unknown> {
  try {
    return await invokeAuthority(authority, request);
  } catch {
    return;
  }
}
