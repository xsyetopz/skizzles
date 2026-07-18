#!/usr/bin/env bun
import { isAbsolute, resolve } from "node:path";
import {
  configureCodex,
  type OrchestrationMode,
  unconfigureCodex,
} from "./config.ts";
import {
  installSkills,
  receiptSummary,
  type Transfer,
  uninstallSkills,
} from "./core.ts";
import { doctor } from "./doctor.ts";
import { installHarness, uninstallHarness } from "./harness.ts";
import {
  applyPromptPolicy,
  promptPolicySummary,
  restorePromptPolicy,
} from "./prompt-policy.ts";

type Parsed = {
  command:
    | "install"
    | "uninstall"
    | "doctor"
    | "configure"
    | "unconfigure"
    | "prompt-policy";
  promptPolicyAction: "apply" | "restore" | undefined;
  surface: "skills" | "harness" | undefined;
  codexHome: string | undefined;
  codexBinary: string | undefined;
  orchestration: OrchestrationMode | undefined;
  home: string | undefined;
  sourceRoot: string | undefined;
  transfer: Transfer;
  dryRun: boolean;
};

function usage(): never {
  console.error(
    "usage: bun packages/installer/src/cli.ts <install|uninstall> --surface <skills|harness> [--codex-home PATH] [--home PATH] [--source-root PATH] [--transfer link|copy] [--dry-run] | configure --codex-home PATH --codex-binary PATH --orchestration <aggressive|passive> [--dry-run] | unconfigure --codex-home PATH --codex-binary PATH [--dry-run] | prompt-policy apply --codex-home PATH --codex-binary ABSOLUTE_PATH --source-root PATH [--dry-run] | prompt-policy restore --codex-home PATH --codex-binary ABSOLUTE_PATH [--dry-run] | doctor --home PATH --codex-home PATH",
  );
  process.exit(2);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing cohesive control flow is outside this type-and-lint baseline migration.
function parse(argv: string[]): Parsed {
  const command = argv.shift();
  if (
    ![
      "install",
      "uninstall",
      "doctor",
      "configure",
      "unconfigure",
      "prompt-policy",
    ].includes(command ?? "")
  )
    usage();
  let promptPolicyAction: "apply" | "restore" | undefined;
  if (command === "prompt-policy") {
    const action = argv.shift();
    if (action !== "apply" && action !== "restore") usage();
    promptPolicyAction = action;
  }
  let codexHome: string | undefined;
  let codexBinary: string | undefined;
  let orchestration: OrchestrationMode | undefined;
  let home: string | undefined;
  let sourceRoot: string | undefined;
  let transfer: Transfer = "link";
  let surface: "skills" | "harness" | undefined;
  let dryRun = false;
  while (argv.length > 0) {
    const flag = argv.shift();
    if (flag === "--dry-run") dryRun = true;
    else if (flag === "--codex-home") codexHome = argv.shift();
    else if (flag === "--codex-binary") codexBinary = argv.shift();
    else if (flag === "--orchestration") {
      const value = argv.shift();
      if (value !== "aggressive" && value !== "passive") usage();
      orchestration = value;
    } else if (flag === "--home") home = argv.shift();
    else if (flag === "--source-root") {
      sourceRoot = resolve(argv.shift() ?? usage());
    } else if (flag === "--transfer" || flag === "--mode") {
      const mode = argv.shift();
      if (mode !== "link" && mode !== "copy") usage();
      transfer = mode;
    } else if (flag === "--surface") {
      const value = argv.shift();
      if (value !== "skills" && value !== "harness") usage();
      surface = value;
    } else usage();
  }
  if (command === "doctor") {
    if (
      !(home && codexHome) ||
      surface ||
      codexBinary ||
      orchestration ||
      sourceRoot
    )
      usage();
  } else if (command === "configure") {
    if (
      !(codexHome && codexBinary && orchestration) ||
      surface ||
      home ||
      sourceRoot
    ) {
      usage();
    }
  } else if (command === "unconfigure") {
    if (
      !(codexHome && codexBinary) ||
      orchestration ||
      surface ||
      home ||
      sourceRoot
    )
      usage();
  } else if (command === "prompt-policy") {
    if (
      !(codexHome && codexBinary) ||
      surface ||
      home ||
      orchestration ||
      (promptPolicyAction === "apply"
        ? !sourceRoot
        : sourceRoot !== undefined) ||
      !isAbsolute(codexBinary)
    ) {
      usage();
    }
  } else if (
    !surface ||
    (surface === "skills" && !codexHome) ||
    (surface === "harness" && !home)
  )
    usage();
  return {
    command: command as Parsed["command"],
    promptPolicyAction,
    surface,
    codexHome: codexHome && resolve(codexHome),
    codexBinary,
    orchestration,
    home: home && resolve(home),
    sourceRoot:
      sourceRoot ??
      (command === "install"
        ? resolve(import.meta.dir, "../../..")
        : undefined),
    transfer,
    dryRun,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The command dispatcher keeps validation and one-shot surface routing cohesive.
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parse([...argv]);
  if (parsed.command === "doctor") {
    const report = doctor(parsed.home!, parsed.codexHome!);
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (parsed.command === "configure" || parsed.command === "unconfigure") {
    const receipt =
      parsed.command === "configure"
        ? await configureCodex({
            codexHome: parsed.codexHome!,
            codexBinary: parsed.codexBinary!,
            orchestration: parsed.orchestration!,
            dryRun: parsed.dryRun,
          })
        : await unconfigureCodex({
            codexHome: parsed.codexHome!,
            codexBinary: parsed.codexBinary!,
            dryRun: parsed.dryRun,
          });
    console.log(
      JSON.stringify({
        ok: true,
        dryRun: parsed.dryRun,
        surface: "config",
        orchestration: receipt.orchestration,
        configPath: receipt.configPath,
        keys: receipt.values.map(({ keyPath }) => keyPath),
      }),
    );
    return;
  }
  if (parsed.command === "prompt-policy") {
    const outcome =
      parsed.promptPolicyAction === "apply"
        ? await applyPromptPolicy({
            codexHome: parsed.codexHome!,
            codexBinary: parsed.codexBinary!,
            sourceRoot: parsed.sourceRoot!,
            dryRun: parsed.dryRun,
          })
        : await restorePromptPolicy({
            codexHome: parsed.codexHome!,
            codexBinary: parsed.codexBinary!,
            dryRun: parsed.dryRun,
          });
    console.log(JSON.stringify(promptPolicySummary(outcome, parsed.dryRun)));
    return;
  }
  if (parsed.surface === "skills") {
    const receipt =
      parsed.command === "install"
        ? installSkills({
            codexHome: parsed.codexHome!,
            sourceRoot: parsed.sourceRoot!,
            transfer: parsed.transfer,
            dryRun: parsed.dryRun,
          })
        : uninstallSkills(parsed.codexHome!, parsed.dryRun);
    console.log(
      JSON.stringify({
        ok: true,
        dryRun: parsed.dryRun,
        ...receiptSummary(receipt),
      }),
    );
  } else {
    const receipt =
      parsed.command === "install"
        ? installHarness({
            home: parsed.home!,
            sourceRoot: parsed.sourceRoot!,
            transfer: parsed.transfer,
            dryRun: parsed.dryRun,
          })
        : uninstallHarness(parsed.home!, parsed.dryRun);
    console.log(
      JSON.stringify({
        ok: true,
        dryRun: parsed.dryRun,
        surface: "harness",
        transfer: receipt.transfer,
        pluginTarget: receipt.pluginTarget,
      }),
    );
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "installer failed");
    process.exit(1);
  });
}
