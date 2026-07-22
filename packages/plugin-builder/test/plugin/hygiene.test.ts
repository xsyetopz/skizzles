// biome-ignore-all lint/security/noSecrets: High-entropy strings are synthetic hygiene-test payloads used to prove rejection behavior.
import { afterEach, describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildPlugin,
  checkPlugin,
  PackagingError,
  stagePlugin,
} from "../../src/plugin/api.ts";
import { createTestWorkspace, PLUGIN_ROOT_TOKEN, write } from "./fixture.ts";

const { cleanup, fixture } = createTestWorkspace();
afterEach(cleanup);

describe("plugin distribution hygiene", () => {
  it("rejects Finder metadata in canonical package inputs", async () => {
    const root = await fixture();
    await write(root, "skills/.DS_Store", "local metadata");

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "skills/.DS_Store looks like local or live state",
    );
  });

  it("rejects Finder metadata in generated output", async () => {
    const root = await fixture();
    await buildPlugin(root);
    await write(root, "plugins/skizzles/.DS_Store", "local metadata");

    expect(checkPlugin(root)).rejects.toThrow(
      "generated plugin contains forbidden Finder metadata at .DS_Store",
    );
  });

  it("rejects machine-specific paths in distributable output", async () => {
    const root = await fixture();
    await write(
      root,
      "skills/example/machine-path.md",
      "export const path = '/Users/alice/.codex';\n",
    );

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "contains machine-specific path /Users/alice/",
    );
  });

  it("rejects environment and credential artifacts", async () => {
    const root = await fixture();

    await write(root, "skills/example/.env.production", "TOKEN=secret\n");
    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "looks like local or live state",
    );
  });

  it("validates creator-required manifest metadata", async () => {
    const root = await fixture();
    const manifestPath = join(
      root,
      "packages/plugin-builder/template/.codex-plugin/plugin.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "not-semver";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "skizzles", version: "not-semver" }),
    );
    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      "strict semver",
    );
  });

  it("rejects hooks that bypass PLUGIN_ROOT", async () => {
    const root = await fixture();
    await write(
      root,
      "packages/command-hook/assets/hooks.json",
      JSON.stringify({ hooks: [{ command: "bun runtime/hook.ts" }] }),
    );

    expect(stagePlugin(root, join(root, "stage"))).rejects.toThrow(
      `must resolve bundled commands through ${PLUGIN_ROOT_TOKEN}`,
    );
  });

  it("rejects live-state artifacts", async () => {
    const root = await fixture();
    await write(root, "skills/example/session.sqlite", "state");

    expect(stagePlugin(root, join(root, "stage"))).rejects.toBeInstanceOf(
      PackagingError,
    );
  });
});
