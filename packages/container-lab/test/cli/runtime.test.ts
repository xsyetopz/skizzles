// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { afterEach, describe, expect, test } from "bun:test";
import {
  createCliFixtureScope,
  ensureOwner,
  fixtureLab,
  join,
  labManifestPath,
  mkdtemp,
  process,
  readdir,
  rename,
  symlink,
  tmpdir,
  writeLab,
} from "./support.ts";

const fixtures = createCliFixtureScope();
const { oversizedPreviewFixture, trackTemporaryPath } = fixtures;
afterEach(fixtures.cleanup);

describe("CLI state and synchronization runtime", () => {
  test("reads durable lab state from a fresh Bun process and emits one JSON value", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-cli-"));
    trackTemporaryPath(root);
    const stateRoot = join(root, "state");
    const runtimeRoot = join(root, "runtime");
    const owner = "thread-process";
    await ensureOwner(stateRoot, owner);
    await writeLab({ stateRoot, runtimeRoot }, fixtureLab(root, owner));
    const processResult = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../src/cli.ts"),
        "--owner",
        owner,
        "--state-root",
        stateRoot,
        "--runtime-root",
        runtimeRoot,
        "lab",
        "list",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(processResult.stdout).text(),
      new Response(processResult.stderr).text(),
      processResult.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout) as {
      labs: Array<{ labId: string; state: string }>;
    };
    expect(parsed.labs).toHaveLength(1);
    expect(parsed.labs[0]?.labId).toBe("lab-1");
    expect(stdout).not.toContain(owner);
    expect(stdout).not.toContain("ownerKey");
    expect(stdout).not.toContain("runtimeRoot");
  });

  test("health rejects an environment-selected symlinked lab state file", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-cli-trust-"));
    trackTemporaryPath(root);
    const stateRoot = join(root, "state");
    const runtimeRoot = join(root, "runtime");
    const owner = "thread-cli-trust";
    const lab = fixtureLab(root, owner);
    await ensureOwner(stateRoot, owner);
    await writeLab({ stateRoot, runtimeRoot }, lab);
    const manifest = labManifestPath(stateRoot, owner, lab.id);
    const outside = join(root, "outside-lab.json");
    await rename(manifest, outside);
    await symlink(outside, manifest, "file");

    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "../../src/cli.ts"), "health"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env["PATH"] ?? "",
          CODEX_THREAD_ID: owner,
          CODEX_CONTAINER_LAB_STATE_ROOT: stateRoot,
          CODEX_CONTAINER_LAB_RUNTIME_ROOT: runtimeRoot,
        },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr).error.message).toContain(
      "lab state file contains unsafe indirection",
    );
  });

  test("status serializes a compact redacted DTO under the public byte ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "container-lab-status-"));
    trackTemporaryPath(root);
    const owner = "thread-status";
    const stateRoot = join(root, "state");
    const runtimeRoot = join(root, "runtime");
    const lab = fixtureLab(root, owner);
    lab.error = `failure under ${lab.runtimeRoot}/private`;
    lab.findings = Array.from({ length: 64 }, () => ({
      surface: "host-bind",
      detail: "host path redacted",
    }));
    await ensureOwner(stateRoot, owner);
    await writeLab({ stateRoot, runtimeRoot }, lab);
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../src/cli.ts"),
        "--owner",
        owner,
        "--state-root",
        stateRoot,
        "--runtime-root",
        runtimeRoot,
        "lab",
        "status",
        "--lab",
        lab.id,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(16 * 1024);
    const parsed = JSON.parse(stdout);
    expect(Object.keys(parsed).sort()).toEqual([
      "error",
      "findingCount",
      "findings",
      "labId",
      "name",
      "state",
      "updatedAt",
    ]);
    expect(parsed.findings).toHaveLength(12);
    expect(parsed.findingCount).toBe(64);
    for (const forbidden of [
      owner,
      lab.ownerKey,
      lab.runtimeRoot,
      "ownerKey",
      "composeArgs",
      "managedImage",
    ]) {
      expect(stdout).not.toContain(forbidden);
    }
  });

  test("refuses to invent an owner when neither override nor CODEX_THREAD_ID exists", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../src/cli.ts"),
        "lab",
        "list",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env["PATH"] ?? "" },
      },
    );
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).not.toBe(0);
    expect(JSON.parse(stderr).error.message).toContain("owner is required");
  });

  test("sync preview fails closed before persisting a token when 100 visible long paths exceed the public budget", async () => {
    const fixture = await oversizedPreviewFixture();
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../src/cli.ts"),
        "--owner",
        fixture.owner,
        "--state-root",
        fixture.stateRoot,
        "--runtime-root",
        fixture.runtimeRoot,
        "sync",
        "preview",
        "--lab",
        "lab-1",
        "--direction",
        "push",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(16 * 1024);
    const diagnostic = JSON.parse(stderr) as {
      error: { code: string; message: string };
    };
    expect(diagnostic.error).toEqual({
      code: "OPERATION_FAILED",
      message:
        "Synchronization preview cannot be exposed within the 16 KiB public output budget; reduce the change set before applying",
    });
    expect(
      await readdir(join(fixture.lab.runtimeRoot, "sync", "lab-1", "previews")),
    ).toEqual([]);
  });
});
