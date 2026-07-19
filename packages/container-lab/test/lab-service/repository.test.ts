// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { afterEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  ContainerLabService,
  crashServiceApply,
  createLabServiceFixtureScope,
  join,
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
