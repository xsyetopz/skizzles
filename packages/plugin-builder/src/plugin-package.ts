import process from "node:process";
import { GENERATED_PATH, PackagingError } from "./plugin/contract.ts";
import { buildPlugin, checkPlugin } from "./plugin/staging.ts";

export { PackagingError } from "./plugin/contract.ts";
export type { PackagePaths } from "./plugin/staging.ts";
export {
  buildPlugin,
  checkPlugin,
  packagePaths,
  stagePlugin,
} from "./plugin/staging.ts";
export { compareTrees } from "./plugin/tree-comparison.ts";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "build") {
    await buildPlugin();
    console.log(`Built ${GENERATED_PATH} from canonical sources.`);
    return;
  }
  if (command === "check") {
    await checkPlugin();
    console.log(`${GENERATED_PATH} matches canonical sources.`);
    return;
  }
  throw new PackagingError("Usage: skizzles-plugin-builder <build|check>");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
