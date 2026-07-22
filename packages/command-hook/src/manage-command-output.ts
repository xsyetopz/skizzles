#!/usr/bin/env bun

/**
 * Routes only confidently-recognized, potentially noisy commands through the
 * command-output supervisor. The classifier is deliberately a conservative
 * shell subset: unsupported syntax is always passed through unchanged. A
 * rewrite never grants permission; Codex's normal approval and sandbox policy
 * still governs the transformed command.
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import { isManagedScript } from "./manage-command-output/policy.ts";

type HookEvent = {
  hook_event_name: unknown;
  tool_input?: Record<string, unknown>;
};

const maximumScriptLength = 64 * 1024;

function pluginRootFrom(arguments_: string[]): string | undefined {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--plugin-root" ||
    !arguments_[1] ||
    !isAbsolute(arguments_[1]) ||
    arguments_[1].includes("\0")
  ) {
    return;
  }

  try {
    if (!lstatSync(arguments_[1]).isDirectory()) {
      return;
    }
    const pluginRoot = realpathSync(arguments_[1]);
    const runtimeRoot = join(pluginRoot, "runtime");
    const supervisor = join(pluginRoot, "runtime", "codex-command.ts");
    if (
      !(
        statSync(pluginRoot).isDirectory() &&
        lstatSync(runtimeRoot).isDirectory() &&
        lstatSync(supervisor).isFile()
      )
    ) {
      return;
    }
    return pluginRoot;
  } catch {
    return;
  }
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hookEvent(value: unknown): HookEvent | undefined {
  if (!isRecord(value)) {
    return;
  }
  const toolInput = value["tool_input"];
  if (toolInput !== undefined && !isRecord(toolInput)) {
    return;
  }
  return {
    hook_event_name: value["hook_event_name"],
    ...(toolInput === undefined ? {} : { tool_input: toolInput }),
  };
}

function commandFrom(
  input: Record<string, unknown> | undefined,
): { key: "cmd" | "command"; value: string } | undefined {
  if (!input) {
    return;
  }

  for (const key of ["cmd", "command"] as const) {
    const value = input[key];
    if (typeof value === "string") {
      return { key, value };
    }
  }
  return;
}

function rewrittenCommand(
  event: HookEvent,
  pluginRoot: string,
): string | undefined {
  if (event.hook_event_name !== "PreToolUse") {
    return;
  }

  const command = commandFrom(event.tool_input);
  if (
    !command ||
    command.value.length === 0 ||
    command.value.length > maximumScriptLength ||
    !isManagedScript(command.value)
  ) {
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
        [command.key]: `${runner} run --base64url ${encoded}`,
      },
    },
  });
}

const raw = await Bun.stdin.text();
try {
  const parsed: unknown = JSON.parse(raw);
  const event = hookEvent(parsed);
  const pluginRoot = pluginRootFrom(process.argv.slice(2));
  let output: string | undefined;
  if (event && pluginRoot) {
    output = rewrittenCommand(event, pluginRoot);
  }
  if (output) {
    console.log(output);
  }
} catch {
  // Invalid hook input is not actionable by this optional output-management hook.
}
