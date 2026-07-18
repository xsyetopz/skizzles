// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun's built-in bun:test module.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  assertManagedParentsAreReal,
  copyDirectoryExclusive,
  pathEntryExists,
  rollbackStagedMoves,
  sameTree,
} from "../src/managed-files.ts";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = `${process.env["TMPDIR"] ?? "/tmp"}/skizzles-managed-files-${crypto.randomUUID()}`;
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("managed installer files", () => {
  test("distinguishes a missing entry from an invalid filesystem path", () => {
    const root = temporaryRoot();
    expect(pathEntryExists(join(root, "missing"))).toBe(false);
    expect(() => pathEntryExists(`${root}\0invalid`)).toThrow();
  });

  test("refuses every symlinked managed parent without following it", () => {
    const root = temporaryRoot();
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, ".skizzles"));

    expect(() => assertManagedParentsAreReal(root, [".skizzles"])).toThrow(
      "symlinked parent",
    );
    expect(existsSync(join(outside, "prompt-policy"))).toBe(false);
  });

  test("removes an exclusive-copy target after a partial entry failure", () => {
    const root = temporaryRoot();
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(source);
    writeFileSync(join(source, "one"), "one");

    expect(() =>
      copyDirectoryExclusive(source, target, (_from, to) => {
        writeFileSync(to, "partial");
        throw new Error("copy failed");
      }),
    ).toThrow("copy failed");
    expect(pathEntryExists(target)).toBe(false);
  });

  test("preserves the source root mode for a copied tree", () => {
    const root = temporaryRoot();
    const source = join(root, "source");
    const target = join(root, "target");
    mkdirSync(source);
    chmodSync(source, 0o700);
    writeFileSync(join(source, "file"), "contents");

    copyDirectoryExclusive(source, target);
    expect(sameTree(source, target)).toBe(true);
  });

  test("compares file contents and modes while rejecting symlink trees", () => {
    const root = temporaryRoot();
    const left = join(root, "left");
    const right = join(root, "right");
    mkdirSync(left);
    mkdirSync(right);
    writeFileSync(join(left, "file"), "same");
    writeFileSync(join(right, "file"), "same");
    chmodSync(join(left, "file"), 0o600);
    chmodSync(join(right, "file"), 0o600);
    expect(sameTree(left, right)).toBe(true);

    writeFileSync(join(right, "file"), "different");
    expect(sameTree(left, right)).toBe(false);
    writeFileSync(join(right, "file"), "same");
    chmodSync(join(right, "file"), 0o644);
    expect(sameTree(left, right)).toBe(false);
    chmodSync(join(right, "file"), 0o600);
    rmSync(join(right, "file"));
    symlinkSync(join(left, "file"), join(right, "file"));
    expect(sameTree(left, right)).toBe(false);
  });

  test("rolls staged moves back in reverse order", () => {
    const root = temporaryRoot();
    const first = join(root, "first");
    const second = join(root, "second");
    const quarantine = join(root, "quarantine");
    mkdirSync(quarantine);
    writeFileSync(first, "first");
    writeFileSync(second, "second");
    const moved = [
      { from: first, to: join(quarantine, "first") },
      { from: second, to: join(quarantine, "second") },
    ];
    for (const item of moved) {
      renameSync(item.from, item.to);
    }

    rollbackStagedMoves(moved);
    expect(readFileSync(first, "utf8")).toBe("first");
    expect(readFileSync(second, "utf8")).toBe("second");
    expect(pathEntryExists(join(quarantine, "first"))).toBe(false);
  });

  test("preserves a replacement created after an entry was staged", () => {
    const root = temporaryRoot();
    const source = join(root, "source");
    const staged = join(root, "staged");
    writeFileSync(source, "original");
    renameSync(source, staged);
    writeFileSync(source, "replacement");

    rollbackStagedMoves([{ from: source, to: staged }]);
    expect(readFileSync(source, "utf8")).toBe("replacement");
    expect(readFileSync(staged, "utf8")).toBe("original");
  });
});
