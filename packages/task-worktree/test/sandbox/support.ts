import {
  createPortableSandboxBroker,
  createSandboxCapabilityAuthority,
  type SandboxAuthorityExecutionRequest,
} from "../../src/sandbox/capabilities.ts";

export function broker(
  attest: (paths: readonly string[]) => unknown,
  execute: (request: SandboxAuthorityExecutionRequest) => unknown = (
    request,
  ) => ({
    bindingDigest: request.bindingDigest,
    exitCode: 0,
    stdoutDigest: "0".repeat(64),
    stderrDigest: "0".repeat(64),
    stdoutBytes: 0,
    stderrBytes: 0,
  }),
) {
  const authority = createSandboxCapabilityAuthority({
    id: "host-probe-v1",
    attest,
    execute,
  });
  if (authority.status !== "created") {
    throw new Error("authority rejected");
  }
  const created = createPortableSandboxBroker({
    authority: authority.authority,
  });
  if (created.status !== "created") {
    throw new Error("broker rejected");
  }
  return created.broker;
}

export function fullAttestation(
  paths: readonly string[],
): Record<string, unknown> {
  return {
    mechanism: "landlock",
    writePaths: paths,
    deniesUndeclaredWrites: true,
    deniesSystemControl: true,
    readOnlyWorktree: true,
    networkDisabled: true,
    boundedProcessTree: true,
    evidence: "kernel-probe:abi-6",
  };
}

export const defaultLimits = Object.freeze({
  timeoutMilliseconds: 30_000,
  maximumOutputBytes: 1_048_576,
  drainMilliseconds: 1_000,
  signalGraceMilliseconds: 1_000,
});
