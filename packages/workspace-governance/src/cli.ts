import { resolve } from "node:path";
import process from "node:process";
import {
  SKIZZLES_PACKAGE_NAMES,
  validateWorkspace,
} from "./workspace/policy.ts";

async function main(args: readonly string[]): Promise<0 | 1> {
  const root = resolve(args[0] ?? process.cwd());
  const findings = await validateWorkspace(root, {
    expectedPackageNames: SKIZZLES_PACKAGE_NAMES,
  });
  if (findings.length === 0) {
    process.stdout.write("Workspace policy passed.\n");
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

export { main };
