#!/usr/bin/env bun
// @bun

// packages/command-routing/src/manage-command-output.ts
import { lstatSync, realpathSync, statSync } from "fs";
import { isAbsolute, join } from "path";
import process from "process";

// packages/command-routing/src/manage-command-output/lexer.ts
var shellControlWords = new Set([
  "case",
  "coproc",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "time",
  "until",
  "while"
]);
function initialState() {
  return {
    commands: [],
    words: [],
    word: "",
    wordStarted: false,
    atWordStart: true,
    requiresCommand: false
  };
}
function finishWord(state) {
  if (!state.wordStarted) {
    return;
  }
  state.words.push(state.word);
  state.word = "";
  state.wordStarted = false;
}
function finishCommand(state) {
  finishWord(state);
  if (state.words.length > 0) {
    state.commands.push({
      words: state.words,
      uncertain: state.words.map(() => false)
    });
  }
  state.words = [];
  return true;
}
function isUnsupportedSyntax(character) {
  return [
    "\\",
    "`",
    "$",
    "(",
    ")",
    "{",
    "}",
    "[",
    "]",
    "'",
    '"',
    "*",
    "?",
    "!",
    "<",
    ">"
  ].includes(character);
}
function isCommandSeparator(character) {
  return character === `
` || character === ";" || character === "&" || character === "|";
}
function isWordWhitespace(character) {
  return character === " " || character === "\t";
}
function consumeSeparator(state, script, index) {
  const separator = script[index];
  if (state.words.length === 0 && !state.wordStarted) {
    return;
  }
  if (separator === ";" && script[index + 1] === ";") {
    return;
  }
  if ((separator === "&" || separator === "|") && script[index + 1] !== separator) {
    return;
  }
  if (!finishCommand(state)) {
    return;
  }
  state.atWordStart = true;
  state.requiresCommand = separator === "&" || separator === "|";
  return script[index + 1] === separator ? index + 1 : index;
}
function consumeCharacter(state, script, index, character) {
  if (isCommandSeparator(character)) {
    return consumeSeparator(state, script, index);
  }
  if (isWordWhitespace(character)) {
    finishWord(state);
    state.atWordStart = true;
    return index;
  }
  state.word += character;
  state.wordStarted = true;
  state.atWordStart = false;
  state.requiresCommand = false;
  return index;
}
function containsControlWord(commands) {
  return commands.some((command) => command.words.some((word) => shellControlWords.has(word)));
}
function simpleCommands(script) {
  const state = initialState();
  for (let index = 0;index < script.length; index += 1) {
    const character = script.charAt(index);
    if (isUnsupportedSyntax(character)) {
      return;
    }
    if (character === "#" && state.atWordStart) {
      return;
    }
    const nextIndex = consumeCharacter(state, script, index, character);
    if (nextIndex === undefined) {
      return;
    }
    index = nextIndex;
  }
  if (state.requiresCommand || !finishCommand(state)) {
    return;
  }
  if (state.commands.length === 0 || containsControlWord(state.commands)) {
    return;
  }
  return state.commands;
}

// packages/command-routing/src/manage-command-output/normalize.ts
var rustupToolchains = new Set(["stable", "beta", "nightly"]);
var xcrunNoArgumentOptions = new Set([
  "--log",
  "-log",
  "--verbose",
  "-v",
  "--no-cache",
  "--run"
]);
var xcrunSdkOptions = new Set(["--sdk", "-sdk"]);
var xcrunSdks = new Set(["macosx", "iphonesimulator"]);
var canonicalWord = /^[A-Za-z0-9][A-Za-z0-9+._-]*$/u;
var assignment = /^[A-Za-z_][A-Za-z0-9_]*=/u;
function current(cursor, offset = 0) {
  return cursor.command.words[cursor.index + offset];
}
function isCertain(cursor, offset = 0) {
  return !cursor.command.uncertain[cursor.index + offset];
}
function isCanonicalWord(word) {
  return word !== undefined && canonicalWord.test(word);
}
function consumeXcrunSdk(cursor) {
  const value = current(cursor, 1);
  if (!(value && xcrunSdks.has(value) && isCertain(cursor, 1))) {
    return false;
  }
  cursor.index += 2;
  return true;
}
function consumeXcrunOptions(cursor) {
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
function consumeLauncher(cursor) {
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
  if (current(cursor, 1) !== "run" || !isCertain(cursor, 1) || !rustupToolchains.has(toolchain ?? "") || !isCertain(cursor, 2)) {
    return false;
  }
  cursor.index += 3;
  return true;
}
function normalizeCommand(command) {
  const cursor = { command, index: 0 };
  const first = current(cursor);
  if (!first || assignment.test(first) || first === "env") {
    return;
  }
  if (!consumeLauncher(cursor)) {
    return;
  }
  const program = current(cursor);
  if (!(isCanonicalWord(program) && isCertain(cursor))) {
    return;
  }
  return {
    words: [program, ...command.words.slice(cursor.index + 1)],
    uncertain: [
      command.uncertain[cursor.index] ?? false,
      ...command.uncertain.slice(cursor.index + 1)
    ]
  };
}

// packages/command-routing/src/manage-command-output/policy.ts
var containerLabGlobalOptions = new Set([
  "--owner",
  "--state-root",
  "--runtime-root"
]);
var cargoActions = new Set([
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
  "llvm-cov"
]);
var cargoToolchains = new Set(["+stable", "+beta", "+nightly"]);
var flutterActions = new Set(["test", "analyze", "drive", "build"]);
var dartActions = new Set(["test", "analyze"]);
var swiftActions = new Set(["build", "test"]);
var gradlePrefixes = [
  "build",
  "assemble",
  "bundle",
  "check",
  "test",
  "connected",
  "lint"
];
function isCertain2(command, index) {
  return !command.uncertain[index];
}
function hasContainerLabOptionValue(command, index) {
  const value = command.words[index + 1];
  return isCertain2(command, index) && value !== undefined && !value.startsWith("--") && isCertain2(command, index + 1);
}
function isContainerLabRun(command) {
  const { words } = command;
  if (words[0] !== "codex-container-lab" || !isCertain2(command, 0)) {
    return false;
  }
  let index = 1;
  while (containerLabGlobalOptions.has(words[index] ?? "")) {
    if (!hasContainerLabOptionValue(command, index)) {
      return false;
    }
    index += 2;
  }
  return words[index] === "run" && isCertain2(command, index);
}
function isCargoCommand(words) {
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
function isGradleBuildOrTestTask(word) {
  if (word.startsWith("-")) {
    return false;
  }
  const task = word.split(":").at(-1)?.toLowerCase() ?? "";
  return gradlePrefixes.some((prefix) => task === prefix || task.startsWith(prefix));
}
function isKnownNormalizedCommand(words) {
  const [program, subcommand, third] = words;
  if (program === "bun") {
    return subcommand === "test" || subcommand === "run" && third === "test";
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
  return (program === "gradle" || program === "gradlew") && words.slice(1).some(isGradleBuildOrTestTask);
}
function isRecognized(command) {
  if (!command || command.words.length < 2) {
    return false;
  }
  if (isContainerLabRun(command)) {
    return true;
  }
  const normalized = normalizeCommand(command);
  return normalized !== undefined && (isContainerLabRun(normalized) || isKnownNormalizedCommand(normalized.words));
}
function isManagedScript(script) {
  const commands = simpleCommands(script);
  return commands?.every(isRecognized) ?? false;
}

// packages/command-routing/src/manage-command-output.ts
var maximumScriptLength = 64 * 1024;
function pluginRootFrom(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--plugin-root" || !arguments_[1] || !isAbsolute(arguments_[1]) || arguments_[1].includes("\x00")) {
    return;
  }
  try {
    if (!lstatSync(arguments_[1]).isDirectory()) {
      return;
    }
    const pluginRoot = realpathSync(arguments_[1]);
    const runtimeRoot = join(pluginRoot, "runtime");
    const supervisor = join(pluginRoot, "runtime", "codex-command.ts");
    if (!(statSync(pluginRoot).isDirectory() && lstatSync(runtimeRoot).isDirectory() && lstatSync(supervisor).isFile())) {
      return;
    }
    return pluginRoot;
  } catch {
    return;
  }
}
function shellWord(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hookEvent(value) {
  if (!isRecord(value)) {
    return;
  }
  const toolInput = value["tool_input"];
  if (toolInput !== undefined && !isRecord(toolInput)) {
    return;
  }
  return {
    hook_event_name: value["hook_event_name"],
    ...toolInput === undefined ? {} : { tool_input: toolInput }
  };
}
function commandFrom(input) {
  if (!input) {
    return;
  }
  for (const key of ["cmd", "command"]) {
    const value = input[key];
    if (typeof value === "string") {
      return { key, value };
    }
  }
  return;
}
function rewrittenCommand(event, pluginRoot) {
  if (event.hook_event_name !== "PreToolUse") {
    return;
  }
  const command = commandFrom(event.tool_input);
  if (!command || command.value.length === 0 || command.value.length > maximumScriptLength || !isManagedScript(command.value)) {
    return;
  }
  const encoded = Buffer.from(command.value, "utf8").toString("base64url");
  const supervisor = join(pluginRoot, "runtime", "codex-command.ts");
  const runner = `bun ${shellWord(supervisor)}`;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: {
        ...event.tool_input,
        [command.key]: `${runner} run --base64url ${encoded}`
      }
    }
  });
}
var raw = await Bun.stdin.text();
try {
  const parsed = JSON.parse(raw);
  const event = hookEvent(parsed);
  const pluginRoot = pluginRootFrom(process.argv.slice(2));
  let output;
  if (event && pluginRoot) {
    output = rewrittenCommand(event, pluginRoot);
  }
  if (output) {
    console.log(output);
  }
} catch {}
