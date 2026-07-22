import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseConventionalCommitMessage } from "./runtime.ts";

export const commitMessageHookEntrypoint = fileURLToPath(
  new URL("./cli.ts", import.meta.url),
);

export function commitMessageHookExitCode(
  argv: readonly string[],
  readMessage: (path: string) => string,
): 0 | 1 {
  const [, , messagePath] = argv;
  if (typeof messagePath !== "string" || messagePath.length === 0) {
    return 1;
  }
  try {
    const parsed = parseConventionalCommitMessage(
      removeTerminalGitLineFeed(readMessage(messagePath)),
    );
    if (parsed.status === "valid") {
      return 0;
    }
    return 1;
  } catch {
    return 1;
  }
}

function removeTerminalGitLineFeed(message: string): string {
  if (message.endsWith("\n")) {
    return message.slice(0, -1);
  }
  return message;
}

export function temporaryCommitMessageHookPath(
  hooksDirectory: string,
): string | undefined {
  if (!isAbsolute(hooksDirectory)) {
    return;
  }
  return join(hooksDirectory, "commit-msg");
}

export function runCommitMessageHook(): 0 | 1 {
  return commitMessageHookExitCode(process.argv, (path) =>
    readFileSync(path, { encoding: "utf8" }),
  );
}
