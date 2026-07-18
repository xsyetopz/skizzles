import type { SimpleCommand } from "./contract.ts";

type Cursor = {
  command: SimpleCommand;
  index: number;
};

const rustupToolchains = new Set(["stable", "beta", "nightly"]);
const xcrunNoArgumentOptions = new Set([
  "--log",
  "-log",
  "--verbose",
  "-v",
  "--no-cache",
  "--run",
]);
const xcrunSdkOptions = new Set(["--sdk", "-sdk"]);
const xcrunSdks = new Set(["macosx", "iphonesimulator"]);
const canonicalWord = /^[A-Za-z0-9][A-Za-z0-9+._-]*$/;
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;

function current(cursor: Cursor, offset = 0): string | undefined {
  return cursor.command.words[cursor.index + offset];
}

function isCertain(cursor: Cursor, offset = 0): boolean {
  return !cursor.command.uncertain[cursor.index + offset];
}

function isCanonicalWord(word: string | undefined): word is string {
  return word !== undefined && canonicalWord.test(word);
}

function consumeXcrunSdk(cursor: Cursor): boolean {
  const value = current(cursor, 1);
  if (!(value && xcrunSdks.has(value) && isCertain(cursor, 1))) {
    return false;
  }
  cursor.index += 2;
  return true;
}

function consumeXcrunOptions(cursor: Cursor): boolean {
  while (true) {
    const option = current(cursor);
    if (!(option && isCertain(cursor))) {
      return false;
    }
    if (option === "--") {
      cursor.index += 1;
      return true;
    }
    if (xcrunSdkOptions.has(option)) {
      if (!consumeXcrunSdk(cursor)) {
        return false;
      }
      continue;
    }
    if (xcrunNoArgumentOptions.has(option)) {
      cursor.index += 1;
      continue;
    }
    return !option.startsWith("-");
  }
}

function consumeLauncher(cursor: Cursor): boolean {
  const launcher = current(cursor);
  if (launcher === "fvm" && isCertain(cursor)) {
    cursor.index += 1;
    return true;
  }
  if (launcher === "xcrun" && isCertain(cursor)) {
    cursor.index += 1;
    return consumeXcrunOptions(cursor);
  }
  if (launcher !== "rustup" || !isCertain(cursor)) {
    return true;
  }
  const toolchain = current(cursor, 2);
  if (
    current(cursor, 1) !== "run" ||
    !isCertain(cursor, 1) ||
    !rustupToolchains.has(toolchain ?? "") ||
    !isCertain(cursor, 2)
  ) {
    return false;
  }
  cursor.index += 3;
  return true;
}

/**
 * Removes only canonical literal `fvm`, `rustup run`, and `xcrun` prefixes.
 * `xcrun` selectors are limited to the SDKs exercised by the hook contract;
 * assignment, `env`, custom toolchain, and arbitrary SDK prefixes are rejected.
 */
export function normalizeCommand(
  command: SimpleCommand,
): SimpleCommand | undefined {
  const cursor: Cursor = { command, index: 0 };
  const first = current(cursor);
  if (!first || assignment.test(first) || first === "env") {
    return undefined;
  }
  if (!consumeLauncher(cursor)) {
    return undefined;
  }

  const program = current(cursor);
  if (!(isCanonicalWord(program) && isCertain(cursor))) {
    return undefined;
  }
  return {
    words: [program, ...command.words.slice(cursor.index + 1)],
    uncertain: [
      command.uncertain[cursor.index] ?? false,
      ...command.uncertain.slice(cursor.index + 1),
    ],
  };
}
