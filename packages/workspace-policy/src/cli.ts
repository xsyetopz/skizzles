import { resolve } from "node:path";
import process from "node:process";
import {
  SKIZZLES_PACKAGE_NAMES,
  validateWorkspace,
  validateWorkspaceArchitecture,
} from "./workspace/policy.ts";

export async function main(args: readonly string[]): Promise<0 | 1> {
  const architectureFitness = args[0] === "--architecture-fitness";
  const rootArgument = architectureFitness ? args[1] : args[0];
  const root = resolve(rootArgument ?? process.cwd());
  const validate = architectureFitness
    ? validateWorkspaceArchitecture
    : validateWorkspace;
  const findings = await validate(root, {
    expectedPackageNames: SKIZZLES_PACKAGE_NAMES,
  });
  if (findings.length === 0) {
    process.stdout.write(
      architectureFitness
        ? "Workspace architecture fitness passed.\n"
        : "Workspace policy passed.\n",
    );
    return 0;
  }
  for (const finding of findings) {
    process.stderr.write(
      `${finding.code}: ${finding.path}: ${finding.message}\n`,
    );
  }
  return 1;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
