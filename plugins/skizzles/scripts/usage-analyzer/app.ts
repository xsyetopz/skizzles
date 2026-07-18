import { join } from "node:path";
import { buildReport } from "./aggregation.ts";
import { parseArgs } from "./cli.ts";
import { printHuman, printJson } from "./report.ts";
import { listRollouts } from "./rollout-discovery.ts";

export async function run(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const options = parseArgs(argv);
  const codexHome =
    environment["CODEX_HOME"] ?? join(environment["HOME"] ?? "", ".codex");
  const paths = await listRollouts(codexHome);
  const report = await buildReport(codexHome, paths, options);
  if (options.json) printJson(report);
  else printHuman(report);
}
