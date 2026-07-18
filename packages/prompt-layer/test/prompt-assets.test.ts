// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  authorPromptPatch,
  buildPrompt,
  checkPrompt,
  normalizeDarwinProcessStartOutput,
  PROMPT_POLICY_DESCRIPTOR_PATHS,
  PromptLayerError,
  validatePatch,
} from "../src/prompt-layer.ts";
import {
  canonicalHeader,
  cleanupFixtures,
  filesUnder,
  fixture,
  gitBlobId,
  type ManifestFixture,
  PATCH_NEW_IDENTITY,
  PROVENANCE_ERROR,
  pathExistsForTest,
  snapshot,
  updateManifestFact,
} from "./prompt-fixture.ts";

afterEach(cleanupFixtures);

describe("prompt asset and patch contracts", () => {
  test("publishes canonical and packaged descriptor paths without cwd assumptions", () => {
    expect(PROMPT_POLICY_DESCRIPTOR_PATHS).toEqual({
      canonicalWorkspacePath:
        "packages/prompt-layer/assets/integrations/prompt-policy.json",
      packagedPath: "integrations/prompt-policy.json",
    });
  });
  test("normalizes Darwin process-start output deterministically", () => {
    const expected = `darwin:${Date.UTC(2026, 6, 18, 2, 11, 12) / 1000}`;
    expect(
      normalizeDarwinProcessStartOutput("Sat Jul 18 02:11:12 2026\n"),
    ).toBe(expected);
    expect(
      normalizeDarwinProcessStartOutput("\tSat   Jul  18\t02:11:12     2026  "),
    ).toBe(expected);
    expect(
      normalizeDarwinProcessStartOutput("Fri Jul 18 02:11:12 2026"),
    ).toBeUndefined();
    expect(
      normalizeDarwinProcessStartOutput("Sat Jul 32 02:11:12 2026"),
    ).toBeUndefined();
    expect(
      normalizeDarwinProcessStartOutput("Sa 18 Jul 02:11:12 2026"),
    ).toBeUndefined();
  });

  test("builds the known prompt deterministically and check is non-writing", async () => {
    const root = await fixture();
    expect(await pathExistsForTest(join(root, "instructions"))).toBe(false);
    await buildPrompt(root);
    const firstPrompt = await readFile(
      join(root, "packages/prompt-layer/assets/instructions/skizzles-base.md"),
    );
    const firstReceipt = await readFile(
      join(
        root,
        "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
      ),
    );

    await buildPrompt(root);
    await checkPrompt(root);

    expect(
      await readFile(
        join(
          root,
          "packages/prompt-layer/assets/instructions/skizzles-base.md",
        ),
      ),
    ).toEqual(firstPrompt);
    expect(
      await readFile(
        join(
          root,
          "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
        ),
      ),
    ).toEqual(firstReceipt);
    expect(firstPrompt.toString()).toStartWith(
      // biome-ignore lint/security/noSecrets: This is a public upstream commit digest fixture.
      canonicalHeader("bc5c9161b46feddc13282652fd2cfdf1e5bab4a9"),
    );
    expect(firstPrompt.toString()).toContain("# How you work");
  });

  test("rejects tampered checksum-locked inputs", async () => {
    for (const path of [
      "packages/prompt-layer/assets/upstream/default.md",
      "packages/prompt-layer/assets/skizzles-base.patch",
      "packages/prompt-layer/assets/upstream/LICENSE",
      "packages/prompt-layer/assets/upstream/NOTICE",
    ]) {
      const root = await fixture();
      await writeFile(join(root, path), "tampered\n");
      await expect(buildPrompt(root)).rejects.toBeInstanceOf(PromptLayerError);
    }
  });

  test("check rejects tampered output and provenance without writing", async () => {
    for (const path of [
      "packages/prompt-layer/assets/instructions/skizzles-base.md",
      "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
    ]) {
      const root = await fixture();
      await writeFile(join(root, path), "tampered\n");
      const before = await snapshot(root);

      await expect(checkPrompt(root)).rejects.toBeInstanceOf(PromptLayerError);

      expect(await snapshot(root)).toEqual(before);
    }
  });

  test("rejects bad manifest refs, paths, digests, counts, and unknown fields", async () => {
    const mutations: Array<(manifest: ManifestFixture) => void> = [
      (manifest) => {
        manifest.upstream.commit = "main";
      },
      (manifest) => {
        manifest.upstream.path = "../default.md";
      },
      (manifest) => {
        manifest.patch.path = "/tmp/prompt.patch";
      },
      (manifest) => {
        manifest.output.sha256 = "0".repeat(64);
      },
      (manifest) => {
        manifest.upstream.baseline.bytes += 1;
      },
      (manifest) => {
        (manifest as unknown as Record<string, unknown>)["extra"] = true;
      },
    ];
    for (const mutate of mutations) {
      const root = await fixture();
      const path = join(root, "packages/prompt-layer/assets/manifest.json");
      const manifest = (await Bun.file(path).json()) as ManifestFixture;
      mutate(manifest);
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);

      await expect(buildPrompt(root)).rejects.toBeInstanceOf(PromptLayerError);
    }
  });

  test("rejects unsafe and non-canonical Git patches before git apply", async () => {
    const expected =
      "codex-rs/protocol/src/prompts/base_instructions/default.md";
    const baseline = await readFile(
      resolve(import.meta.dir, "../assets/upstream/default.md"),
    );
    const invalid = [
      "diff --git a/../../escape b/../../escape\n--- a/../../escape\n+++ b/../../escape\n@@ -1 +1 @@\n-a\n+b\n",
      "diff --git /absolute /absolute\n--- /absolute\n+++ /absolute\n@@ -1 +1 @@\n-a\n+b\n",
      `diff --git a/${expected} b/${expected}\nrename from ${expected}\nrename to other\n`,
      `diff --git a/${expected} b/${expected}\nGIT binary patch\nliteral 0\nHcmV?d00001\n`,
      `diff --git a/${expected} b/${expected}\nnew file mode 100644\nindex 0000000000000000000000000000000000000000..1111111111111111111111111111111111111111\n--- /dev/null\n+++ b/${expected}\n@@ -0,0 +1 @@\n+new\n`,
      `diff --git a/${expected} b/${expected}\ndeleted file mode 100644\nindex 1111111111111111111111111111111111111111..0000000000000000000000000000000000000000\n--- a/${expected}\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n`,
      `diff --git a/${expected} b/${expected}\nsimilarity index 100%\ncopy from ${expected}\ncopy to other\n`,
      `diff --git a/${expected} b/${expected}\nindex 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100755\n--- a/${expected}\n+++ b/${expected}\n@@ -1 +1 @@\n-a\n+b\n`,
      `diff --git a/${expected} b/${expected}\n--- a/${expected}\n+++ b/${expected}\n@@ -1 +1 @@\n-a\n+b\n\ndiff --git a/other b/other\n--- a/other\n+++ b/other\n@@ -1 +1 @@\n-a\n+b\n`,
      `diff --git a/${expected} b/${expected}\r\n--- a/${expected}\r\n+++ b/${expected}\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n`,
      `diff --git a/${expected} b/${expected}\nindex 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644\n--- a/${expected}\n+++ b/${expected}\n@@ -1 +1 @@\n-a\n+b\n`,
      `diff --git a/${expected} b/${expected}\nindex 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644\n--- a/${expected}\n+++ b/${expected}\n@@ malformed @@\n a\n`,
    ];

    for (const candidate of invalid) {
      expect(() =>
        validatePatch(Buffer.from(candidate), expected, baseline),
      ).toThrow(PromptLayerError);
    }
  });

  test("rejects a digest-valid patch with whitespace errors through real git apply", async () => {
    const root = await fixture();
    const patchPath = join(
      root,
      "packages/prompt-layer/assets/skizzles-base.patch",
    );
    const changedOutput = Buffer.from(
      (
        await readFile(
          join(
            root,
            "packages/prompt-layer/assets/instructions/skizzles-base.md",
          ),
          "utf8",
        )
      ).replace(
        "Skizzles prompt layer provenance\n",
        "Skizzles prompt layer provenance \n",
      ),
    );
    const changed = Buffer.from(
      (await readFile(patchPath, "utf8"))
        .replace(
          "+Skizzles prompt layer provenance\n",
          "+Skizzles prompt layer provenance \n",
        )
        .replace(PATCH_NEW_IDENTITY, `..${gitBlobId(changedOutput)} 100644`),
    );
    await writeFile(patchPath, changed);
    await updateManifestFact(root, "patch", changed);

    await expect(buildPrompt(root)).rejects.toThrow("whitespace");
  });

  test("rejects shifted real hunks and false Git blob identities before git apply", async () => {
    for (const mutate of [
      (patch: string) => patch.replace("@@ -1,3 +1,11 @@", "@@ -2,3 +1,11 @@"),
      (patch: string) =>
        patch.replace(
          "index 907ff8b877026871b088f01f4366cea36e1f02cd..",
          `index ${"0".repeat(40)}..`,
        ),
    ]) {
      const root = await fixture();
      const patchPath = join(
        root,
        "packages/prompt-layer/assets/skizzles-base.patch",
      );
      const changed = Buffer.from(mutate(await readFile(patchPath, "utf8")));
      await writeFile(patchPath, changed);
      await updateManifestFact(root, "patch", changed);

      await expect(buildPrompt(root)).rejects.toBeInstanceOf(PromptLayerError);
    }
  });

  test("build updates only applied output and exact portable provenance", async () => {
    const root = await fixture();
    const markerPath = join(root, "unrelated.txt");
    await writeFile(markerPath, "preserve\n");
    const beforeFiles = await filesUnder(root);
    const markerBefore = await stat(markerPath);
    await buildPrompt(root);

    expect(await filesUnder(root)).toEqual(beforeFiles);
    expect((await stat(markerPath)).mtimeMs).toBe(markerBefore.mtimeMs);
    expect(await readFile(markerPath, "utf8")).toBe("preserve\n");
    const provenance = (await Bun.file(
      join(
        root,
        "packages/prompt-layer/assets/instructions/skizzles-base.provenance.json",
      ),
    ).json()) as Record<string, unknown>;
    expect(provenance).toEqual({
      schema: "skizzles.prompt-layer",
      version: 1,
      baselineRole:
        "pinned generic upstream compatibility baseline; not a claim about any selected model's active baseline",
      upstream: {
        repository: "https://github.com/openai/codex",
        // biome-ignore lint/security/noSecrets: This is a public upstream commit digest fixture.
        commit: "bc5c9161b46feddc13282652fd2cfdf1e5bab4a9",
        path: "codex-rs/protocol/src/prompts/base_instructions/default.md",
        sha256:
          // biome-ignore lint/security/noSecrets: This is an integrity digest for public prompt content.
          "ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807",
        bytes: 20_903,
      },
      patch: {
        sha256:
          // biome-ignore lint/security/noSecrets: This is an integrity digest for public patch content.
          "3ec67df5ea32791b217b63ff4f0731c914e21a8a0d4717b56e0a5e0eb0c4667d",
        bytes: 9306,
      },
      output: {
        sha256:
          // biome-ignore lint/security/noSecrets: This is an integrity digest for generated prompt content.
          "3412f9c3bf51311e7ffbf8874955e1f60b823dec71be2a53e7acb7cd7475b1c0",
        bytes: 21_888,
      },
      legal: {
        license: {
          sha256:
            // biome-ignore lint/security/noSecrets: This is an integrity digest for public license content.
            "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc",
          bytes: 10_926,
        },
        notice: {
          sha256:
            // biome-ignore lint/security/noSecrets: This is an integrity digest for public notice content.
            "9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915",
          bytes: 242,
        },
      },
    });
  });

  test("authors a new exact-path patch and proves replay equivalence", async () => {
    const root = await fixture();
    const candidatePath = join(root, "reviewed-candidate.md");
    const current = await readFile(
      join(root, "packages/prompt-layer/assets/instructions/skizzles-base.md"),
      "utf8",
    );
    const candidate = Buffer.from(`${current}\n<!-- reviewed test delta -->\n`);
    await writeFile(candidatePath, candidate);

    await authorPromptPatch(root, candidatePath);
    await checkPrompt(root);

    expect(
      await readFile(
        join(
          root,
          "packages/prompt-layer/assets/instructions/skizzles-base.md",
        ),
      ),
    ).toEqual(candidate);
    expect(
      await readFile(
        join(root, "packages/prompt-layer/assets/skizzles-base.patch"),
        "utf8",
      ),
    ).toStartWith(
      "diff --git a/codex-rs/protocol/src/prompts/base_instructions/default.md b/codex-rs/protocol/src/prompts/base_instructions/default.md\n",
    );
  });

  test("rejects contradictory, duplicate, and later hidden prompt provenance", async () => {
    const mutations = [
      (current: string) =>
        current.replace(
          // biome-ignore lint/security/noSecrets: This is a public upstream commit digest fixture.
          "Commit: bc5c9161b46feddc13282652fd2cfdf1e5bab4a9",
          `Commit: ${"0".repeat(40)}`,
        ) +
        // biome-ignore lint/security/noSecrets: This is a public upstream commit digest fixture.
        canonicalHeader("bc5c9161b46feddc13282652fd2cfdf1e5bab4a9"),
      (current: string) =>
        // biome-ignore lint/security/noSecrets: This is a public upstream commit digest fixture.
        `${current}\n${canonicalHeader("bc5c9161b46feddc13282652fd2cfdf1e5bab4a9")}`,
      (current: string) => `${current}\n<!--\nCommit: ${"0".repeat(40)}\n-->\n`,
      (current: string) =>
        `${current}\n<!--\n\t  Commit:\t${"0".repeat(40)}\n-->\n`,
    ];
    for (const mutate of mutations) {
      const root = await fixture();
      const candidatePath = join(root, "invalid-provenance.md");
      const current = await readFile(
        join(
          root,
          "packages/prompt-layer/assets/instructions/skizzles-base.md",
        ),
        "utf8",
      );
      await writeFile(candidatePath, mutate(current));
      const before = await snapshot(root);

      await expect(authorPromptPatch(root, candidatePath)).rejects.toThrow(
        PROVENANCE_ERROR,
      );
      expect(await snapshot(root)).toEqual(before);
    }
  });
});
