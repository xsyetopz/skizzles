import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  authorPromptPatch,
  buildPrompt,
  checkPrompt,
  normalizeDarwinProcessStartOutput,
  PROMPT_LAYER_PACKAGE_FILES,
  PROMPT_POLICY_DESCRIPTOR_PATHS,
  PromptLayerError,
  validatePatch,
} from "../../src/cli.ts";
import {
  canonicalHeader,
  cleanupFixtures,
  currentCommit,
  filesUnder,
  fixture,
  fixtureDirectory,
  gitBlobId,
  type ManifestFixture,
  PATCH_NEW_IDENTITY,
  PROVENANCE_ERROR,
  pathExistsForTest,
  snapshot,
  updateManifestFact,
} from "./fixture.ts";

const UPSTREAM_SHA256 = [
  "ac8ae107",
  "a0d72fe3",
  "476b430a",
  "fb161ea4",
  "e67da2e4",
  "46d778ae",
  "fc448281",
  "60559807",
].join("");
const PATCH_SHA256 = [
  "3ec67df5",
  "ea32791b",
  "217b63ff",
  "4f0731c9",
  "14e21a8a",
  "0d4717b5",
  "6e0a5e0e",
  "b0c4667d",
].join("");
const OUTPUT_SHA256 = [
  "3412f9c3",
  "bf51311e",
  "7ffbf887",
  "4955e1f6",
  "0b823dec",
  "71be2a53",
  "e7acb7cd",
  "7475b1c0",
].join("");
const LICENSE_SHA256 = [
  "d17f227e",
  "4df5da16",
  "00391338",
  "865ce0f3",
  "05521176",
  "0a36688f",
  "816941d5",
  "8232d8dc",
].join("");
const NOTICE_SHA256 = [
  "9d71575e",
  "cfd9a843",
  "fc1677b0",
  "efb08053",
  "c6ba9fd6",
  "86a0de1a",
  "6f5382fd",
  "3c220915",
].join("");

afterEach(cleanupFixtures);

describe("prompt asset and patch contracts", () => {
  it("publishes canonical and packaged descriptor paths without cwd assumptions", () => {
    expect(PROMPT_POLICY_DESCRIPTOR_PATHS).toEqual({
      canonicalWorkspacePath:
        "packages/prompt-policy/assets/integrations/prompt-policy.json",
      packagedPath: "integrations/prompt-policy.json",
    });
    expect(PROMPT_LAYER_PACKAGE_FILES).toContainEqual([
      PROMPT_POLICY_DESCRIPTOR_PATHS.canonicalWorkspacePath,
      PROMPT_POLICY_DESCRIPTOR_PATHS.packagedPath,
    ]);
  });
  it("normalizes Darwin process-start output deterministically", () => {
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

  it("builds the known prompt deterministically and check is non-writing", async () => {
    const root = await fixture();
    expect(await pathExistsForTest(join(root, "instructions"))).toBe(false);
    await buildPrompt(root);
    const firstPrompt = await readFile(
      join(root, "packages/prompt-policy/assets/instructions/skizzles-base.md"),
    );
    const firstReceipt = await readFile(
      join(
        root,
        "packages/prompt-policy/assets/instructions/skizzles-base.provenance.json",
      ),
    );

    await buildPrompt(root);
    await checkPrompt(root);

    expect(
      await readFile(
        join(
          root,
          "packages/prompt-policy/assets/instructions/skizzles-base.md",
        ),
      ),
    ).toEqual(firstPrompt);
    expect(
      await readFile(
        join(
          root,
          "packages/prompt-policy/assets/instructions/skizzles-base.provenance.json",
        ),
      ),
    ).toEqual(firstReceipt);
    expect(firstPrompt.toString()).toStartWith(
      canonicalHeader(currentCommit()),
    );
    expect(firstPrompt.toString()).toContain("# How you work");
  });

  it("uses an injected prompt workspace without creating a separate owner", async () => {
    const root = await fixture();
    const workspaceRoot = await fixtureDirectory("injected-prompt-workspace");
    const controller = new AbortController();
    let sequence = 0;
    const workspace = {
      signal: controller.signal,
      directory: async (purpose: "apply" | "author" | "test") => {
        const path = join(workspaceRoot, `${purpose}-${sequence}`);
        sequence += 1;
        await mkdir(path);
        return path;
      },
      throwIfAborted: () => controller.signal.throwIfAborted(),
    };

    await checkPrompt(root, { workspace });
    expect(sequence).toBeGreaterThan(0);
    await expect(
      checkPrompt(root, {
        workspace,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("must share one owner");
  });

  it("rejects tampered checksum-locked inputs", async () => {
    for (const path of [
      "packages/prompt-policy/assets/upstream/default.md",
      "packages/prompt-policy/assets/skizzles-base.patch",
      "packages/prompt-policy/assets/upstream/LICENSE",
      "packages/prompt-policy/assets/upstream/NOTICE",
    ]) {
      const root = await fixture();
      await writeFile(join(root, path), "tampered\n");
      await expect(buildPrompt(root)).rejects.toBeInstanceOf(PromptLayerError);
    }
  });

  it("check rejects tampered output and provenance without writing", async () => {
    for (const path of [
      "packages/prompt-policy/assets/instructions/skizzles-base.md",
      "packages/prompt-policy/assets/instructions/skizzles-base.provenance.json",
    ]) {
      const root = await fixture();
      await writeFile(join(root, path), "tampered\n");
      const before = await snapshot(root);

      await expect(checkPrompt(root)).rejects.toBeInstanceOf(PromptLayerError);

      expect(await snapshot(root)).toEqual(before);
    }
  });

  it("rejects bad manifest refs, paths, digests, counts, and unknown fields", async () => {
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
      const path = join(root, "packages/prompt-policy/assets/manifest.json");
      const manifest = (await Bun.file(path).json()) as ManifestFixture;
      mutate(manifest);
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);

      await expect(buildPrompt(root)).rejects.toBeInstanceOf(PromptLayerError);
    }
  });

  it("rejects unsafe and non-canonical Git patches before git apply", async () => {
    const expected =
      "codex-rs/protocol/src/prompts/base_instructions/default.md";
    const baseline = await readFile(
      resolve(import.meta.dir, "../../assets/upstream/default.md"),
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

  it("rejects a digest-valid patch with whitespace errors through real git apply", async () => {
    const root = await fixture();
    const patchPath = join(
      root,
      "packages/prompt-policy/assets/skizzles-base.patch",
    );
    const changedOutput = Buffer.from(
      (
        await readFile(
          join(
            root,
            "packages/prompt-policy/assets/instructions/skizzles-base.md",
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

  it("rejects shifted real hunks and false Git blob identities before git apply", async () => {
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
        "packages/prompt-policy/assets/skizzles-base.patch",
      );
      const changed = Buffer.from(mutate(await readFile(patchPath, "utf8")));
      await writeFile(patchPath, changed);
      await updateManifestFact(root, "patch", changed);

      await expect(buildPrompt(root)).rejects.toBeInstanceOf(PromptLayerError);
    }
  });

  it("build updates only applied output and exact portable provenance", async () => {
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
        "packages/prompt-policy/assets/instructions/skizzles-base.provenance.json",
      ),
    ).json()) as Record<string, unknown>;
    expect(provenance).toEqual({
      schema: "skizzles.prompt-layer",
      version: 1,
      baselineRole:
        "pinned generic upstream compatibility baseline; not a claim about any selected model's active baseline",
      upstream: {
        repository: "https://github.com/openai/codex",

        commit: currentCommit(),
        path: "codex-rs/protocol/src/prompts/base_instructions/default.md",
        sha256: UPSTREAM_SHA256,
        bytes: 20_903,
      },
      patch: {
        sha256: PATCH_SHA256,
        bytes: 9306,
      },
      output: {
        sha256: OUTPUT_SHA256,
        bytes: 21_888,
      },
      legal: {
        license: {
          sha256: LICENSE_SHA256,
          bytes: 10_926,
        },
        notice: {
          sha256: NOTICE_SHA256,
          bytes: 242,
        },
      },
    });
  });

  it("authors a new exact-path patch and proves replay equivalence", async () => {
    const root = await fixture();
    const candidatePath = join(root, "reviewed-candidate.md");
    const current = await readFile(
      join(root, "packages/prompt-policy/assets/instructions/skizzles-base.md"),
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
          "packages/prompt-policy/assets/instructions/skizzles-base.md",
        ),
      ),
    ).toEqual(candidate);
    expect(
      await readFile(
        join(root, "packages/prompt-policy/assets/skizzles-base.patch"),
        "utf8",
      ),
    ).toStartWith(
      "diff --git a/codex-rs/protocol/src/prompts/base_instructions/default.md b/codex-rs/protocol/src/prompts/base_instructions/default.md\n",
    );
  });

  it("rejects contradictory, duplicate, and later hidden prompt provenance", async () => {
    const mutations = [
      (current: string) =>
        current.replace(
          `Commit: ${currentCommit()}`,
          `Commit: ${"0".repeat(40)}`,
        ) + canonicalHeader(currentCommit()),
      (current: string) => `${current}\n${canonicalHeader(currentCommit())}`,
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
          "packages/prompt-policy/assets/instructions/skizzles-base.md",
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
