// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { stagePlugin } from "../src/plugin/api.ts";
import { createTestWorkspace, write } from "./plugin/fixture.ts";

const { cleanup, fixture } = createTestWorkspace();
afterEach(cleanup);

describe("packaged installer runtime", () => {
  it("rejects undeclared internal workspace imports", async () => {
    const root = await fixture();
    await write(
      root,
      "packages/installer/src/cli.ts",
      'import "@skizzles/container-lab/integration-descriptor";\n',
    );

    await expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "Bundled workspace package imports undeclared dependency @skizzles/container-lab.",
    );
  });

  it("rejects missing staged installer runtime imports while excluding test-only imports", async () => {
    const root = await fixture();
    await write(
      root,
      "packages/installer/test/not-packaged.test.ts",
      'import "./test-helper-that-is-not-packaged.ts";\n',
    );
    await stagePlugin(root, join(root, "stage-with-test-only-import"));

    await write(
      root,
      "packages/installer/src/managed-files.ts",
      'import "./runtime-helper-that-is-not-packaged.ts";\n',
    );
    await expect(
      stagePlugin(root, join(root, "stage-with-missing-runtime-import")),
    ).rejects.toThrow(
      "Unable to create the dependency-self-contained installer bundle",
    );
  });

  it("rejects Bun-resolved installer imports outside the staged installer root", async () => {
    const root = await fixture();
    await write(root, "runtime/outside.ts", "export const outside = true;\n");
    await write(
      root,
      "packages/installer/src/managed-files.ts",
      'import "../../../runtime/outside.ts";\n',
    );

    await expect(
      stagePlugin(root, join(root, "stage-with-escaped-installer-import")),
    ).rejects.toThrow("Resolved package import escapes its source root.");
  });

  it("requires public staged installer usage without canonical source paths", async () => {
    const root = await fixture();
    await stagePlugin(root, join(root, "stage-with-loadable-installer-cli"));

    for (const usage of [
      "usage: bun packages/installer/src/cli.ts <command>",
      "usage: skizzles-installer <command> (packages/installer/src/cli.ts)",
    ]) {
      const invalidRoot = await fixture();
      await write(
        invalidRoot,
        "packages/installer/src/cli.ts",
        `if (import.meta.main) {
  console.error(${JSON.stringify(usage)});
  process.exit(2);
}
`,
      );

      await expect(
        stagePlugin(
          invalidRoot,
          join(invalidRoot, "stage-with-internal-installer-usage"),
        ),
      ).rejects.toThrow("Packaged installer runtime validation failed.");
    }
  });

  it("bounds a staged CLI that ignores termination and keeps output pipes open", async () => {
    const root = await fixture();
    await write(
      root,
      "packages/installer/src/cli.ts",
      `if (import.meta.main) {
  process.on("SIGTERM", () => {});
  Bun.spawn([
    process.execPath,
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);",
  ], { stdout: "inherit", stderr: "inherit" });
  setInterval(() => {}, 1_000);
}
`,
    );

    const startedAt = performance.now();
    await expect(
      stagePlugin(root, join(root, "stage-with-hung-installer-cli")),
    ).rejects.toThrow("Packaged installer runtime validation failed.");
    expect(performance.now() - startedAt).toBeLessThan(2000);
  });

  it("does not expose the supervisor IPC channel to the staged CLI", async () => {
    const root = await fixture();
    await write(
      root,
      "packages/installer/src/cli.ts",
      `if (import.meta.main) {
  if (typeof process.send === "function") {
    process.send({ type: "exited", exitCode: 2 });
    process.exit(0);
  }
  console.error("usage: skizzles-installer <command>");
  process.exit(2);
}
`,
    );

    const staged = join(root, "stage-with-ipc-forgery-attempt");
    await stagePlugin(root, staged);
    expect(
      await Bun.file(join(staged, "packages/installer/src/cli.ts")).exists(),
    ).toBe(true);
  });

  it("rejects every staged installer runtime extension outside .ts", async () => {
    for (const extension of ["js", "tsx", "cjs", "json"] as const) {
      const root = await fixture();
      await write(
        root,
        `packages/plugin-builder/template/packages/installer/src/unsupported.${extension}`,
        "export {};\n",
      );
      await expect(
        stagePlugin(root, join(root, `stage-with-unsupported-${extension}`)),
      ).rejects.toThrow(
        "Packaged installer runtime must contain exactly package.json and src/cli.ts.",
      );
    }
  });
});
