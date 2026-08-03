import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROVISIONING_FAILURE_DIAGNOSTIC_FILE } from "../compose/diagnostics";
import { redactPublicText } from "../public/output";
import { exactDirectoryChain } from "../storage/safe-path";
import { readLab, type StateRoots } from "../storage/state";

/** Read one owner-scoped bounded provisioning transcript. */
export async function readProvisioningDiagnostic(
  roots: StateRoots,
  owner: string,
  id: string,
): Promise<unknown> {
  const lab = await readLab(roots, owner, id);
  if (lab.state !== "failed") throw new Error(`lab is not failed: ${lab.state}`);
  const failure = lab.provisioningFailure;
  if (!failure?.evidence?.available) throw new Error("terminal provisioning diagnostic is unavailable");
  if (!await exactDirectoryChain(roots.runtimeRoot, [lab.ownerKey, lab.id], "lab runtime directory")) {
    throw new Error("terminal provisioning diagnostic is unavailable");
  }
  const path = join(lab.runtimeRoot, PROVISIONING_FAILURE_DIAGNOSTIC_FILE);
  const metadata = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("terminal provisioning diagnostic is unavailable");
  }
  const stored = await readFile(path, "utf8");
  if (Buffer.byteLength(stored) > 8 * 1024) throw new Error("terminal provisioning diagnostic is unavailable");
  const text = redactPublicText(stored.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�"), 8 * 1024, 500);
  const lines = text ? text.split("\n").length : 0;
  if (lines > 500) throw new Error("terminal provisioning diagnostic is unavailable");
  return {
    labId: id,
    diagnostic: {
      phase: failure.phase,
      capturedAt: failure.capturedAt,
      services: failure.services,
      serviceCount: failure.serviceCount,
      evidence: failure.evidence,
      transcript: { text, truncated: failure.evidence.truncated, bytes: Buffer.byteLength(text), lines },
    },
  };
}
