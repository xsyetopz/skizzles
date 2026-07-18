import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import type { OrchestrationMode } from "./config.ts";
import type { Transfer } from "./skills.ts";

interface DryRunCommand {
  dryRun: boolean;
}

interface InstallSkillsCommand extends DryRunCommand {
  command: "install";
  surface: "skills";
  codexHome: string;
  sourceRoot: string;
  transfer: Transfer;
}

interface InstallHarnessCommand extends DryRunCommand {
  command: "install";
  surface: "harness";
  home: string;
  sourceRoot: string;
  transfer: Transfer;
}

interface UninstallSkillsCommand extends DryRunCommand {
  command: "uninstall";
  surface: "skills";
  codexHome: string;
}

interface UninstallHarnessCommand extends DryRunCommand {
  command: "uninstall";
  surface: "harness";
  home: string;
}

interface DoctorCommand {
  command: "doctor";
  home: string;
  codexHome: string;
}

interface ConfigureCommand extends DryRunCommand {
  command: "configure";
  codexHome: string;
  codexBinary: string;
  orchestration: OrchestrationMode;
}

interface UnconfigureCommand extends DryRunCommand {
  command: "unconfigure";
  codexHome: string;
  codexBinary: string;
}

interface ApplyPromptPolicyCommand extends DryRunCommand {
  command: "prompt-policy";
  action: "apply";
  codexHome: string;
  codexBinary: string;
  sourceRoot: string;
}

interface RestorePromptPolicyCommand extends DryRunCommand {
  command: "prompt-policy";
  action: "restore";
  codexHome: string;
  codexBinary: string;
}

export type ParsedCommand =
  | InstallSkillsCommand
  | InstallHarnessCommand
  | UninstallSkillsCommand
  | UninstallHarnessCommand
  | DoctorCommand
  | ConfigureCommand
  | UnconfigureCommand
  | ApplyPromptPolicyCommand
  | RestorePromptPolicyCommand;

type ValueFlag =
  | "codexHome"
  | "codexBinary"
  | "orchestration"
  | "home"
  | "sourceRoot"
  | "transfer"
  | "surface";
type Flag = ValueFlag | "dryRun";
type ParsedFlags = Partial<Record<ValueFlag, string>> & { dryRun: boolean };

const FLAG_NAMES: Record<string, Flag> = {
  "--codex-home": "codexHome",
  "--codex-binary": "codexBinary",
  "--orchestration": "orchestration",
  "--home": "home",
  "--source-root": "sourceRoot",
  "--transfer": "transfer",
  "--mode": "transfer",
  "--surface": "surface",
  "--dry-run": "dryRun",
};

function usage(): never {
  console.error(
    "usage: skizzles-installer install --surface <skills|harness> [--codex-home PATH|--home PATH] [--source-root PATH] [--transfer link|copy] [--dry-run] | uninstall --surface <skills|harness> [--codex-home PATH|--home PATH] [--dry-run] | configure --codex-home PATH --codex-binary PATH --orchestration <aggressive|passive> [--dry-run] | unconfigure --codex-home PATH --codex-binary PATH [--dry-run] | prompt-policy apply --codex-home PATH --codex-binary ABSOLUTE_PATH --source-root PATH [--dry-run] | prompt-policy restore --codex-home PATH --codex-binary ABSOLUTE_PATH [--dry-run] | doctor --home PATH --codex-home PATH",
  );
  process.exit(2);
}

export function parseInstallerCommand(argv: string[]): ParsedCommand {
  const remaining = [...argv];
  const command = remaining.shift();
  switch (command) {
    case "install":
      return parseInstall(remaining);
    case "uninstall":
      return parseUninstall(remaining);
    case "doctor":
      return parseDoctor(remaining);
    case "configure":
      return parseConfigure(remaining);
    case "unconfigure":
      return parseUnconfigure(remaining);
    case "prompt-policy":
      return parsePromptPolicy(remaining);
    default:
      return usage();
  }
}

function parseInstall(
  argv: string[],
): InstallSkillsCommand | InstallHarnessCommand {
  const flags = parseFlags(
    argv,
    allowed("surface", "codexHome", "home", "sourceRoot", "transfer", "dryRun"),
  );
  const surface = parseSurface(required(flags.surface));
  const sourceRoot = resolve(flags.sourceRoot ?? defaultSourceRoot());
  const transfer = parseTransfer(flags.transfer ?? "link");
  if (surface === "skills") {
    if (flags.home !== undefined) {
      usage();
    }
    return {
      command: "install",
      surface,
      codexHome: resolve(required(flags.codexHome)),
      sourceRoot,
      transfer,
      dryRun: flags.dryRun,
    };
  }
  if (flags.codexHome !== undefined) {
    usage();
  }
  return {
    command: "install",
    surface,
    home: resolve(required(flags.home)),
    sourceRoot,
    transfer,
    dryRun: flags.dryRun,
  };
}

function parseUninstall(
  argv: string[],
): UninstallSkillsCommand | UninstallHarnessCommand {
  const flags = parseFlags(
    argv,
    allowed("surface", "codexHome", "home", "dryRun"),
  );
  const surface = parseSurface(required(flags.surface));
  if (surface === "skills") {
    if (flags.home !== undefined) {
      usage();
    }
    return {
      command: "uninstall",
      surface,
      codexHome: resolve(required(flags.codexHome)),
      dryRun: flags.dryRun,
    };
  }
  if (flags.codexHome !== undefined) {
    usage();
  }
  return {
    command: "uninstall",
    surface,
    home: resolve(required(flags.home)),
    dryRun: flags.dryRun,
  };
}

function parseDoctor(argv: string[]): DoctorCommand {
  const flags = parseFlags(argv, allowed("home", "codexHome"));
  return {
    command: "doctor",
    home: resolve(required(flags.home)),
    codexHome: resolve(required(flags.codexHome)),
  };
}

function parseConfigure(argv: string[]): ConfigureCommand {
  const flags = parseFlags(
    argv,
    allowed("codexHome", "codexBinary", "orchestration", "dryRun"),
  );
  return {
    command: "configure",
    codexHome: resolve(required(flags.codexHome)),
    codexBinary: required(flags.codexBinary),
    orchestration: parseOrchestration(required(flags.orchestration)),
    dryRun: flags.dryRun,
  };
}

function parseUnconfigure(argv: string[]): UnconfigureCommand {
  const flags = parseFlags(argv, allowed("codexHome", "codexBinary", "dryRun"));
  return {
    command: "unconfigure",
    codexHome: resolve(required(flags.codexHome)),
    codexBinary: required(flags.codexBinary),
    dryRun: flags.dryRun,
  };
}

function parsePromptPolicy(
  argv: string[],
): ApplyPromptPolicyCommand | RestorePromptPolicyCommand {
  const action = argv.shift();
  if (action === "apply") {
    const flags = parseFlags(
      argv,
      allowed("codexHome", "codexBinary", "sourceRoot", "dryRun"),
    );
    return {
      command: "prompt-policy",
      action,
      codexHome: resolve(required(flags.codexHome)),
      codexBinary: absoluteBinary(required(flags.codexBinary)),
      sourceRoot: resolve(required(flags.sourceRoot)),
      dryRun: flags.dryRun,
    };
  }
  if (action === "restore") {
    const flags = parseFlags(
      argv,
      allowed("codexHome", "codexBinary", "dryRun"),
    );
    return {
      command: "prompt-policy",
      action,
      codexHome: resolve(required(flags.codexHome)),
      codexBinary: absoluteBinary(required(flags.codexBinary)),
      dryRun: flags.dryRun,
    };
  }
  return usage();
}

function parseFlags(
  argv: string[],
  allowedFlags: ReadonlySet<Flag>,
): ParsedFlags {
  const parsed: ParsedFlags = { dryRun: false };
  const seen = new Set<Flag>();
  while (argv.length > 0) {
    const spelling = argv.shift();
    const flag = spelling === undefined ? undefined : FLAG_NAMES[spelling];
    if (flag === undefined || !allowedFlags.has(flag) || seen.has(flag)) {
      usage();
    }
    seen.add(flag);
    if (flag === "dryRun") {
      parsed.dryRun = true;
    } else {
      parsed[flag] = required(argv.shift());
    }
  }
  return parsed;
}

function allowed(...flags: Flag[]): ReadonlySet<Flag> {
  return new Set(flags);
}

function required(value: string | undefined): string {
  return value ?? usage();
}

function parseSurface(value: string): "skills" | "harness" {
  if (value === "skills" || value === "harness") {
    return value;
  }
  return usage();
}

function parseTransfer(value: string): Transfer {
  if (value === "link" || value === "copy") {
    return value;
  }
  return usage();
}

function parseOrchestration(value: string): OrchestrationMode {
  if (value === "aggressive" || value === "passive") {
    return value;
  }
  return usage();
}

function absoluteBinary(value: string): string {
  if (!isAbsolute(value)) {
    usage();
  }
  return value;
}

function defaultSourceRoot(): string {
  return resolve(import.meta.dir, "../../..");
}
