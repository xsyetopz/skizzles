// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { replaceDirectoryTransaction } from "../src/plugin/destination-transaction.ts";
import {
  buildPlugin,
  PackagingError,
  stagePlugin,
} from "../src/plugin-package.ts";
import {
  createTestWorkspace,
  filesUnder,
  write,
} from "./plugin-package-fixture.ts";

const PRIVATE_MODE = 0o700;
const PRESERVED_MODE = 0o751;
const PERMISSION_BITS = 0o777;
const ARTIFACT_PREFIX = ".skizzles-package-";
const PRESERVED_BYTES = Buffer.from(
  "\u0000\u0001\u0002\u007f\u0080\u00ff",
  "latin1",
);
const { cleanup, fixture, temporaryRoots } = createTestWorkspace();
afterEach(cleanup);

describe("plugin destination transactions", () => {
  it("preserves every existing byte when the final staged validator rejects", async () => {
    const root = await fixture();
    const destination = join(root, "existing-plugin");
    await mkdir(destination);
    await chmod(destination, PRESERVED_MODE);
    await writeFile(join(destination, "preserved.bin"), PRESERVED_BYTES);
    await write(root, "skills/example/late-stage.unknown", "neutral\n");
    const originalMode = (await stat(destination)).mode & PERMISSION_BITS;

    await expect(stagePlugin(root, destination)).rejects.toThrow(
      "has no explicit language-policy surface classification",
    );

    expect(await readFile(join(destination, "preserved.bin"))).toEqual(
      PRESERVED_BYTES,
    );
    expect((await stat(destination)).mode & PERMISSION_BITS).toBe(originalMode);
    expect(
      await Bun.file(join(destination, ".codex-plugin/plugin.json")).exists(),
    ).toBe(false);
    expect(await transactionArtifacts(root)).toEqual([]);
  });

  it("replaces a valid destination only after complete staging", async () => {
    const root = await fixture();
    const destination = join(root, "replace-plugin");
    await write(root, "replace-plugin/old-only.txt", "old\n");

    await stagePlugin(root, destination);

    expect(await Bun.file(join(destination, "old-only.txt")).exists()).toBe(
      false,
    );
    expect(
      await Bun.file(join(destination, ".codex-plugin/plugin.json")).exists(),
    ).toBe(true);
    expect(await transactionArtifacts(root)).toEqual([]);
  });

  it("routes build replacement through the same failure-preserving authority", async () => {
    const root = await fixture();
    const generated = join(root, "plugins/skizzles");
    await write(root, "plugins/skizzles/preserved.txt", "preserved\n");
    await write(root, "skills/example/late-build.unknown", "neutral\n");

    await expect(buildPlugin(root)).rejects.toThrow(
      "has no explicit language-policy surface classification",
    );
    expect(await readFile(join(generated, "preserved.txt"), "utf8")).toBe(
      "preserved\n",
    );
    expect(
      await Bun.file(join(generated, ".codex-plugin/plugin.json")).exists(),
    ).toBe(false);
    expect(await transactionArtifacts(join(root, "plugins"))).toEqual([]);
  });

  it("rejects destination symlinks, files, and symlinked ancestors without path disclosure", async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "skizzles-stage-outside-"));
    temporaryRoots.push(outside);
    await writeFile(join(outside, "preserved.txt"), "outside\n");

    const symlinkDestination = join(root, "symlink-destination");
    await symlink(outside, symlinkDestination);
    expect(await rejectionMessage(stagePlugin(root, symlinkDestination))).toBe(
      "Plugin staging destination must be a real directory or absent.",
    );

    const fileDestination = join(root, "file-destination");
    await writeFile(fileDestination, "file\n");
    expect(await rejectionMessage(stagePlugin(root, fileDestination))).toBe(
      "Plugin staging destination must be a real directory or absent.",
    );

    const ancestor = join(root, "symlinked-parent");
    await symlink(outside, ancestor);
    const ancestorMessage = await rejectionMessage(
      stagePlugin(root, join(ancestor, "plugin")),
    );
    expect(ancestorMessage).toBe(
      "Plugin staging destination ancestors must be existing real directories.",
    );
    expect(ancestorMessage).not.toContain(root);
    expect(await readFile(join(outside, "preserved.txt"), "utf8")).toBe(
      "outside\n",
    );
    expect(await filesUnder(outside)).toEqual(["preserved.txt"]);
    expect(await transactionArtifacts(root)).toEqual([]);
  });

  it("restores the identity-backed backup when promotion is interrupted", async () => {
    const parent = await temporaryRoot("skizzles-stage-rollback-");
    const destination = join(parent, "plugin");
    await write(parent, "plugin/old.txt", "old bytes\n");

    await expect(
      replaceDirectoryTransaction(
        destination,
        async (privateRoot) => {
          await writeFile(join(privateRoot, "new.txt"), "new bytes\n");
        },
        {
          afterBackup: () => {
            throw new Error("injected promotion failure");
          },
        },
      ),
    ).rejects.toEqual(
      new PackagingError(
        "Plugin staging promotion failed; the previous destination was restored.",
      ),
    );
    expect(await readFile(join(destination, "old.txt"), "utf8")).toBe(
      "old bytes\n",
    );
    expect(await Bun.file(join(destination, "new.txt")).exists()).toBe(false);
    expect(await transactionArtifacts(parent)).toEqual([]);
  });

  it("leaves an absent destination absent when construction fails after writes", async () => {
    const parent = await temporaryRoot("skizzles-stage-write-failure-");
    const destination = join(parent, "plugin");

    await expect(
      replaceDirectoryTransaction(destination, async (privateRoot) => {
        await writeFile(join(privateRoot, "partial.txt"), "partial\n");
        throw new PackagingError("injected staged validation failure");
      }),
    ).rejects.toEqual(new PackagingError("injected staged validation failure"));
    expect(await Bun.file(destination).exists()).toBe(false);
    expect(await transactionArtifacts(parent)).toEqual([]);
  });

  it("constructs privately on the destination filesystem and cleans success artifacts", async () => {
    const parent = await temporaryRoot("skizzles-stage-private-");
    const destination = join(parent, "plugin");
    await write(parent, "plugin/old.txt", "old\n");
    const parentDevice = (await stat(parent)).dev;

    await replaceDirectoryTransaction(destination, async (privateRoot) => {
      const metadata = await lstat(privateRoot);
      expect(dirname(privateRoot)).toBe(await realpath(parent));
      expect(metadata.dev).toBe(parentDevice);
      expect(metadata.mode & PERMISSION_BITS).toBe(PRIVATE_MODE);
      expect(await readFile(join(destination, "old.txt"), "utf8")).toBe(
        "old\n",
      );
      await writeFile(join(privateRoot, "new.txt"), "new\n");
    });

    expect(await readFile(join(destination, "new.txt"), "utf8")).toBe("new\n");
    expect(await Bun.file(join(destination, "old.txt")).exists()).toBe(false);
    expect(await transactionArtifacts(parent)).toEqual([]);
  });

  it("fails closed when the same destination is already being constructed", async () => {
    const parent = await temporaryRoot("skizzles-stage-concurrent-");
    const destination = join(parent, "plugin");
    await write(parent, "plugin/old.txt", "old\n");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let competingConstructionRan = false;
    const first = replaceDirectoryTransaction(
      destination,
      async (privateRoot) => {
        await writeFile(join(privateRoot, "winner.txt"), "winner\n");
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;

    await expect(
      replaceDirectoryTransaction(destination, () => {
        competingConstructionRan = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow(
      "Plugin staging destination is locked by another operation.",
    );
    expect(competingConstructionRan).toBe(false);
    expect(await readFile(join(destination, "old.txt"), "utf8")).toBe("old\n");
    expect((await transactionArtifacts(parent)).length).toBe(2);

    release.resolve();
    await first;
    expect(await readFile(join(destination, "winner.txt"), "utf8")).toBe(
      "winner\n",
    );
    expect(await transactionArtifacts(parent)).toEqual([]);
  });

  it("does not overwrite a destination whose identity changes before promotion", async () => {
    const parent = await temporaryRoot("skizzles-stage-identity-");
    const destination = join(parent, "plugin");
    const displaced = join(parent, "displaced-plugin");
    await write(parent, "plugin/original.txt", "original\n");

    await expect(
      replaceDirectoryTransaction(destination, async (privateRoot) => {
        await writeFile(join(privateRoot, "staged.txt"), "staged\n");
        await rename(destination, displaced);
        await write(parent, "plugin/replacement.txt", "replacement\n");
      }),
    ).rejects.toThrow(
      "Plugin staging destination changed during the transaction.",
    );
    expect(await readFile(join(destination, "replacement.txt"), "utf8")).toBe(
      "replacement\n",
    );
    expect(await readFile(join(displaced, "original.txt"), "utf8")).toBe(
      "original\n",
    );
    expect(await transactionArtifacts(parent)).toEqual([]);
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function transactionArtifacts(parent: string): Promise<string[]> {
  return (await readdir(parent))
    .filter((name) => name.startsWith(ARTIFACT_PREFIX))
    .sort();
}

async function rejectionMessage(operation: Promise<void>): Promise<string> {
  let message = "";
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) {
      ({ message } = error);
    } else {
      message = String(error);
    }
  }
  return message;
}
