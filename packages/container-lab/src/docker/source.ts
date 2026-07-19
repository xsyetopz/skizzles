import { join } from "node:path";
import {
  composeCommandArgs,
  emptyComposeEnvironmentFile,
} from "../compose/generation.ts";
import type { LabRuntime } from "./contract.ts";

/** Return the exact validated materialized Compose arguments or fail closed. */
export function immutableComposeArguments(runtime: LabRuntime): string[] {
  const expectedSource = join(
    runtime.metadata.runtimeRoot,
    "source.compose.json",
  );
  const expectedOverride = join(
    runtime.metadata.runtimeRoot,
    "override.compose.yaml",
  );
  if (
    runtime.sourceFile !== expectedSource ||
    runtime.overrideFile !== expectedOverride
  ) {
    throw new Error(
      "lab runtime has no valid immutable Compose source; recreate the lab",
    );
  }
  const expected = composeCommandArgs(runtime.config, {
    projectName: runtime.metadata.composeProject,
    overrideFile: expectedOverride,
    sourceFiles: [expectedSource],
    environmentFile: emptyComposeEnvironmentFile,
  });
  if (
    runtime.composeArgs.length !== expected.length ||
    !runtime.composeArgs.every(
      (argument, index) => argument === expected[index],
    )
  ) {
    throw new Error(
      "lab runtime has no valid immutable Compose source; recreate the lab",
    );
  }
  return runtime.composeArgs;
}
