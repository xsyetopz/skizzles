import process from "node:process";
import { buildPlugin, checkPlugin, PackagingError } from "./plugin/api.ts";
import { GENERATED_PATH } from "./plugin/contract.ts";

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
