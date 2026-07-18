// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import process from "node:process";

const packageRoot = resolve(import.meta.dir, "..");
const hook = join(packageRoot, "src/manage-command-output.ts");
const hookAsset = join(packageRoot, "assets/hooks.json");
const pluginRootPlaceholder = ["$", "{PLUGIN_ROOT}"].join("");
const runnerCommand = `bun "${pluginRootPlaceholder}/runtime/codex-command.ts"`;

function invoke(command: string) {
  return Bun.spawnSync(["bun", hook], {
    stdin: new TextEncoder().encode(command),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
}

function text(output: Uint8Array | undefined): string {
  return new TextDecoder().decode(output);
}

function encodedCommand(rewritten: string): string {
  const encoded = rewritten.split(" ").at(-1);
  if (!encoded) {
    throw new Error(`encoded command missing from output: ${rewritten}`);
  }
  return encoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value;
}

function rewriteContract(payload: unknown) {
  const record = requiredRecord(payload, "hook output");
  const output = requiredRecord(
    record["hookSpecificOutput"],
    "hook-specific output",
  );
  return {
    keys: Object.keys(output).sort(),
    hasPermissionDecision: Object.hasOwn(output, "permissionDecision"),
    hasPermissionDecisionReason: Object.hasOwn(
      output,
      "permissionDecisionReason",
    ),
  };
}

function hookUpdatedInput(payload: unknown): Record<string, unknown> {
  const record = requiredRecord(payload, "hook output");
  const output = requiredRecord(
    record["hookSpecificOutput"],
    "hook-specific output",
  );
  return requiredRecord(output["updatedInput"], "hook updated input");
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${key} is not a string`);
  }
  return value;
}

const neutralRewriteContract = {
  keys: ["hookEventName", "updatedInput"],
  hasPermissionDecision: false,
  hasPermissionDecisionReason: false,
};

describe("managed command output hook", () => {
  test("ships the stable generated hook asset", async () => {
    const asset: unknown = await Bun.file(hookAsset).json();
    expect(asset).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: `bun "${pluginRootPlaceholder}/hooks/manage-command-output.ts"`,
                timeout: 3,
                statusMessage: "checking command output management",
              },
            ],
          },
        ],
      },
    });
  });

  test("passes through unknown commands and comments or quoted lookalikes", () => {
    for (const cmd of [
      "echo flutter test",
      "# bun test\necho okay",
      "printf 'dart test'",
    ]) {
      const result = invoke(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_input: { cmd },
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(text(result.stdout)).toBe("");
    }
  });

  test("rewrites through a portable PLUGIN_ROOT runner with a round-trippable encoding", () => {
    const cmd = "flutter test --reporter expanded && cargo check --workspace";
    const result = invoke(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_input: { cmd, workdir: "/tmp" },
      }),
    );
    const payload = JSON.parse(text(result.stdout));
    expect(rewriteContract(payload)).toEqual(neutralRewriteContract);
    const rewritten = requiredString(hookUpdatedInput(payload), "cmd");
    expect(rewritten).toStartWith(`${runnerCommand} run --base64url `);
    expect(Buffer.from(encodedCommand(rewritten), "base64url").toString()).toBe(
      cmd,
    );
    expect(hookUpdatedInput(payload)["workdir"]).toBe("/tmp");
    expect(rewritten).not.toContain("/Users/");
  });

  test("preserves an entire script when every simple command is recognized", () => {
    const command = "flutter test; cargo check; bun test";
    const result = invoke(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command, timeout: 120_000 },
      }),
    );
    const payload = JSON.parse(text(result.stdout));
    expect(rewriteContract(payload)).toEqual(neutralRewriteContract);
    const rewritten = requiredString(hookUpdatedInput(payload), "command");
    expect(Buffer.from(encodedCommand(rewritten), "base64url").toString()).toBe(
      command,
    );
    expect(hookUpdatedInput(payload)["timeout"]).toBe(120_000);
  });

  test("does not classify quoted, commented, substitution, or heredoc-like lookalikes", () => {
    for (const command of [
      "echo 'header; flutter test'",
      "echo header; # flutter test\necho footer",
      "echo $(flutter test)",
      "cat <<EOF\nflutter test\nEOF",
    ]) {
      const result = invoke(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_input: { command },
        }),
      );
      expect(text(result.stdout)).toBe("");
    }
  });

  test("recognizes high-value build and test commands through common launchers", () => {
    for (const command of [
      "cargo build --workspace",
      "cargo +nightly test --workspace",
      "cargo nextest run",
      "cargo llvm-cov --workspace",
      "cargo install cargo-insta",
      "rustup run nightly cargo test",
      "xcodebuild -workspace App.xcworkspace -scheme App test",
      "xcrun --sdk iphonesimulator xcodebuild -scheme App build",
      "swift build",
      "xcrun swift test",
      "gradle build",
      "gradlew :app:testDebugUnitTest --no-daemon",
      "gradlew connectedDebugAndroidTest",
      "fvm flutter test",
    ]) {
      const result = invoke(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_input: { command },
        }),
      );
      expect(text(result.stdout), command).not.toBe("");
      expect(rewriteContract(JSON.parse(text(result.stdout)))).toEqual(
        neutralRewriteContract,
      );
    }
  });

  test("recognizes canonical literal Container Lab launchers before run", () => {
    for (const command of [
      "codex-container-lab --owner thread-1 --state-root /tmp/state --runtime-root /tmp/runtime run --lab experiment -- echo hello",
    ]) {
      const result = invoke(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_input: { command },
        }),
      );
      expect(text(result.stdout), command).not.toBe("");
      expect(rewriteContract(JSON.parse(text(result.stdout)))).toEqual(
        neutralRewriteContract,
      );
    }
  });

  test("rewrites effectful recognized commands without elevating permission", () => {
    for (const command of [
      "cargo install arbitrary-package",
      "xcodebuild -scheme App archive",
      "codex-container-lab run --lab experiment -- rm data",
    ]) {
      const result = invoke(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_input: { command, workdir: "/tmp/project" },
        }),
      );
      const payload = JSON.parse(text(result.stdout));
      expect(rewriteContract(payload)).toEqual(neutralRewriteContract);
      const updated = hookUpdatedInput(payload);
      expect(updated["workdir"]).toBe("/tmp/project");
      expect(
        Buffer.from(
          encodedCommand(requiredString(updated, "command")),
          "base64url",
        ).toString(),
      ).toBe(command);
    }
  });

  test("does not rewrite path, environment, config, or compound-command injection", () => {
    for (const command of [
      "/usr/bin/xcodebuild -scheme App build",
      "./gradlew test",
      "/tmp/cargo test",
      "cargo* test",
      "PATH=/tmp cargo test",
      "RUSTC_WRAPPER=/tmp/wrapper cargo test",
      "BUN_OPTIONS=--preload=/tmp/inject bun test",
      "env PATH=/tmp cargo test",
      "env RUST_BACKTRACE=1 cargo check",
      "rustup run custom cargo test",
      "cargo +custom test",
      "cargo +/tmp/toolchain test",
      "xcrun --sdk /tmp/sdk xcodebuild test",
      "xcrun --sdk custom xcodebuild test",
      "xcrun --toolchain default xcodebuild test",
      "bun codex-container-lab run --lab experiment -- echo hello",
      "echo header; flutter test",
      "flutter test; rm -rf target",
      "{ echo hidden; }; flutter test",
      "if true; then echo hidden; fi; flutter test",
      "while true; do echo hidden; done; flutter test",
      "case x in x) echo hidden;; esac; flutter test",
      "[[ -n value ]] && flutter test",
      "echo hidden | flutter test",
      "echo hidden & flutter test",
      "cargo test &&",
      "cargo test &&\nbun test",
      "cargo test;\nbun test",
      "flutter test > result.txt",
      "flutter test *.dart",
      "cargo\u00a0test",
      // biome-ignore lint/security/noSecrets: This fixed test/schema token is not a credential.
      "cargo\u2003test",
    ]) {
      const result = invoke(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_input: { command },
        }),
      );
      expect(result.exitCode, command).toBe(0);
      expect(text(result.stdout), command).toBe("");
    }
  });

  test("does not mistake Container Lab lookalikes or unsupported global options for attached runs", () => {
    for (const command of [
      "echo /tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab --owner thread run",
      "'/tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab' run --lab experiment -- echo hello",
      "# codex-container-lab --owner thread run --lab experiment -- echo hello\necho okay",
      "codex-container-lab --unknown value run --lab experiment -- echo hello",
      "codex-container-lab --db /tmp/state.sqlite run --lab experiment -- echo hello",
      'codex-container-lab --owner review --state-root /tmp/state --runtime-root /tmp/runtime "health" run --lab experiment -- echo hello',
      'codex-container-lab --owner "review" --state-root /tmp/state --runtime-root /tmp/runtime run --lab experiment -- echo hello',
      'A=1 "codex-container-lab" run --lab experiment -- echo hello',
      'A=1 /tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab --owner review "" run --lab experiment -- echo hello',
      'env A=1 "/tmp/plugin/skills/codex-container-lab/scripts/codex-container-lab" run --lab experiment -- echo hello',
      '"A=1" codex-container-lab run --lab experiment -- echo hello',
      'A="1" codex-container-lab run --lab experiment -- echo hello',
      '"env" A=1 codex-container-lab run --lab experiment -- echo hello',
      'env "A=1" codex-container-lab run --lab experiment -- echo hello',
      'env "-i" A=1 codex-container-lab run --lab experiment -- echo hello',
      'env -u "FOO" A=1 codex-container-lab run --lab experiment -- echo hello',
      'env -C "./tmp" A=1 codex-container-lab run --lab experiment -- echo hello',
      "env --unset= A=1 codex-container-lab run --lab experiment -- echo hello",
      "env --chdir= A=1 codex-container-lab run --lab experiment -- echo hello",
      "codex-container-lab --owner thread health",
    ]) {
      const result = invoke(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_input: { command },
        }),
      );
      expect(text(result.stdout), command).toBe("");
    }
  });

  test("leaves low-value formatter and informational commands alone", () => {
    for (const command of [
      "dart format .",
      "cargo metadata --format-version 1",
      "cargo fmt --check",
      "swift --version",
      "gradle tasks",
      "./gradlew properties",
    ]) {
      const result = invoke(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_input: { command },
        }),
      );
      expect(text(result.stdout), command).toBe("");
    }
  });
});
