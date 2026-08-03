import { assertReadyLabFilesystem, type StateRoots } from "../storage/state";
import type { LabMetadata } from "../storage/records";

export async function readyRuntimeProblem(roots: StateRoots, lab: LabMetadata): Promise<string | undefined> {
  try {
    await assertReadyLabFilesystem(roots, lab);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "runtime or workspace is missing";
    return error instanceof Error ? error.message : String(error);
  }
}
