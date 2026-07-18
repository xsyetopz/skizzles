#!/usr/bin/env bun

/**
 * Routes only confidently-recognized, potentially noisy commands through the
 * command-output supervisor. The classifier is deliberately a conservative
 * shell subset: unsupported syntax is always passed through unchanged. A
 * rewrite never grants permission; Codex's normal approval and sandbox policy
 * still governs the transformed command.
 */
import { isManagedScript } from "./manage-command-output/policy.ts";

type HookEvent = {
  hook_event_name?: unknown;
  tool_input?: Record<string, unknown>;
};

const maximumScriptLength = 64 * 1024;
const pluginRootPlaceholder = ["$", "{PLUGIN_ROOT}"].join("");
const runner = `bun "${pluginRootPlaceholder}/runtime/codex-command.ts"`;

function commandFrom(
  input: Record<string, unknown> | undefined,
): { key: "cmd" | "command"; value: string } | undefined {
  if (!input) return undefined;

  for (const key of ["cmd", "command"] as const) {
    const value = input[key];
    if (typeof value === "string") return { key, value };
  }
  return undefined;
}

function rewrittenCommand(event: HookEvent): string | undefined {
  if (event.hook_event_name !== "PreToolUse") return undefined;

  const command = commandFrom(event.tool_input);
  if (
    !command ||
    command.value.length === 0 ||
    command.value.length > maximumScriptLength ||
    !isManagedScript(command.value)
  ) {
    return undefined;
  }

  const encoded = Buffer.from(command.value, "utf8").toString("base64url");
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
  const output = rewrittenCommand(JSON.parse(raw) as HookEvent);
  if (output) console.log(output);
} catch {
  // Invalid hook input is not actionable by this optional output-management hook.
}
