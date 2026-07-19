// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { runRoot } from "../../src/codex-command/settings.ts";

describe("retained command output location", () => {
  it("uses the injected platform temporary directory without a host path literal", () => {
    const temporaryDirectory = resolve("platform-temporary");
    expect(
      runRoot({
        environment: {},
        temporaryDirectory,
        workingDirectory: resolve("working-tree"),
      }),
    ).toBe(join(temporaryDirectory, "codex-command-output"));
  });

  it("preserves an explicit durable output root", () => {
    expect(
      runRoot({
        environment: { CODEX_COMMAND_OUTPUT_DIR: "configured-output" },
        temporaryDirectory: resolve("ignored-temporary"),
        workingDirectory: resolve("working-tree"),
      }),
    ).toBe("configured-output");
  });

  it("rejects a platform temporary directory inside the working tree", () => {
    const workingDirectory = resolve("working-tree");
    expect(() =>
      runRoot({
        environment: {},
        temporaryDirectory: join(workingDirectory, "tmp"),
        workingDirectory,
      }),
    ).toThrow("platform temporary directory is inside the working tree");
  });
});
