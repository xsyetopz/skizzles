import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCanonicalInside,
  assertRealDirectoryInside,
  assertRealFileInside,
  canonicalDirectoryRoot,
  exactDirectoryChain,
  readTrustedUnknownJson,
  realDirectory,
} from "../src/trusted-filesystem.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("trusted filesystem boundary", () => {
  it("canonical root follows only the explicitly configured root link", async () => {
    const root = await temporaryRoot();
    const target = join(root, "target");
    const linked = join(root, "linked");
    await mkdir(target);
    await symlink(target, linked, "dir");
    await writeFile(join(root, "file"), "not a directory");

    expect(await canonicalDirectoryRoot(linked, "Synchronization root")).toBe(
      await realpath(target),
    );
    await expect(
      canonicalDirectoryRoot(join(root, "file"), "Synchronization root"),
    ).rejects.toThrow(
      `Synchronization root is not a directory: ${join(root, "file")}`,
    );
  });

  it("exact directory chains distinguish present, missing, and unsafe paths", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "owner", "lab"), { recursive: true });

    expect(
      await exactDirectoryChain(root, ["owner", "lab"], "lab runtime"),
    ).toBe(true);
    expect(
      await exactDirectoryChain(root, ["owner", "missing"], "lab runtime"),
    ).toBe(false);
    expect(
      await exactDirectoryChain(
        join(root, "missing-root"),
        ["owner"],
        "lab runtime",
      ),
    ).toBe(false);

    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(root, "owner", "linked"), "dir");
    await expect(
      exactDirectoryChain(root, ["owner", "linked"], "lab runtime"),
    ).rejects.toThrow("lab runtime contains unsafe indirection");
    await symlink(root, join(root, "root-link"), "dir");
    await expect(
      exactDirectoryChain(join(root, "root-link"), [], "lab runtime"),
    ).rejects.toThrow("configured lab runtime contains unsafe indirection");
    await expect(
      exactDirectoryChain(root, ["..", "escaped"], "lab runtime"),
    ).rejects.toThrow("lab runtime contains an unsafe path segment");
  });

  it("real files and directories must remain inside their canonical trust root", async () => {
    const root = await temporaryRoot();
    const inside = join(root, "inside");
    const outside = await temporaryRoot();
    await mkdir(inside);
    await writeFile(join(inside, "file"), "inside");
    await writeFile(join(outside, "file"), "outside");

    const canonicalRoot = await realDirectory(root, "root");
    await expect(
      assertRealFileInside(canonicalRoot, join(inside, "file"), "file"),
    ).resolves.toBeUndefined();
    await expect(
      assertRealDirectoryInside(canonicalRoot, inside, "directory"),
    ).resolves.toBeUndefined();
    await expect(
      assertRealDirectoryInside(canonicalRoot, canonicalRoot, "directory"),
    ).resolves.toBeUndefined();
    await expect(
      assertRealFileInside(canonicalRoot, join(outside, "file"), "file"),
    ).rejects.toThrow("file resolves outside its trusted root");
    expect(() =>
      assertCanonicalInside(canonicalRoot, canonicalRoot, "file", false),
    ).toThrow("file resolves outside its trusted root");

    const linked = join(root, "linked");
    await symlink(inside, linked, "dir");
    await expect(realDirectory(linked, "directory")).rejects.toThrow(
      "directory is not a real directory",
    );
    await symlink(join(inside, "file"), join(root, "linked-file"));
    await expect(
      assertRealFileInside(canonicalRoot, join(root, "linked-file"), "file"),
    ).rejects.toThrow("file is not a real file");
  });

  it("trusted JSON reads reject replaced parents and final-file indirection", async () => {
    const root = await temporaryRoot();
    const parent = join(root, "owners", "owner", "labs");
    await mkdir(parent, { recursive: true });
    const file = join(parent, "lab.json");
    await writeFile(file, '{"version":1}\n');

    await expect(
      readTrustedUnknownJson(
        root,
        ["owners", "owner", "labs"],
        "lab.json",
        "lab state file",
      ),
    ).resolves.toEqual({ version: 1 });

    const outsideFile = join(root, "outside.json");
    await rename(file, outsideFile);
    await symlink(outsideFile, file, "file");
    await expect(
      readTrustedUnknownJson(
        root,
        ["owners", "owner", "labs"],
        "lab.json",
        "lab state file",
      ),
    ).rejects.toThrow("lab state file contains unsafe indirection");

    await rm(file);
    const outsideParent = join(root, "outside-labs");
    await rename(parent, outsideParent);
    await symlink(outsideParent, parent, "dir");
    await expect(
      readTrustedUnknownJson(
        root,
        ["owners", "owner", "labs"],
        "lab.json",
        "lab state file",
      ),
    ).rejects.toThrow("lab state file parent contains unsafe indirection");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "trusted-filesystem-"));
  temporary.push(root);
  return root;
}
