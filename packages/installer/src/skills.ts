import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import {
  assertManagedParentsAreReal,
  copyDirectoryExclusive,
  pathEntryExists,
  rollbackStagedMoves,
  sameTree,
} from "./managed-files.ts";

export type Transfer = "link" | "copy";

export interface SkillsReceipt {
  version: 1;
  sourceRoot: string;
  transfer: Transfer;
  skills: { name: string; target: string }[];
}

export interface SkillsOptions {
  codexHome: string;
  sourceRoot: string;
  transfer: Transfer;
  dryRun?: boolean;
}

const receiptName = "skills-receipt.json";

export function skillsReceiptPath(codexHome: string): string {
  return join(resolve(codexHome), ".skizzles", receiptName);
}

function publicSkills(
  sourceRoot: string,
): Array<{ name: string; source: string }> {
  const root = join(resolve(sourceRoot), "skills");
  if (!existsSync(root)) {
    throw new Error(`canonical skills directory is missing: ${root}`);
  }
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md")),
    )
    .map((entry) => ({ name: entry.name, source: join(root, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function readReceipt(codexHome: string): SkillsReceipt {
  const path = skillsReceiptPath(codexHome);
  if (!existsSync(path)) {
    throw new Error(`Skizzles skills receipt is missing: ${path}`);
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const value = objectValue(parsed);
  if (
    value?.["version"] !== 1 ||
    (value["transfer"] !== "link" && value["transfer"] !== "copy") ||
    typeof value["sourceRoot"] !== "string" ||
    !Array.isArray(value["skills"])
  ) {
    throw new Error(`invalid Skizzles skills receipt: ${path}`);
  }
  const skills: { name: string; target: string }[] = [];
  for (const item of value["skills"]) {
    const skill = objectValue(item);
    if (
      typeof skill?.["name"] !== "string" ||
      typeof skill["target"] !== "string"
    ) {
      throw new Error(`invalid Skizzles skills receipt: ${path}`);
    }
    skills.push({ name: skill["name"], target: skill["target"] });
  }
  return {
    version: 1,
    sourceRoot: value["sourceRoot"],
    transfer: value["transfer"],
    skills,
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

export function installSkills(options: SkillsOptions): SkillsReceipt {
  const codexHome = resolve(options.codexHome);
  const sourceRoot = resolve(options.sourceRoot);
  assertManagedParentsAreReal(codexHome, ["skills", ".skizzles"]);
  const receiptPath = skillsReceiptPath(codexHome);
  if (pathEntryExists(receiptPath)) {
    throw new Error(`Skizzles skills receipt already exists: ${receiptPath}`);
  }

  const skills = publicSkills(sourceRoot).map(({ name, source }) => ({
    name,
    source,
    target: join(codexHome, "skills", name),
  }));
  if (skills.length === 0) {
    throw new Error("no public skills were found");
  }
  const conflict = skills.find(({ target }) => pathEntryExists(target));
  if (conflict) {
    throw new Error(`refusing to replace existing skill: ${conflict.target}`);
  }

  const receipt: SkillsReceipt = {
    version: 1,
    sourceRoot,
    transfer: options.transfer,
    skills: skills.map(({ name, target }) => ({ name, target })),
  };
  if (options.dryRun) {
    return receipt;
  }

  mkdirSync(join(codexHome, "skills"), { recursive: true });
  const created: string[] = [];
  try {
    for (const skill of skills) {
      if (options.transfer === "link") {
        symlinkSync(skill.source, skill.target, "dir");
      } else {
        copyDirectoryExclusive(skill.source, skill.target);
      }
      created.push(skill.target);
    }
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
    });
  } catch (error) {
    for (const target of created.reverse()) {
      rmSync(target, { recursive: true, force: true });
    }
    throw error;
  }
  return receipt;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing cohesive control flow is outside this type-and-lint baseline migration.
export function uninstallSkills(
  codexHomeInput: string,
  dryRun = false,
  move: (from: string, to: string) => void = renameSync,
): SkillsReceipt {
  const codexHome = resolve(codexHomeInput);
  assertManagedParentsAreReal(codexHome, ["skills", ".skizzles"]);
  const receipt = readReceipt(codexHome);
  for (const skill of receipt.skills) {
    const target = resolve(skill.target);
    const expectedParent = join(codexHome, "skills");
    if (dirname(target) !== expectedParent || !pathEntryExists(target)) {
      throw new Error(
        `owned skill target is missing or outside CODEX_HOME: ${target}`,
      );
    }
    const source = join(receipt.sourceRoot, "skills", skill.name);
    if (receipt.transfer === "link") {
      if (!lstatSync(target).isSymbolicLink()) {
        throw new Error(`owned link changed type: ${target}`);
      }
      const actual = resolve(dirname(target), readlinkSync(target));
      if (actual !== resolve(source)) {
        throw new Error(`owned link target drifted: ${target}`);
      }
    } else if (!sameTree(source, target)) {
      throw new Error(`owned copied skill drifted: ${target}`);
    }
  }
  if (dryRun) {
    return receipt;
  }
  const quarantine = join(
    codexHome,
    ".skizzles",
    `uninstall-${crypto.randomUUID()}`,
  );
  mkdirSync(quarantine);
  const moved: Array<{ from: string; to: string }> = [];
  try {
    for (const skill of receipt.skills) {
      const destination = join(quarantine, skill.name);
      move(skill.target, destination);
      moved.push({ from: skill.target, to: destination });
    }
    const receiptPath = skillsReceiptPath(codexHome);
    const receiptDestination = join(quarantine, receiptName);
    move(receiptPath, receiptDestination);
    moved.push({ from: receiptPath, to: receiptDestination });
  } catch (error) {
    rollbackStagedMoves(moved);
    rmSync(quarantine, { recursive: true, force: true });
    throw error;
  }
  try {
    rmSync(quarantine, { recursive: true, force: true });
    // biome-ignore lint/suspicious/noEmptyBlockStatements: The operation intentionally ignores this best-effort failure.
  } catch {}
  return receipt;
}

export function receiptSummary(
  receipt: SkillsReceipt,
): Record<string, unknown> {
  return {
    surface: "skills",
    transfer: receipt.transfer,
    sourceRoot: receipt.sourceRoot,
    skills: receipt.skills.map(({ name, target }) => ({
      name,
      target: relative(process.cwd(), target) || target,
    })),
  };
}
