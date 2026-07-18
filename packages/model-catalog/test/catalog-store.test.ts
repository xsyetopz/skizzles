// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun's built-in bun:test module.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  prepareCatalogStorePaths,
  validateCatalogStorePaths,
  writePrivateAtomic,
} from "../src/catalog-store.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = join(
    realpathSync(process.env["TMPDIR"] ?? "/tmp"),
    `skizzles-catalog-store-${crypto.randomUUID()}`,
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

describe("model catalog private atomic store", () => {
  test("writes owner-only files and repairs unchanged file permissions", async () => {
    const root = temporaryRoot();
    const target = join(root, "nested", "catalog.json");
    expect(await writePrivateAtomic(target, "catalog\n")).toBe(true);
    chmodSync(target, 0o644);
    expect(await writePrivateAtomic(target, "catalog\n")).toBe(false);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf8")).toBe("catalog\n");
  });

  test("refuses symlink and non-file targets without leaving temporary files", async () => {
    const root = temporaryRoot();
    const victim = join(root, "victim");
    const symlink = join(root, "symlink");
    writeFileSync(victim, "unchanged");
    symlinkSync(victim, symlink);
    await expect(writePrivateAtomic(symlink, "changed")).rejects.toThrow(
      "symlink",
    );
    expect(readFileSync(victim, "utf8")).toBe("unchanged");

    const directory = join(root, "directory");
    mkdirSync(directory);
    await expect(writePrivateAtomic(directory, "changed")).rejects.toThrow(
      "must be a regular file",
    );
    expect(readdirSync(root).some((entry) => entry.endsWith(".tmp"))).toBe(
      false,
    );
  });

  test("rejects non-private storage chains and physical hard-link aliases", async () => {
    const root = temporaryRoot();
    const storage = join(root, "storage");
    const nested = join(storage, "nested");
    mkdirSync(nested, { recursive: true, mode: 0o700 });
    chmodSync(storage, 0o755);
    const paths = {
      codexHome: root,
      output: join(nested, "catalog.json"),
      status: join(nested, "status.json"),
      cache: join(root, "cache.json"),
    };
    await expect(prepareCatalogStorePaths(paths)).rejects.toThrow("mode 0700");

    chmodSync(storage, 0o700);
    chmodSync(nested, 0o700);
    writeFileSync(paths.output, "catalog", { mode: 0o600 });
    linkSync(paths.output, paths.status);
    await expect(validateCatalogStorePaths(paths)).rejects.toThrow(
      "exactly one hard link",
    );
  });

  test("rejects an external target hard link before chmod, read, or no-op", async () => {
    const root = temporaryRoot();
    const victim = join(root, "victim.json");
    const target = join(root, "catalog.json");
    writeFileSync(victim, "same-content", { mode: 0o640 });
    linkSync(victim, target);
    for (const contents of ["same-content", "different-content"]) {
      await expect(writePrivateAtomic(target, contents)).rejects.toThrow(
        "exactly one hard link",
      );
      expect(readFileSync(victim, "utf8")).toBe("same-content");
      expect(statSync(victim).mode & 0o777).toBe(0o640);
      expect(statSync(victim).nlink).toBe(2);
    }
  });

  test("detects target replacement before promotion and removes its temporary file", async () => {
    const root = temporaryRoot();
    const target = join(root, "catalog.json");
    const displaced = join(root, "displaced.json");
    writeFileSync(target, "old", { mode: 0o600 });
    await expect(
      writePrivateAtomic(target, "new", {
        beforePromote: async () => {
          renameSync(target, displaced);
          await Bun.write(target, "replacement", { mode: 0o600 });
        },
      }),
    ).rejects.toThrow("changed during atomic replacement");
    expect(readFileSync(target, "utf8")).toBe("replacement");
    expect(readFileSync(displaced, "utf8")).toBe("old");
    expect(readdirSync(root).some((entry) => entry.endsWith(".tmp"))).toBe(
      false,
    );
  });

  test("rejects a hard-linked staged temporary before promotion", async () => {
    const root = temporaryRoot();
    const target = join(root, "catalog.json");
    const external = join(root, "external-temp-link");
    writeFileSync(target, "old", { mode: 0o600 });
    await expect(
      writePrivateAtomic(target, "new", {
        beforePromote: async () => {
          const temporary = readdirSync(root).find((entry) =>
            entry.endsWith(".tmp"),
          );
          if (temporary === undefined) {
            throw new Error("missing staged file");
          }
          linkSync(join(root, temporary), external);
          await Promise.resolve();
        },
      }),
    ).rejects.toThrow("exactly one hard link");
    expect(readFileSync(target, "utf8")).toBe("old");
    expect(readFileSync(external, "utf8")).toBe("new");
    expect(readdirSync(root).some((entry) => entry.endsWith(".tmp"))).toBe(
      false,
    );
  });
});
