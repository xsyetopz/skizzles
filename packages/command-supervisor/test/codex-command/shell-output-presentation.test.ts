// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  artifactCountPattern,
  artifactPath,
  completionPattern,
  encode,
  invoke,
  runner,
  temporaryDirectory,
  text,
} from "./runner-fixture.ts";

describe("shell selection and operator presentation", () => {
  it("uses the invoking zsh and supports process substitution", () => {
    if (Bun.file("/bin/zsh").size === 0) {
      return;
    }
    const root = temporaryDirectory();
    const result = invoke(
      runner,
      ["run", "--base64url", encode("cat <(printf process-substitution)")],
      { env: { CODEX_COMMAND_OUTPUT_DIR: root, SHELL: "/bin/zsh" } },
    );
    expect(result.exitCode).toBe(0);
    const path = artifactPath(text(result.stdout));
    expect(readFileSync(join(path, "stdout.log"), "utf8")).toBe(
      "process-substitution",
    );
    expect(
      JSON.parse(readFileSync(join(path, "status.json"), "utf8")).shell,
    ).toBe("/bin/zsh");
  });

  it("prints one artifact path, change-only progress, full small output, and compact completion", () => {
    const root = temporaryDirectory();
    const result = invoke(
      runner,
      [
        "run",
        "--base64url",
        encode("sleep 0.08; printf compact; printf warning >&2"),
      ],
      {
        env: {
          CODEX_COMMAND_OUTPUT_DIR: root,
          CODEX_COMMAND_HEARTBEAT_MS: "25",
        },
      },
    );
    const output = text(result.stdout);
    expect(output.match(artifactCountPattern)).toHaveLength(1);
    expect(output).toContain("| seconds | out | err |");
    expect(output).toContain("[codex-command] stdout:\ncompact");
    expect(output).toContain("[codex-command] stderr:\nwarning");
    expect(output).toMatch(completionPattern);
    expect(output).not.toContain("observed");
    expect(output).not.toContain("stored");
  });

  it("prints tails instead of the full transcript above the inline threshold", () => {
    const root = temporaryDirectory();
    const result = invoke(
      runner,
      ["run", "--base64url", encode("printf 1234567890")],
      {
        env: {
          CODEX_COMMAND_OUTPUT_DIR: root,
          CODEX_COMMAND_INLINE_BYTES: "5",
        },
      },
    );
    const output = text(result.stdout);
    expect(output).toContain("[codex-command] stdout tail:\n1234567890");
    expect(output).not.toContain("[codex-command] stdout:\n");
    expect(output.match(artifactCountPattern)).toHaveLength(1);
  });
});
