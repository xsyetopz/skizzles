#!/usr/bin/env bun
import process from "node:process";
import { parseInstallerCommand } from "./cli-arguments.ts";
import { configureCodex, unconfigureCodex } from "./config.ts";
import { doctor } from "./doctor.ts";
import { installHarness, uninstallHarness } from "./harness.ts";
import {
  applyPromptPolicy,
  promptPolicySummary,
  restorePromptPolicy,
} from "./prompt-policy.ts";
import { installSkills, receiptSummary, uninstallSkills } from "./skills.ts";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseInstallerCommand(argv);
  switch (parsed.command) {
    case "doctor": {
      const report = doctor(parsed.home, parsed.codexHome);
      console.log(JSON.stringify(report));
      if (!report.ok) {
        process.exitCode = 1;
      }
      return;
    }
    case "configure": {
      const receipt = await configureCodex(parsed);
      printConfigSummary(receipt, parsed.dryRun);
      return;
    }
    case "unconfigure": {
      const receipt = await unconfigureCodex(parsed);
      printConfigSummary(receipt, parsed.dryRun);
      return;
    }
    case "prompt-policy": {
      const outcome =
        parsed.action === "apply"
          ? await applyPromptPolicy(parsed)
          : await restorePromptPolicy(parsed);
      console.log(JSON.stringify(promptPolicySummary(outcome, parsed.dryRun)));
      return;
    }
    case "install": {
      if (parsed.surface === "skills") {
        const receipt = installSkills(parsed);
        console.log(
          JSON.stringify({
            ok: true,
            dryRun: parsed.dryRun,
            ...receiptSummary(receipt),
          }),
        );
        return;
      }
      const receipt = installHarness(parsed);
      printHarnessSummary(receipt, parsed.dryRun);
      return;
    }
    case "uninstall": {
      if (parsed.surface === "skills") {
        const receipt = uninstallSkills(parsed.codexHome, parsed.dryRun);
        console.log(
          JSON.stringify({
            ok: true,
            dryRun: parsed.dryRun,
            ...receiptSummary(receipt),
          }),
        );
        return;
      }
      const receipt = uninstallHarness(parsed.home, parsed.dryRun);
      printHarnessSummary(receipt, parsed.dryRun);
      return;
    }
    default:
      return assertNever(parsed);
  }
}

function printConfigSummary(
  receipt: Awaited<ReturnType<typeof configureCodex>>,
  dryRun: boolean,
): void {
  console.log(
    JSON.stringify({
      ok: true,
      dryRun,
      surface: "config",
      orchestration: receipt.orchestration,
      configPath: receipt.configPath,
      keys: receipt.values.map(({ keyPath }) => keyPath),
    }),
  );
}

function printHarnessSummary(
  receipt: ReturnType<typeof installHarness>,
  dryRun: boolean,
): void {
  console.log(
    JSON.stringify({
      ok: true,
      dryRun,
      surface: "harness",
      transfer: receipt.transfer,
      pluginTarget: receipt.pluginTarget,
    }),
  );
}

function assertNever(value: never): never {
  throw new Error(`unreachable installer command: ${JSON.stringify(value)}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "installer failed");
    process.exit(1);
  });
}
