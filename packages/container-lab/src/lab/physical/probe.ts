import { createHash } from "node:crypto";
import type { PhysicalServiceCapability } from "./capability.ts";
import {
  MAXIMUM_PROBE_OUTPUT_BYTES,
  type PhysicalCleanupProof,
  type PhysicalIntegrationDeclaration,
  type PhysicalProbeEvidence,
} from "./contract.ts";

export async function observePhysicalProbe(
  capability: PhysicalServiceCapability,
  declaration: PhysicalIntegrationDeclaration,
): Promise<PhysicalProbeEvidence | undefined> {
  const stdout = new BoundedObservation();
  const stderr = new BoundedObservation();
  let exitCode: number;
  try {
    exitCode = await capability.run(
      declaration.labId,
      [...declaration.probe.argv],
      declaration.probe.cwd,
      { ...declaration.probe.environment },
      declaration.probe.timeoutSeconds,
      {
        stdout: (chunk: Buffer) => stdout.observe(chunk),
        stderr: (chunk: Buffer) => stderr.observe(chunk),
      },
    );
  } catch {
    return;
  }
  if (!(stdout.complete && stderr.complete)) return;
  return Object.freeze({
    profileId: declaration.probe.profileId,
    profileVersion: declaration.probe.profileVersion,
    profileDigest: declaration.probe.profileDigest,
    argv: declaration.probe.argv,
    cwd: declaration.probe.cwd,
    environmentNames: Object.freeze(
      Object.keys(declaration.probe.environment).sort(),
    ),
    exitCode,
    stdoutBytes: stdout.bytes,
    stdoutDigest: stdout.digest(),
    stderrBytes: stderr.bytes,
    stderrDigest: stderr.digest(),
    complete: true,
  });
}

export async function destroyAndProveAbsent(
  capability: PhysicalServiceCapability,
  labId: string,
): Promise<PhysicalCleanupProof | undefined> {
  try {
    const destroyed = await capability.destroyLab(labId);
    if (!(destroyed.destroyed && destroyed.labId === labId)) return;
    const remaining = await capability.listLabs();
    if (remaining.labs.some((lab) => lab.labId === labId)) return;
    return Object.freeze({
      destroyReported: true,
      labAbsent: true,
      terminal: true,
    });
  } catch {}
}

class BoundedObservation {
  readonly #hash = createHash("sha256");
  bytes = 0;
  complete = true;

  observe(chunk: Buffer): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > MAXIMUM_PROBE_OUTPUT_BYTES) {
      this.complete = false;
      return;
    }
    this.#hash.update(chunk);
  }

  digest(): string {
    return `sha256:${this.#hash.digest("hex")}`;
  }
}
