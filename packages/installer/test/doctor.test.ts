// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun's built-in bun:test module.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import containerLabIntegrationDescriptor from "@skizzles/container-lab/integration-descriptor" with {
  type: "json",
};
import { create, type RunWorkspace } from "@skizzles/run-workspace";
import {
  bundledContainerLabPaths,
  doctor,
  doctorBundledContainerLab,
  doctorContainerLab,
} from "../src/doctor.ts";
import { installHarness } from "../src/harness.ts";
import { installSkills } from "../src/skills.ts";

const roots: string[] = [];
const workspaces: RunWorkspace[] = [];
async function workspace(): Promise<RunWorkspace> {
  const value = await create();
  workspaces.push(value);
  return value;
}
function stubs(
  mode: "ready" | "not-ready" | "malformed" | "oversized" | "stderr" | "hang",
): string {
  const root = `${
    process.env["TMPDIR"] ?? "/tmp"
  }/skizzles-doctor-test-${crypto.randomUUID()}`;
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const operational = join(root, "codex-container-lab");
  const reaper = join(root, "codex-container-lab-reaper");
  const response =
    mode === "ready"
      ? '{"ok":true,"dockerAvailable":true,"labs":0}'
      : '{"ok":true,"dockerAvailable":false,"labs":0}';
  const body =
    mode === "malformed"
      ? "console.log('not-json')"
      : mode === "oversized"
        ? // biome-ignore lint/security/noSecrets: The repeated character is a synthetic oversized-output fixture, not credential material.
          "console.log(JSON.stringify({help:'x'.repeat(17000)}))"
        : mode === "stderr"
          ? "console.error('x'.repeat(17000)); console.log(JSON.stringify({help:'codex-container-lab run --lab ID -- COMMAND'}))"
          : mode === "hang"
            ? "setInterval(() => {}, 1000)"
            : `if (process.argv.includes('--help')) console.log(JSON.stringify({help:'codex-container-lab run --lab ID -- COMMAND'})); else console.log('${response}')`;
  writeFileSync(operational, `#!${process.execPath}\n${body}\n`);
  writeFileSync(
    reaper,
    `#!${process.execPath}\nconsole.log(JSON.stringify({help:'codex-container-lab-reaper [--db PATH]'}))\n`,
  );
  chmodSync(operational, 0o755);
  chmodSync(reaper, 0o755);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  await Promise.all(workspaces.splice(0).map((value) => value.close()));
});

describe("Container Lab doctor", () => {
  test("reports missing binaries without exposing paths", () => {
    const report = doctorContainerLab("");
    expect(report).toMatchObject({
      installed: false,
      compatible: false,
      ready: false,
    });
    expect(JSON.stringify(report)).not.toContain(process.cwd());
  });
  test("classifies ready and installed-not-ready", async () => {
    expect(
      doctorContainerLab(stubs("ready"), undefined, 5000, await workspace()),
    ).toMatchObject({
      installed: true,
      compatible: true,
      ready: true,
      version: `configured-${containerLabIntegrationDescriptor.configuredRuntime}-unverified`,
    });
    expect(
      doctorContainerLab(
        stubs("not-ready"),
        undefined,
        5000,
        await workspace(),
      ),
    ).toMatchObject({
      installed: true,
      compatible: true,
      ready: false,
      dockerAvailable: false,
    });
  });
  test("rejects malformed and oversized public output", async () => {
    expect(
      doctorContainerLab(
        stubs("malformed"),
        undefined,
        5000,
        await workspace(),
      ),
    ).toMatchObject({
      compatible: false,
      reason: "Container Lab returned malformed JSON",
    });
    expect(
      doctorContainerLab(
        stubs("oversized"),
        undefined,
        5000,
        await workspace(),
      ),
    ).toMatchObject({
      compatible: false,
      reason: "external command exceeded its public output limit",
    });
  });
  test("uses the descriptor version and output cap", async () => {
    const path = stubs("ready");
    const descriptorPath = join(path, "contract.json");
    const descriptor = structuredClone(containerLabIntegrationDescriptor);
    descriptor.configuredRuntime = "9.8.7";
    descriptor.execution.adminMaxBytes = 8;
    writeFileSync(descriptorPath, JSON.stringify(descriptor));
    expect(
      doctorContainerLab(path, descriptorPath, 5000, await workspace()),
    ).toMatchObject({
      version: "configured-9.8.7-unverified",
      compatible: false,
      reason: "external command exceeded its public output limit",
    });
  });
  test("rejects invalid descriptor overrides before command execution", () => {
    const path = stubs("ready");
    const descriptorPath = join(path, "invalid-contract.json");
    writeFileSync(descriptorPath, "{}\n");
    expect(() => doctorContainerLab(path, descriptorPath)).toThrow(
      "Skizzles Container Lab descriptor is invalid",
    );
  });
  test("bounds hanging commands and stderr", async () => {
    expect(
      doctorContainerLab(stubs("hang"), undefined, 50, await workspace()),
    ).toMatchObject({
      compatible: false,
      ready: false,
    });
    expect(
      doctorContainerLab(stubs("stderr"), undefined, 5000, await workspace()),
    ).toMatchObject({
      compatible: false,
      ready: false,
    });
  });
  test("derives and validates Skizzles bundled ownership paths", async () => {
    const sourceRoot = resolve(import.meta.dir, "../../..");
    const paths = bundledContainerLabPaths(sourceRoot);
    expect(paths).toMatchObject({
      operational: join(sourceRoot, "packages/container-lab/src/cli.ts"),
      reaper: join(sourceRoot, "packages/container-lab/src/reaper-cli.ts"),
      launcher: join(
        sourceRoot,
        "skills/codex-container-lab/scripts/codex-container-lab",
      ),
      launchAgentTemplate: join(
        sourceRoot,
        "packages/container-lab/install/com.openai.codex-container-lab-reaper.plist",
      ),
    });
    expect(
      doctorBundledContainerLab(sourceRoot, undefined, 5000, await workspace()),
    ).toMatchObject({
      installed: true,
      compatible: true,
      version: "configured-0.1.0-unverified",
    });
  });
  test("reports Skizzles install health independently of optional Container Lab", () => {
    const root = `${
      process.env["TMPDIR"] ?? "/tmp"
    }/skizzles-install-doctor-${crypto.randomUUID()}`;
    roots.push(root);
    const sourceRoot = join(root, "source");
    const home = join(root, "home");
    const codexHome = join(root, "codex");
    mkdirSync(join(sourceRoot, "skills/example"), { recursive: true });
    writeFileSync(
      join(sourceRoot, "skills/example/SKILL.md"),
      "---\nname: example\ndescription: fixture\n---\n",
    );
    mkdirSync(join(sourceRoot, "plugins/skizzles/.codex-plugin"), {
      recursive: true,
    });
    writeFileSync(
      join(sourceRoot, "plugins/skizzles/.codex-plugin/plugin.json"),
      '{"name":"skizzles"}\n',
    );
    installSkills({ codexHome, sourceRoot, transfer: "link" });
    installHarness({ home, sourceRoot, transfer: "link" });
    expect(doctor(home, codexHome, "")).toMatchObject({
      ok: true,
      installs: { skills: "healthy", harness: "healthy" },
      containerLab: { installed: false },
    });
    writeFileSync(join(sourceRoot, "skills/example/SKILL.md"), "changed");
    expect(doctor(home, codexHome, "")).toMatchObject({ ok: true });
    rmSync(join(codexHome, "skills/example"));
    expect(doctor(home, codexHome, "")).toMatchObject({
      ok: false,
      installs: { skills: "drifted" },
    });
  });
});
