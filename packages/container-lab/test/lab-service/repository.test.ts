// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { afterEach, describe, expect, it } from "bun:test";
import { chmod, readFile, rm } from "node:fs/promises";
import {
  ContainerLabService,
  crashServiceApply,
  createLabServiceFixtureScope,
  join,
  mkdir,
  mkdtemp,
  process,
  RecordingDocker,
  readdir,
  readLab,
  rename,
  runCommand,
  syncJournals,
  tmpdir,
  writeFile,
  writeLab,
} from "./support.ts";

const fixtures = createLabServiceFixtureScope();
afterEach(fixtures.cleanup);
const SOURCE_REPOSITORY_IDENTITY = /^[a-f0-9]{64}$/u;

describe("source repository isolation", () => {
  it("recovers a retained source journal before destroying a lab whose workspace vanished", async () => {
    const fixture = await fixtures.provisionedSyncFixture(
      "thread-missing-workspace-journal",
    );
    await writeFile(join(fixture.lab.workspace, "tracked.txt"), "changed\n");
    const crashed = await fixture.service.preview(fixture.lab.id, "pull");
    await crashServiceApply(fixture.lab, crashed.token, "pull");
    expect(
      await Bun.file(join(fixture.lab.sourceRoot, "tracked.txt")).text(),
    ).toBe("changed\n");
    expect(await syncJournals(fixture.lab)).toHaveLength(1);

    await rm(fixture.lab.workspace, { recursive: true });

    expect(await fixture.service.destroyLab(fixture.lab.id)).toEqual({
      labId: fixture.lab.id,
      destroyed: true,
    });
    expect(
      await Bun.file(join(fixture.lab.sourceRoot, "tracked.txt")).text(),
    ).toBe("base\n");
    await expect(
      readLab(fixture.roots, fixture.owner, fixture.lab.id),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains state and an unrecoverable workspace journal when the workspace vanished", async () => {
    const fixture = await fixtures.provisionedSyncFixture(
      "thread-missing-journal-target",
    );
    await writeFile(join(fixture.lab.sourceRoot, "tracked.txt"), "changed\n");
    const crashed = await fixture.service.preview(fixture.lab.id, "push");
    await crashServiceApply(fixture.lab, crashed.token);
    expect(await syncJournals(fixture.lab)).toHaveLength(1);
    await rm(fixture.lab.workspace, { recursive: true });

    await expect(
      fixture.service.destroyLab(fixture.lab.id),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await syncJournals(fixture.lab)).toHaveLength(1);
    expect(
      (await readLab(fixture.roots, fixture.owner, fixture.lab.id)).state,
    ).toBe("destroying");
  });

  it("rejects same-path repository replacement before sync recovery and accepts the restored original for cleanup", async () => {
    const fixture = await fixtures.provisionedSyncFixture(
      "thread-source-repository-identity",
    );
    expect(fixture.lab.sourceRepositoryIdentity).toMatch(
      SOURCE_REPOSITORY_IDENTITY,
    );

    await writeFile(join(fixture.lab.sourceRoot, "tracked.txt"), "changed\n");
    const crashed = await fixture.service.preview(fixture.lab.id, "push");
    await crashServiceApply(fixture.lab, crashed.token);
    expect(await syncJournals(fixture.lab)).toHaveLength(1);

    const original = join(fixture.root, "original-source");
    const replacement = join(fixture.root, "replacement-source");
    await rename(fixture.lab.sourceRoot, original);
    await initializeRepository(fixture.lab.sourceRoot, "replacement\n");

    await expect(
      fixture.service.preview(fixture.lab.id, "push"),
    ).rejects.toThrow(
      "lab source repository identity no longer matches durable state",
    );
    expect(await syncJournals(fixture.lab)).toHaveLength(1);
    expect(
      await Bun.file(join(fixture.lab.sourceRoot, "tracked.txt")).text(),
    ).toBe("replacement\n");

    await rename(fixture.lab.sourceRoot, replacement);
    await rename(original, fixture.lab.sourceRoot);
    expect(await fixture.service.destroyLab(fixture.lab.id)).toEqual({
      labId: fixture.lab.id,
      destroyed: true,
    });
  });

  it("dissociates a worktree clone from its shared alternate object store", async () => {
    const { root, external, shared, source } =
      await createSharedWorktreeSource();
    const roots = {
      stateRoot: join(root, "state"),
      runtimeRoot: join(root, "runtime"),
    };
    const owner = "thread-alternate-worktree";
    const service = new ContainerLabService(
      owner,
      roots,
      new RecordingDocker(),
      // biome-ignore lint/complexity/useLiteralKeys lint/style/useNamingConvention: Process environment names are uppercase index keys by contract.
      { PATH: process.env["PATH"], TMPDIR: root },
    );

    const created = await service.createLab("alternate", source);
    expect(created.state).toBe("ready");
    const lab = await readLab(roots, owner, created.labId);
    expect(await Bun.file(join(source, ".git")).text()).toStartWith("gitdir:");
    expect(
      await Bun.file(
        join(shared, ".git", "objects", "info", "alternates"),
      ).exists(),
    ).toBe(true);
    expect(
      await Bun.file(
        join(lab.workspace, ".git", "objects", "info", "alternates"),
      ).exists(),
    ).toBe(false);

    const gitState = await readTree(join(lab.workspace, ".git"));
    expect(gitState.includes(Buffer.from(external))).toBe(false);
    expect(gitState.includes(Buffer.from(shared))).toBe(false);
    expect(gitState.includes(Buffer.from(source))).toBe(false);

    await rename(external, join(root, "external-moved"));
    await rename(shared, join(root, "shared-moved"));
    await runCommand("git", [
      "-C",
      lab.workspace,
      "fsck",
      "--full",
      "--no-dangling",
    ]);
  });

  it("fails provisioning when a clone retains an HTTP alternate object store", async () => {
    const root = fixtures.trackTemporaryPath(
      await mkdtemp(join(tmpdir(), "container-lab-http-alternates-")),
    );
    const source = join(root, "source");
    await initializeRepository(source, "base\n");
    const wrapperDirectory = join(root, "bin");
    await mkdir(wrapperDirectory);
    const git = (
      await runCommand("sh", ["-c", "command -v git"], { timeoutMs: 10_000 })
    ).stdout
      .toString()
      .trim();
    const wrapper = join(wrapperDirectory, "git");
    await writeFile(
      wrapper,
      `#!/bin/sh\nclone=0\ndestination=\nfor argument in "$@"; do\n  if [ "$argument" = clone ]; then clone=1; fi\n  destination=$argument\ndone\n${JSON.stringify(git)} "$@"\nstatus=$?\nif [ "$status" -eq 0 ] && [ "$clone" -eq 1 ]; then\n  mkdir -p "$destination/.git/objects/info"\n  printf '%s\\n' ${JSON.stringify(`file://${root}/host-objects`)} > "$destination/.git/objects/info/http-alternates"\nfi\nexit "$status"\n`,
    );
    await chmod(wrapper, 0o755);
    const roots = {
      stateRoot: join(root, "state"),
      runtimeRoot: join(root, "runtime"),
    };
    const docker = new RecordingDocker();
    const result = await new ContainerLabService(
      "thread-http-alternates",
      roots,
      docker,
      { PATH: wrapperDirectory, TMPDIR: root },
    ).createLab("http-alternates", source);

    expect(result.state).toBe("failed");
    const lab = await readLab(roots, "thread-http-alternates", result.labId);
    expect(lab.error).toContain("objects/info/http-alternates exists");
    expect(docker.calls).toEqual([]);
  });

  it("fails closed for legacy sync state without blocking journal-free destruction", async () => {
    const fixture = await fixtures.provisionedSyncFixture(
      "thread-legacy-source-repository-identity",
    );
    const legacy = await readLab(fixture.roots, fixture.owner, fixture.lab.id);
    Reflect.deleteProperty(legacy, "sourceRepositoryIdentity");
    await writeLab(fixture.roots, legacy);

    await expect(
      fixture.service.preview(fixture.lab.id, "push"),
    ).rejects.toThrow(
      "lab source repository identity is absent; synchronization or journal recovery cannot proceed",
    );
    expect(await fixture.service.destroyLab(fixture.lab.id)).toEqual({
      labId: fixture.lab.id,
      destroyed: true,
    });
  });
});

async function createSharedWorktreeSource(): Promise<{
  root: string;
  external: string;
  shared: string;
  source: string;
}> {
  const root = fixtures.trackTemporaryPath(
    await mkdtemp(join(tmpdir(), "container-lab-alternates-")),
  );
  const external = join(root, "external");
  const shared = join(root, "shared");
  const source = join(root, "source-worktree");
  await initializeRepository(external, "external\n");
  await runCommand("git", ["clone", "--shared", external, shared]);
  await runCommand("git", [
    "-C",
    shared,
    "worktree",
    "add",
    "--detach",
    source,
  ]);
  await writeFile(
    join(source, ".codex-container-lab.yaml"),
    "image: { name: node:24, service: dev }\n",
  );
  return { root, external, shared, source };
}

async function initializeRepository(
  repository: string,
  tracked: string,
): Promise<void> {
  await runCommand("git", ["init", repository]);
  await writeFile(
    join(repository, ".codex-container-lab.yaml"),
    "image: { name: node:24, service: dev }\n",
  );
  await writeFile(join(repository, "tracked.txt"), tracked);
  await runCommand("git", ["-C", repository, "add", "."]);
  await runCommand("git", [
    "-C",
    repository,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
}

async function readTree(root: string): Promise<Buffer> {
  const chunks = await Promise.all(
    (await readdir(root, { withFileTypes: true })).map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        return await readTree(path);
      }
      if (entry.isFile()) {
        return await readFile(path);
      }
      return Buffer.alloc(0);
    }),
  );
  return Buffer.concat(chunks);
}
