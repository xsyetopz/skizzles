// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver cannot resolve Bun's built-in module scheme; @types/bun supplies the contract.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { guardedPath, safeRelativePath } from "../src/files.ts";
import { buildGitManifest } from "../src/sync/git-manifest.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "container-lab-manifest-"));
  temporary.push(root);
  execFileSync("git", ["init", "-q", root]);
  return root;
}

describe("Git manifests", () => {
  test("includes tracked and nonignored untracked regular files and symlinks", async () => {
    const root = await repository();
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(root, "tracked.txt"), "tracked\n");
    await writeFile(path.join(root, "untracked.txt"), "untracked\n");
    await writeFile(path.join(root, "ignored.txt"), "ignored\n");
    await symlink("tracked.txt", path.join(root, "link"));
    execFileSync("git", [
      "-C",
      root,
      "add",
      ".gitignore",
      "tracked.txt",
      "link",
    ]);

    const manifest = await buildGitManifest(root);
    expect(Object.keys(manifest.files)).toEqual([
      ".gitignore",
      "link",
      "tracked.txt",
      "untracked.txt",
    ]);
    expect(manifest.files["link"]?.kind).toBe("symlink");
    expect(manifest.files["link"]?.size).toBe(Buffer.byteLength("tracked.txt"));
    expect(manifest.digest).toHaveLength(64);
  });

  test("records mode changes in the digest", async () => {
    const root = await repository();
    const file = path.join(root, "tool.sh");
    await writeFile(file, "#!/bin/sh\n");
    execFileSync("git", ["-C", root, "add", "tool.sh"]);
    const before = await buildGitManifest(root);
    await Bun.write(file, "#!/bin/sh\n");
    await import("node:fs/promises").then(({ chmod }) => chmod(file, 0o755));
    const after = await buildGitManifest(root);
    expect(after.files["tool.sh"]?.mode).toBe(0o755);
    expect(after.digest).not.toBe(before.digest);
  });

  test("preserves tracked prototype-shaped paths as manifest files", async () => {
    const root = await repository();
    for (const name of ["__proto__", "constructor", "prototype"]) {
      await writeFile(path.join(root, name), `${name}\n`);
    }
    execFileSync("git", [
      "-C",
      root,
      "add",
      "--",
      "__proto__",
      "constructor",
      "prototype",
    ]);

    const manifest = await buildGitManifest(root);

    expect(Object.keys(manifest.files)).toEqual([
      "__proto__",
      "constructor",
      "prototype",
    ]);
    for (const name of ["__proto__", "constructor", "prototype"]) {
      expect(Object.hasOwn(manifest.files, name)).toBe(true);
      expect(manifest.files[name]?.kind).toBe("file");
      expect(manifest.files[name]?.size).toBe(Buffer.byteLength(`${name}\n`));
    }
  });
});

describe("path guards", () => {
  test("reject traversal, absolute paths, backslashes, and normalization tricks", () => {
    for (const value of [
      "../escape",
      "/escape",
      "a/../escape",
      "a\\escape",
      "",
      ".",
    ]) {
      expect(() => safeRelativePath(value)).toThrow(
        "Unsafe synchronization path",
      );
    }
  });

  test("rejects an existing symlink parent", async () => {
    const root = await repository();
    const outside = await mkdtemp(
      path.join(os.tmpdir(), "container-lab-outside-"),
    );
    temporary.push(outside);
    await mkdir(path.join(root, "safe"));
    await symlink(outside, path.join(root, "safe", "link"));
    await expect(guardedPath(root, "safe/link/file", true)).rejects.toThrow(
      "Unsafe synchronization parent",
    );
  });
});
