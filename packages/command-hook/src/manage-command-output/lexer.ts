import type { SimpleCommand } from "./types.ts";

type LexerState = {
  commands: SimpleCommand[];
  words: string[];
  word: string;
  wordStarted: boolean;
  atWordStart: boolean;
  requiresCommand: boolean;
};

const shellControlWords = new Set([
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
  "while",
]);

function initialState(): LexerState {
  return {
    commands: [],
    words: [],
    word: "",
    wordStarted: false,
    atWordStart: true,
    requiresCommand: false,
  };
}

function finishWord(state: LexerState): void {
  if (!state.wordStarted) {
    return;
  }

  state.words.push(state.word);

  state.word = "";
  state.wordStarted = false;
}

function finishCommand(state: LexerState): boolean {
  finishWord(state);
  if (state.words.length > 0) {
    state.commands.push({
      words: state.words,
      uncertain: state.words.map(() => false),
    });
  }
  state.words = [];
  return true;
}

function isUnsupportedSyntax(character: string): boolean {
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
    ">",
  ].includes(character);
}

function isCommandSeparator(character: string): boolean {
  return (
    character === "\n" ||
    character === ";" ||
    character === "&" ||
    character === "|"
  );
}

function isWordWhitespace(character: string): boolean {
  return character === " " || character === "\t";
}

function consumeSeparator(
  state: LexerState,
  script: string,
  index: number,
): number | undefined {
  const separator = script[index];
  if (state.words.length === 0 && !state.wordStarted) {
    return undefined;
  }
  if (separator === ";" && script[index + 1] === ";") {
    return undefined;
  }
  if (
    (separator === "&" || separator === "|") &&
    script[index + 1] !== separator
  ) {
    return undefined;
  }
  if (!finishCommand(state)) {
    return undefined;
  }
  state.atWordStart = true;
  state.requiresCommand = separator === "&" || separator === "|";
  return script[index + 1] === separator ? index + 1 : index;
}

function consumeCharacter(
  state: LexerState,
  script: string,
  index: number,
  character: string,
): number | undefined {
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

function containsControlWord(commands: SimpleCommand[]): boolean {
  return commands.some((command) =>
    command.words.some((word) => shellControlWords.has(word)),
  );
}

/**
 * Lex only literal words separated by ASCII space/tab and top-level `&&`,
 * `||`, `;`, or newline. Adjacent separators (including `&&\n` and `;\n`),
 * quoting, comments, substitutions, expansion, grouping, pipelines,
 * backgrounding, redirection, globs, and control words return undefined.
 */
export function simpleCommands(script: string): SimpleCommand[] | undefined {
  const state = initialState();

  for (let index = 0; index < script.length; index += 1) {
    const character = script.charAt(index);
    if (isUnsupportedSyntax(character)) {
      return undefined;
    }
    if (character === "#" && state.atWordStart) {
      return undefined;
    }
    const nextIndex = consumeCharacter(state, script, index, character);
    if (nextIndex === undefined) {
      return undefined;
    }
    index = nextIndex;
  }

  if (state.requiresCommand || !finishCommand(state)) {
    return undefined;
  }
  if (state.commands.length === 0 || containsControlWord(state.commands)) {
    return undefined;
  }
  return state.commands;
}
