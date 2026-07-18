// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MACHINE_PATH } from "./lifecycle/fixture.ts";

describe("prompt CLI and repository hygiene contracts", () => {
  test("CLI rejects malformed authoring and rebase arguments before side effects", () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const source = join(repoRoot, "packages/prompt-layer/src/cli.ts");
    for (const args of [
      ["build", "extra"],
      ["patch", "one", "two"],
      ["rebase", "main"],
      ["rebase", "5".repeat(40), "--candidate"],
    ]) {
      const result = Bun.spawnSync(["bun", source, ...args], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(1);
    }
    const malformedCommit = Bun.spawnSync(["bun", source, "rebase", "main"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(malformedCommit.stderr.toString()).toContain("40-hex commit");
  });

  test("all prompt artifacts and transaction metadata are forced to exact LF", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const paths = [
      "packages/prompt-layer/assets/manifest.json",
      "packages/prompt-layer/assets/upstream/default.md",
      "packages/prompt-layer/assets/upstream/LICENSE",
      "packages/prompt-layer/assets/upstream/NOTICE",
      "packages/prompt-layer/assets/skizzles-base.patch",
      "packages/prompt-layer/assets/.transaction/journal.json",
      "packages/prompt-layer/assets/.mutation-lock/owner.json",
      "packages/prompt-layer/assets/.mutation-lock/reclaim.json",
      "packages/prompt-layer/assets/instructions/skizzles-base.md",
      "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
    ];
    for (const path of paths.filter(
      (path) =>
        !(path.includes("/.transaction") || path.includes("/.mutation-lock")),
    )) {
      const bytes = await readFile(join(repoRoot, path));
      expect(bytes.includes(13)).toBe(false);
      expect(bytes.at(-1)).toBe(10);
    }
    const attributes = Bun.spawnSync(
      ["git", "check-attr", "eol", "--", ...paths],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
    );
    expect(attributes.exitCode).toBe(0);
    const lines = attributes.stdout.toString().trim().split("\n");
    expect(lines).toHaveLength(paths.length);
    for (const line of lines) {
      expect(line).toEndWith("eol: lf");
    }
  });

  test("tracked prompt-layer artifacts contain no machine-specific paths", async () => {
    const root = resolve(import.meta.dir, "../../..");
    for (const path of [
      "packages/prompt-layer/assets/manifest.json",
      "packages/prompt-layer/assets/upstream/default.md",
      "packages/prompt-layer/assets/upstream/LICENSE",
      "packages/prompt-layer/assets/upstream/NOTICE",
      "packages/prompt-layer/assets/skizzles-base.patch",
      "packages/prompt-layer/assets/instructions/skizzles-base.md",
      "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
    ]) {
      const contents = await readFile(join(root, path), "utf8");
      expect(contents).not.toMatch(MACHINE_PATH);
    }
  });
});
