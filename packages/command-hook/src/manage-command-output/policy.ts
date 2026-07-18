import { simpleCommands } from "./lexer.ts";
import { normalizeCommand } from "./normalize.ts";
import type { SimpleCommand } from "./types.ts";

const containerLabGlobalOptions = new Set([
  "--owner",
  "--state-root",
  "--runtime-root",
]);
const cargoActions = new Set([
  "build",
  "b",
  "check",
  "c",
  "test",
  "t",
  "clippy",
  "bench",
  "doc",
  "install",
  "llvm-cov",
]);
const cargoToolchains = new Set(["+stable", "+beta", "+nightly"]);
const flutterActions = new Set(["test", "analyze", "drive", "build"]);
const dartActions = new Set(["test", "analyze"]);
const swiftActions = new Set(["build", "test"]);
const gradlePrefixes = [
  "build",
  "assemble",
  "bundle",
  "check",
  "test",
  "connected",
  "lint",
];

function isCertain(command: SimpleCommand, index: number): boolean {
  return !command.uncertain[index];
}

function hasContainerLabOptionValue(
  command: SimpleCommand,
  index: number,
): boolean {
  const value = command.words[index + 1];
  return (
    isCertain(command, index) &&
    value !== undefined &&
    !value.startsWith("--") &&
    isCertain(command, index + 1)
  );
}

/** Trust only the bare installed launcher; script paths and `bun` indirection fail closed. */
function isContainerLabRun(command: SimpleCommand): boolean {
  const { words } = command;
  if (words[0] !== "codex-container-lab" || !isCertain(command, 0)) {
    return false;
  }
  let index = 1;

  while (containerLabGlobalOptions.has(words[index] ?? "")) {
    if (!hasContainerLabOptionValue(command, index)) {
      return false;
    }
    index += 2;
  }
  return words[index] === "run" && isCertain(command, index);
}

function isCargoCommand(words: string[]): boolean {
  const requestedToolchain = words[1]?.startsWith("+") ? words[1] : undefined;
  if (requestedToolchain && !cargoToolchains.has(requestedToolchain)) {
    return false;
  }
  const candidate = requestedToolchain ? words[2] : words[1];
  if (candidate === "nextest") {
    return words[words.indexOf(candidate) + 1] === "run";
  }
  return cargoActions.has(candidate ?? "");
}

function isGradleBuildOrTestTask(word: string): boolean {
  if (word.startsWith("-")) {
    return false;
  }
  const task = word.split(":").at(-1)?.toLowerCase() ?? "";
  return gradlePrefixes.some(
    (prefix) => task === prefix || task.startsWith(prefix),
  );
}

function isKnownNormalizedCommand(words: string[]): boolean {
  const [program, subcommand, third] = words;
  if (program === "bun") {
    return subcommand === "test" || (subcommand === "run" && third === "test");
  }
  if (program === "just") {
    return subcommand === "test";
  }
  if (program === "flutter") {
    return flutterActions.has(subcommand ?? "");
  }
  if (program === "dart") {
    return dartActions.has(subcommand ?? "");
  }
  if (program === "cargo") {
    return isCargoCommand(words);
  }
  if (program === "xcodebuild") {
    return true;
  }
  if (program === "swift") {
    return swiftActions.has(subcommand ?? "");
  }
  return (
    (program === "gradle" || program === "gradlew") &&
    words.slice(1).some(isGradleBuildOrTestTask)
  );
}

/** Returns true only for literal high-value commands in the supported shell subset. */
export function isRecognized(command: SimpleCommand | undefined): boolean {
  if (!command || command.words.length < 2) {
    return false;
  }
  if (isContainerLabRun(command)) {
    return true;
  }
  const normalized = normalizeCommand(command);
  return (
    normalized !== undefined &&
    (isContainerLabRun(normalized) ||
      isKnownNormalizedCommand(normalized.words))
  );
}

/** A script is rewritten only when every top-level command is recognized. */
export function isManagedScript(script: string): boolean {
  const commands = simpleCommands(script);
  return commands?.every(isRecognized) ?? false;
}

export { simpleCommands };
