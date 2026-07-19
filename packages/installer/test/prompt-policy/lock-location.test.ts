// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { defaultLockParent } from "../../src/prompt-policy/lock.ts";

const LOCK_PARENT_NAME = /^skizzles-prompt-policy-locks-[0-9]+$/u;

describe("prompt-policy lock location", () => {
  it("uses the selected platform temporary directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "skizzles-lock-location-"));
    try {
      const parent = defaultLockParent(root);
      expect(parent.startsWith(`${await realpath(root)}/`)).toBe(true);
      expect(basename(parent)).toMatch(LOCK_PARENT_NAME);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
