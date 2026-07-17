import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  authorPromptPatch,
  buildPrompt,
  checkPrompt,
  normalizeDarwinProcessStartOutput,
  type ProcessIdentityProvider,
  PromptLayerError,
  parseImmutableCommit,
  rebasePrompt,
  validatePatch,
} from "../src/prompt-layer.ts";

const roots: string[] = [];
const MACHINE_PATH =
  /\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/i;
const PATCH_NEW_IDENTITY = /\.\.[0-9a-f]{40} 100644/;
const PROVENANCE_ERROR = /provenance/i;
const FAILED_OLD_REPLAY =
  /old patch strict replay failed.*No files were changed/;
const SYMLINK_ERROR = /symlink/i;
const LIVE_PID_ERROR = /live pid/i;
const ACTIVE_MUTATION_ERROR = /mutation is active/i;
const REPLACEMENT_OWNER_ERROR = /replacement prompt mutation owner/i;
const BOUNDED_GRACE_ERROR = /bounded grace period/i;
const QUARANTINE_ERROR = /quarantine/i;
const MALFORMED_ERROR = /malformed/i;
const CURRENT_PROCESS_IDENTITY_ERROR = /current process start identity/i;
const UNVERIFIABLE_PROCESS_IDENTITY_ERROR =
  /cannot verify process-start identity/i;
const LIVE_ORPHAN_ERROR = /has a live owner/i;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("pinned Codex prompt layer", () => {
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
    await buildPrompt(root);
    const firstPrompt = await readFile(
      join(root, "instructions/skizzles-base.md"),
    );
    const firstReceipt = await readFile(
      join(root, "instructions/skizzles-base.provenance.json"),
    );

    await buildPrompt(root);
    await checkPrompt(root);

    expect(await readFile(join(root, "instructions/skizzles-base.md"))).toEqual(
      firstPrompt,
    );
    expect(
      await readFile(join(root, "instructions/skizzles-base.provenance.json")),
    ).toEqual(firstReceipt);
    expect(firstPrompt.toString()).toStartWith(
      canonicalHeader("bc5c9161b46feddc13282652fd2cfdf1e5bab4a9"),
    );
    expect(firstPrompt.toString()).toContain("# How you work");
  });

  test("rejects tampered checksum-locked inputs", async () => {
    for (const path of [
      "packages/core/prompt-layer/upstream/default.md",
      "packages/core/prompt-layer/skizzles-base.patch",
      "packages/core/prompt-layer/upstream/LICENSE",
      "packages/core/prompt-layer/upstream/NOTICE",
    ]) {
      const root = await fixture();
      await writeFile(join(root, path), "tampered\n");
      await expect(buildPrompt(root)).rejects.toBeInstanceOf(PromptLayerError);
    }
  });

  test("check rejects tampered output and provenance without writing", async () => {
    for (const path of [
      "instructions/skizzles-base.md",
      "instructions/skizzles-base.provenance.json",
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
      const path = join(root, "packages/core/prompt-layer/manifest.json");
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
      resolve(import.meta.dir, "../prompt-layer/upstream/default.md"),
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
      "packages/core/prompt-layer/skizzles-base.patch",
    );
    const changedOutput = Buffer.from(
      (
        await readFile(join(root, "instructions/skizzles-base.md"), "utf8")
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
        "packages/core/prompt-layer/skizzles-base.patch",
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
      join(root, "instructions/skizzles-base.provenance.json"),
    ).json()) as Record<string, unknown>;
    expect(provenance).toEqual({
      schema: "skizzles.prompt-layer",
      version: 1,
      baselineRole:
        "pinned generic upstream compatibility baseline; not a claim about any selected model's active baseline",
      upstream: {
        repository: "https://github.com/openai/codex",
        commit: "bc5c9161b46feddc13282652fd2cfdf1e5bab4a9",
        path: "codex-rs/protocol/src/prompts/base_instructions/default.md",
        sha256:
          "ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807",
        bytes: 20903,
      },
      patch: {
        sha256:
          "3ec67df5ea32791b217b63ff4f0731c914e21a8a0d4717b56e0a5e0eb0c4667d",
        bytes: 9306,
      },
      output: {
        sha256:
          "3412f9c3bf51311e7ffbf8874955e1f60b823dec71be2a53e7acb7cd7475b1c0",
        bytes: 21888,
      },
      legal: {
        license: {
          sha256:
            "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc",
          bytes: 10926,
        },
        notice: {
          sha256:
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
      join(root, "instructions/skizzles-base.md"),
      "utf8",
    );
    const candidate = Buffer.from(`${current}\n<!-- reviewed test delta -->\n`);
    await writeFile(candidatePath, candidate);

    await authorPromptPatch(root, candidatePath);
    await checkPrompt(root);

    expect(await readFile(join(root, "instructions/skizzles-base.md"))).toEqual(
      candidate,
    );
    expect(
      await readFile(
        join(root, "packages/core/prompt-layer/skizzles-base.patch"),
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
          "Commit: bc5c9161b46feddc13282652fd2cfdf1e5bab4a9",
          `Commit: ${"0".repeat(40)}`,
        ) + canonicalHeader("bc5c9161b46feddc13282652fd2cfdf1e5bab4a9"),
      (current: string) =>
        `${current}\n${canonicalHeader("bc5c9161b46feddc13282652fd2cfdf1e5bab4a9")}`,
      (current: string) => `${current}\n<!--\nCommit: ${"0".repeat(40)}\n-->\n`,
      (current: string) =>
        `${current}\n<!--\n\t  Commit:\t${"0".repeat(40)}\n-->\n`,
    ];
    for (const mutate of mutations) {
      const root = await fixture();
      const candidatePath = join(root, "invalid-provenance.md");
      const current = await readFile(
        join(root, "instructions/skizzles-base.md"),
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

  test("rolls back authoring failures at every promotion and recovers a simulated crash", async () => {
    for (let promotionIndex = 0; promotionIndex < 4; promotionIndex += 1) {
      const root = await fixture();
      const candidatePath = await changedCandidate(root, "transaction delta");
      const before = await snapshot(root);

      await expect(
        authorPromptPatch(root, candidatePath, {
          transactionFault: { promotionIndex },
        }),
      ).rejects.toThrow("Injected transaction promotion failure");

      expect(await snapshot(root)).toEqual(before);
      expect(
        await Bun.file(
          join(root, "packages/core/prompt-layer/.transaction"),
        ).exists(),
      ).toBe(false);
    }

    const root = await fixture();
    const candidatePath = await changedCandidate(root, "crash delta");
    const before = await snapshot(root);
    await expect(
      authorPromptPatch(root, candidatePath, {
        transactionFault: { promotionIndex: 3, simulateCrash: true },
      }),
    ).rejects.toThrow("Simulated transaction crash");
    const crashed = await snapshot(root);
    await expect(checkPrompt(root)).rejects.toThrow("transaction is pending");
    expect(await snapshot(root)).toEqual(crashed);
    const journal = await readFile(
      join(root, "packages/core/prompt-layer/.transaction/journal.json"),
      "utf8",
    );
    expect(journal).not.toMatch(MACHINE_PATH);
    expect(journal).toContain('"state": "prepared"');

    await buildPrompt(root);
    expect(await snapshot(root)).toEqual(before);
  });

  test("refuses reordered, subset, operation-mismatched, and digest-swapped journals without canonical writes", async () => {
    const mutations: Array<(journal: TransactionJournalFixture) => void> = [
      (journal) => {
        journal.entries = [
          journal.entries[1] as TransactionEntryFixture,
          journal.entries[0] as TransactionEntryFixture,
          ...journal.entries.slice(2),
        ];
      },
      (journal) => {
        journal.entries = journal.entries.slice(0, -1);
      },
      (journal) => {
        journal.operation = "build";
      },
      (journal) => {
        const first = journal.entries[0] as TransactionEntryFixture;
        const second = journal.entries[1] as TransactionEntryFixture;
        [first.oldSha256, second.oldSha256] = [
          second.oldSha256,
          first.oldSha256,
        ];
        [first.oldBytes, second.oldBytes] = [second.oldBytes, first.oldBytes];
      },
      (journal) => {
        const first = journal.entries[0] as TransactionEntryFixture;
        const second = journal.entries[1] as TransactionEntryFixture;
        [first.newSha256, second.newSha256] = [
          second.newSha256,
          first.newSha256,
        ];
        [first.newBytes, second.newBytes] = [second.newBytes, first.newBytes];
      },
    ];
    for (const mutate of mutations) {
      const root = await fixture();
      await leaveCrashedAuthorTransaction(root);
      const journalPath = join(
        root,
        "packages/core/prompt-layer/.transaction/journal.json",
      );
      const journal = (await Bun.file(
        journalPath,
      ).json()) as TransactionJournalFixture;
      mutate(journal);
      await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      const before = await snapshot(root);

      await expect(buildPrompt(root)).rejects.toBeInstanceOf(PromptLayerError);

      expect(await snapshot(root)).toEqual(before);
    }
  });

  test("refuses post-crash external edits and missing targets before any recovery write", async () => {
    const mutations: Array<(root: string) => Promise<void>> = [
      async (root) => {
        await writeFile(
          join(root, "instructions/skizzles-base.md"),
          "external post-crash edit\n",
        );
      },
      async (root) => {
        await rm(join(root, "instructions/skizzles-base.md"));
      },
    ];
    for (const mutate of mutations) {
      const root = await fixture();
      await leaveCrashedAuthorTransaction(root);
      await mutate(root);
      const before = await snapshot(root);

      await expect(buildPrompt(root)).rejects.toBeInstanceOf(PromptLayerError);

      expect(await snapshot(root)).toEqual(before);
      expect(
        await Bun.file(
          join(root, "packages/core/prompt-layer/.transaction/journal.json"),
        ).exists(),
      ).toBe(true);
    }
  });

  test("rejects symlinked instructions and prompt-layer ancestors without outside writes", async () => {
    for (const target of ["instructions", "packages/core/prompt-layer"]) {
      const root = await fixture();
      const external = await mkdtemp(join(tmpdir(), "skizzles-prompt-escape-"));
      roots.push(external);
      const externalTarget = join(external, "target");
      if (target === "packages/core/prompt-layer") {
        await cp(join(root, target), externalTarget, { recursive: true });
      } else {
        await mkdir(externalTarget);
      }
      await writeFile(join(externalTarget, "sentinel.txt"), "outside\n");
      const outsideBefore = await snapshot(externalTarget);
      await rm(join(root, target), { force: true, recursive: true });
      await symlink(externalTarget, join(root, target), "dir");

      await expect(buildPrompt(root)).rejects.toThrow(SYMLINK_ERROR);

      expect(await snapshot(externalTarget)).toEqual(outsideBefore);
    }
  });

  test("requires immutable rebase refs and explicit reviewed replay", async () => {
    for (const ref of [
      "main",
      "v1.0.0",
      "ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD",
      "abc123",
      "a".repeat(41),
    ]) {
      expect(() => parseImmutableCommit(ref)).toThrow(PromptLayerError);
    }

    const root = await fixture();
    const commit = "1".repeat(40);
    const fetched: string[] = [];
    const fetcher = async (url: string) => {
      fetched.push(url);
      if (url.endsWith("/LICENSE")) {
        return {
          status: 200,
          body: await readFile(
            join(root, "packages/core/prompt-layer/upstream/LICENSE"),
          ),
        };
      }
      if (url.endsWith("/NOTICE")) {
        return {
          status: 200,
          body: await readFile(
            join(root, "packages/core/prompt-layer/upstream/NOTICE"),
          ),
        };
      }
      return {
        status: 200,
        body: await readFile(
          join(root, "packages/core/prompt-layer/upstream/default.md"),
        ),
      };
    };
    const before = await snapshot(root);
    await expect(rebasePrompt(root, commit, { fetcher })).rejects.toThrow(
      "No files were changed",
    );
    expect(await snapshot(root)).toEqual(before);
    expect(fetched.sort()).toEqual(
      [
        `https://raw.githubusercontent.com/openai/codex/${commit}/LICENSE`,
        `https://raw.githubusercontent.com/openai/codex/${commit}/NOTICE`,
        `https://raw.githubusercontent.com/openai/codex/${commit}/codex-rs/protocol/src/prompts/base_instructions/default.md`,
      ].sort(),
    );

    const candidatePath = join(root, "reviewed-rebase.md");
    const candidate = (
      await readFile(join(root, "instructions/skizzles-base.md"), "utf8")
    ).replace("bc5c9161b46feddc13282652fd2cfdf1e5bab4a9", commit);
    await writeFile(candidatePath, candidate);
    await rebasePrompt(root, commit, { candidatePath, fetcher });
    await checkPrompt(root);
    const manifest = (await Bun.file(
      join(root, "packages/core/prompt-layer/manifest.json"),
    ).json()) as ManifestFixture;
    expect(manifest.upstream.commit).toBe(commit);
    expect(
      await readFile(join(root, "instructions/skizzles-base.md"), "utf8"),
    ).toContain(commit);
  });

  test("rebases a reviewed candidate when the old patch fails on a changed baseline", async () => {
    const root = await fixture();
    const commit = "3".repeat(40);
    const oldBaseline = await readFile(
      join(root, "packages/core/prompt-layer/upstream/default.md"),
    );
    const changedBaseline = Buffer.concat([
      Buffer.from("Changed upstream preface.\n"),
      oldBaseline,
    ]);
    const fetcher = fixtureFetcher(root, changedBaseline);
    const before = await snapshot(root);

    await expect(rebasePrompt(root, commit, { fetcher })).rejects.toThrow(
      FAILED_OLD_REPLAY,
    );
    expect(await snapshot(root)).toEqual(before);

    const current = await readFile(
      join(root, "instructions/skizzles-base.md"),
      "utf8",
    );
    const candidatePath = join(root, "changed-baseline-candidate.md");
    const candidate = current
      .replace(canonicalHeader(currentCommit()), canonicalHeader(commit))
      .replace("-->\n\n", "-->\n\nChanged upstream preface.\n");
    await writeFile(candidatePath, candidate);
    await rebasePrompt(root, commit, { candidatePath, fetcher });
    await checkPrompt(root);

    expect(
      await readFile(
        join(root, "packages/core/prompt-layer/upstream/default.md"),
      ),
    ).toEqual(changedBaseline);
    expect(
      await readFile(join(root, "instructions/skizzles-base.md"), "utf8"),
    ).toBe(candidate);
  });

  test("rolls back a late rebase promotion failure with exact prior bytes", async () => {
    const root = await fixture();
    const commit = "4".repeat(40);
    const oldBaseline = await readFile(
      join(root, "packages/core/prompt-layer/upstream/default.md"),
    );
    const changedBaseline = Buffer.concat([
      Buffer.from("Changed upstream preface.\n"),
      oldBaseline,
    ]);
    const current = await readFile(
      join(root, "instructions/skizzles-base.md"),
      "utf8",
    );
    const candidatePath = join(root, "late-rebase-candidate.md");
    await writeFile(
      candidatePath,
      current
        .replace(canonicalHeader(currentCommit()), canonicalHeader(commit))
        .replace("-->\n\n", "-->\n\nChanged upstream preface.\n"),
    );
    const before = await snapshot(root);

    await expect(
      rebasePrompt(root, commit, {
        candidatePath,
        fetcher: fixtureFetcher(root, changedBaseline),
        transactionFault: { promotionIndex: 6 },
      }),
    ).rejects.toThrow("Injected transaction promotion failure");

    expect(await snapshot(root)).toEqual(before);
  });

  test("rebase rejects unsuccessful fetches without mutation", async () => {
    const root = await fixture();
    const before = await snapshot(root);
    await expect(
      rebasePrompt(root, "2".repeat(40), {
        fetcher: async () => ({ status: 404, body: new Uint8Array() }),
      }),
    ).rejects.toThrow("HTTP 404");
    expect(await snapshot(root)).toEqual(before);
  });

  test("refuses concurrent same-process mutation and makes check non-writing", async () => {
    const root = await fixture();
    let signalAcquired: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = buildPrompt(root, {
      lockHooks: {
        afterAcquire: async () => {
          signalAcquired?.();
          await hold;
        },
      },
    });
    await acquired;
    const beforeCheck = await snapshot(root);

    await expect(buildPrompt(root)).rejects.toThrow(LIVE_PID_ERROR);
    await expect(checkPrompt(root)).rejects.toThrow(ACTIVE_MUTATION_ERROR);
    expect(await snapshot(root)).toEqual(beforeCheck);

    releaseFirst?.();
    await first;
  });

  test("refuses a live external lock owner", async () => {
    const root = await fixture();
    const child = Bun.spawn(["bun", "-e", "setTimeout(() => {}, 30_000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const token = "11111111-1111-4111-8111-111111111111";
    const provider = identityProvider([
      [process.pid, "current-process"],
      [child.pid, "external-child"],
    ]);
    await writeMutationOwner(
      root,
      child.pid,
      token,
      "rebase",
      "external-child",
    );
    const before = await snapshot(root);
    try {
      await expect(
        buildPrompt(root, { processIdentityProvider: provider }),
      ).rejects.toThrow(LIVE_PID_ERROR);
      await expect(
        checkPrompt(root, { processIdentityProvider: provider }),
      ).rejects.toThrow(ACTIVE_MUTATION_ERROR);
      expect(await snapshot(root)).toEqual(before);
    } finally {
      child.kill();
      await child.exited;
      await rm(join(root, "packages/core/prompt-layer/.mutation-lock"), {
        force: true,
        recursive: true,
      });
    }
  });

  test("reclaims a stale owner and preserves a concurrent replacement lock", async () => {
    const staleToken = "22222222-2222-4222-8222-222222222222";
    const stalePid = await exitedPid();
    const root = await fixture();
    await writeMutationOwner(root, stalePid, staleToken, "author");
    await writeFile(
      join(root, "packages/core/prompt-layer/.mutation-lock/reclaim.json"),
      `${JSON.stringify(
        {
          version: 1,
          pid: stalePid,
          processStartIdentity: "exited-process",
          token: "44444444-4444-4444-8444-444444444444",
          createdAtUnixMs: Date.now(),
        },
        null,
        2,
      )}\n`,
    );
    await buildPrompt(root);
    expect(
      await Bun.file(
        join(root, "packages/core/prompt-layer/.mutation-lock"),
      ).exists(),
    ).toBe(false);

    const racedRoot = await fixture();
    await writeMutationOwner(racedRoot, stalePid, staleToken, "author");
    const replacementToken = "33333333-3333-4333-8333-333333333333";
    await expect(
      buildPrompt(racedRoot, {
        processIdentityProvider: identityProvider([
          [process.pid, "current-process"],
        ]),
        lockHooks: {
          afterStaleQuarantine: async (lockPath) => {
            await mkdir(lockPath);
            await writeFile(
              join(lockPath, "owner.json"),
              mutationOwnerBytes(
                process.pid,
                replacementToken,
                "build",
                "current-process",
              ),
            );
          },
        },
      }),
    ).rejects.toThrow(REPLACEMENT_OWNER_ERROR);
    const replacement = await readFile(
      join(racedRoot, "packages/core/prompt-layer/.mutation-lock/owner.json"),
      "utf8",
    );
    expect(replacement).toContain(replacementToken);
    await rm(join(racedRoot, "packages/core/prompt-layer/.mutation-lock"), {
      force: true,
      recursive: true,
    });
  });

  test("never removes a replacement lock when a delayed initializer resumes", async () => {
    const root = await fixture();
    const identities = new Map<number, string>([
      [process.pid, "same-live-process"],
    ]);
    const provider = mutableIdentityProvider(identities);
    let signalInitializing: (() => void) | undefined;
    let resumeInitializer: (() => void) | undefined;
    let signalReplacement: (() => void) | undefined;
    let releaseReplacement: (() => void) | undefined;
    const initializing = new Promise<void>((resolve) => {
      signalInitializing = resolve;
    });
    const initializerHold = new Promise<void>((resolve) => {
      resumeInitializer = resolve;
    });
    const replacementAcquired = new Promise<void>((resolve) => {
      signalReplacement = resolve;
    });
    const replacementHold = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });

    const delayed = buildPrompt(root, {
      processIdentityProvider: provider,
      lockHooks: {
        beforeOwnerWrite: async () => {
          signalInitializing?.();
          await initializerHold;
        },
      },
    });
    await initializing;

    const replacement = buildPrompt(root, {
      processIdentityProvider: provider,
      incompleteLockGraceMs: 0,
      lockHooks: {
        afterAcquire: async () => {
          signalReplacement?.();
          await replacementHold;
        },
      },
    });
    await replacementAcquired;
    resumeInitializer?.();
    await expect(delayed).rejects.toThrow();

    await expect(
      buildPrompt(root, { processIdentityProvider: provider }),
    ).rejects.toThrow(LIVE_PID_ERROR);
    expect(
      await Bun.file(
        join(root, "packages/core/prompt-layer/.mutation-lock/owner.json"),
      ).exists(),
    ).toBe(true);

    releaseReplacement?.();
    await replacement;
  });

  test("uses process-start identity to distinguish a live owner from PID reuse", async () => {
    const matchingRoot = await fixture();
    const token = "55555555-5555-4555-8555-555555555555";
    const matching = identityProvider([[process.pid, "matching-start"]]);
    await writeMutationOwner(
      matchingRoot,
      process.pid,
      token,
      "build",
      "matching-start",
    );
    await expect(
      buildPrompt(matchingRoot, { processIdentityProvider: matching }),
    ).rejects.toThrow(LIVE_PID_ERROR);

    const reusedRoot = await fixture();
    await writeMutationOwner(
      reusedRoot,
      process.pid,
      token,
      "build",
      "prior-process-start",
    );
    const reused = identityProvider([[process.pid, "current-process-start"]]);
    await buildPrompt(reusedRoot, { processIdentityProvider: reused });
    expect(
      await pathExistsForTest(
        join(reusedRoot, "packages/core/prompt-layer/.mutation-lock"),
      ),
    ).toBe(false);
  });

  test("keeps a Darwin live owner stable across caller timezone and locale changes", async () => {
    if (process.platform !== "darwin") return;
    const root = await fixture();
    const originalEnvironment = {
      LANG: process.env["LANG"],
      LC_ALL: process.env["LC_ALL"],
      TZ: process.env.TZ,
    };
    let signalAcquired: (() => void) | undefined;
    let releaseOwner: (() => void) | undefined;
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    process.env["LANG"] = "tr_TR.UTF-8";
    process.env["LC_ALL"] = "tr_TR.UTF-8";
    process.env.TZ = "Pacific/Honolulu";
    const owner = buildPrompt(root, {
      lockHooks: {
        afterAcquire: async () => {
          signalAcquired?.();
          await hold;
        },
      },
    });
    await acquired;
    try {
      process.env["LANG"] = "de_DE.UTF-8";
      process.env["LC_ALL"] = "de_DE.UTF-8";
      process.env.TZ = "Asia/Tokyo";
      await expect(buildPrompt(root)).rejects.toThrow(LIVE_PID_ERROR);
      const layerEntries = await readdir(
        join(root, "packages/core/prompt-layer"),
      );
      expect(
        layerEntries.some((name) => name.startsWith(".mutation-stale-")),
      ).toBe(false);
      expect(layerEntries).toContain(".mutation-lock");
    } finally {
      restoreEnvironment("LANG", originalEnvironment.LANG);
      restoreEnvironment("LC_ALL", originalEnvironment.LC_ALL);
      restoreEnvironment("TZ", originalEnvironment.TZ);
      releaseOwner?.();
      await owner;
    }
  });

  test("fails closed when process-start identity is unavailable", async () => {
    const acquisitionRoot = await fixture();
    const unavailable = identityProvider([]);
    await expect(
      buildPrompt(acquisitionRoot, {
        processIdentityProvider: unavailable,
      }),
    ).rejects.toThrow(CURRENT_PROCESS_IDENTITY_ERROR);
    expect(
      await pathExistsForTest(
        join(acquisitionRoot, "packages/core/prompt-layer/.mutation-lock"),
      ),
    ).toBe(false);

    const recoveryRoot = await fixture();
    const token = "77777777-7777-4777-8777-777777777777";
    await writeMutationOwner(
      recoveryRoot,
      process.pid,
      token,
      "build",
      "unverifiable-owner",
    );
    let identityLookups = 0;
    const unavailableDuringRecovery: ProcessIdentityProvider = {
      processStartIdentity: () => {
        identityLookups += 1;
        return Promise.resolve(
          identityLookups === 1 ? "replacement-owner" : undefined,
        );
      },
    };
    await expect(
      buildPrompt(recoveryRoot, {
        processIdentityProvider: unavailableDuringRecovery,
      }),
    ).rejects.toThrow(UNVERIFIABLE_PROCESS_IDENTITY_ERROR);
    expect(
      await readFile(
        join(
          recoveryRoot,
          "packages/core/prompt-layer/.mutation-lock/owner.json",
        ),
        "utf8",
      ),
    ).toContain(token);
  });

  test("handles incomplete-lock clock skew without deleting a live replacement", async () => {
    const futureRoot = await fixture();
    const futureLock = join(
      futureRoot,
      "packages/core/prompt-layer/.mutation-lock",
    );
    await mkdir(futureLock);
    const future = new Date(Date.now() + 60_000);
    await utimes(futureLock, future, future);
    await expect(
      buildPrompt(futureRoot, { incompleteLockGraceMs: 0 }),
    ).rejects.toThrow(BOUNDED_GRACE_ERROR);
    expect(await pathExistsForTest(futureLock)).toBe(true);

    const pastRoot = await fixture();
    const pastLock = join(
      pastRoot,
      "packages/core/prompt-layer/.mutation-lock",
    );
    await mkdir(pastLock);
    const past = new Date(Date.now() - 60_000);
    await utimes(pastLock, past, past);
    await buildPrompt(pastRoot, { incompleteLockGraceMs: 0 });
    expect(await pathExistsForTest(pastLock)).toBe(false);
  });

  test("recovers proven-dead stale and release quarantines but preserves malformed remnants", async () => {
    const staleRoot = await fixture();
    const deadPid = await exitedPid();
    const staleToken = "66666666-6666-4666-8666-666666666666";
    await writeMutationOwner(
      staleRoot,
      deadPid,
      staleToken,
      "author",
      "dead-owner",
    );
    await expect(
      buildPrompt(staleRoot, {
        lockHooks: {
          afterStaleQuarantine: () =>
            Promise.reject(new Error("simulated crash after stale quarantine")),
        },
      }),
    ).rejects.toThrow("simulated crash after stale quarantine");
    const staleOrphan = join(
      staleRoot,
      `packages/core/prompt-layer/.mutation-stale-${staleToken}`,
    );
    expect(await pathExistsForTest(staleOrphan)).toBe(true);
    await expect(checkPrompt(staleRoot)).rejects.toThrow(QUARANTINE_ERROR);
    await buildPrompt(staleRoot);
    expect(await pathExistsForTest(staleOrphan)).toBe(false);

    const releaseRoot = await fixture();
    const identities = new Map<number, string>([
      [process.pid, "release-owner"],
    ]);
    const provider = mutableIdentityProvider(identities);
    await expect(
      buildPrompt(releaseRoot, {
        processIdentityProvider: provider,
        lockHooks: {
          afterReleaseQuarantine: () =>
            Promise.reject(
              new Error("simulated crash after release quarantine"),
            ),
        },
      }),
    ).rejects.toThrow("simulated crash after release quarantine");
    identities.set(process.pid, "reused-process");
    await buildPrompt(releaseRoot, { processIdentityProvider: provider });
    expect(
      (await readdir(join(releaseRoot, "packages/core/prompt-layer"))).some(
        (name) => name.startsWith(".mutation-release-"),
      ),
    ).toBe(false);

    const malformedRoot = await fixture();
    const malformed = join(
      malformedRoot,
      "packages/core/prompt-layer/.mutation-stale-not-a-token",
    );
    await mkdir(malformed);
    await expect(buildPrompt(malformedRoot)).rejects.toThrow(MALFORMED_ERROR);
    expect(await pathExistsForTest(malformed)).toBe(true);

    const liveRoot = await fixture();
    const liveToken = "88888888-8888-4888-8888-888888888888";
    const liveOrphan = join(
      liveRoot,
      `packages/core/prompt-layer/.mutation-release-${liveToken}`,
    );
    await mkdir(liveOrphan);
    await writeFile(
      join(liveOrphan, "owner.json"),
      mutationOwnerBytes(process.pid, liveToken, "build", "live-orphan-owner"),
    );
    await expect(
      buildPrompt(liveRoot, {
        processIdentityProvider: identityProvider([
          [process.pid, "live-orphan-owner"],
        ]),
      }),
    ).rejects.toThrow(LIVE_ORPHAN_ERROR);
    expect(await pathExistsForTest(liveOrphan)).toBe(true);

    const unrelatedRoot = await fixture();
    const unrelated = join(
      unrelatedRoot,
      "packages/core/prompt-layer/.mutation-unrelated",
    );
    await mkdir(unrelated);
    await buildPrompt(unrelatedRoot);
    expect(await pathExistsForTest(unrelated)).toBe(true);
  });

  test("CLI rejects malformed authoring and rebase arguments before side effects", () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const source = join(repoRoot, "packages/core/src/prompt-layer.ts");
    for (const args of [
      ["build", "extra"],
      ["patch", "one", "two"],
      ["rebase", "main"],
      ["rebase", "5".repeat(40), "--candidate"],
    ]) {
      const result = Bun.spawnSync(["bun", source, ...args], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(1);
    }
    const forwarded = Bun.spawnSync(
      ["bun", "run", "prompt:rebase", "--", "main"],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
    );
    expect(forwarded.exitCode).toBe(1);
    expect(forwarded.stderr.toString()).toContain("40-hex commit");
  });

  test("all prompt artifacts and transaction metadata are forced to exact LF", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const paths = [
      "packages/core/prompt-layer/manifest.json",
      "packages/core/prompt-layer/upstream/default.md",
      "packages/core/prompt-layer/upstream/LICENSE",
      "packages/core/prompt-layer/upstream/NOTICE",
      "packages/core/prompt-layer/skizzles-base.patch",
      "packages/core/prompt-layer/.transaction/journal.json",
      "packages/core/prompt-layer/.mutation-lock/owner.json",
      "packages/core/prompt-layer/.mutation-lock/reclaim.json",
      "instructions/skizzles-base.md",
      "instructions/skizzles-base.provenance.json",
    ];
    for (const path of paths.filter(
      (path) =>
        !(path.includes("/.transaction") || path.includes("/.mutation-lock")),
    )) {
      const bytes = await readFile(join(repoRoot, path));
      expect(bytes.includes(13)).toBe(false);
      expect(bytes.at(-1)).toBe(10);
    }
    const attributes = Bun.spawnSync(
      ["git", "check-attr", "eol", "--", ...paths],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
    );
    expect(attributes.exitCode).toBe(0);
    const lines = attributes.stdout.toString().trim().split("\n");
    expect(lines).toHaveLength(paths.length);
    for (const line of lines) expect(line).toEndWith("eol: lf");
  });

  test("tracked prompt-layer artifacts contain no machine-specific paths", async () => {
    const root = resolve(import.meta.dir, "../../..");
    for (const path of [
      "packages/core/prompt-layer/manifest.json",
      "packages/core/prompt-layer/upstream/default.md",
      "packages/core/prompt-layer/upstream/LICENSE",
      "packages/core/prompt-layer/upstream/NOTICE",
      "packages/core/prompt-layer/skizzles-base.patch",
      "instructions/skizzles-base.md",
      "instructions/skizzles-base.provenance.json",
    ]) {
      const contents = await readFile(join(root, path), "utf8");
      expect(contents).not.toMatch(MACHINE_PATH);
    }
  });
});

interface ManifestFixture {
  upstream: {
    commit: string;
    path: string;
    baseline: FileFactFixture;
  };
  patch: FileFactFixture;
  output: FileFactFixture;
}

interface FileFactFixture {
  path: string;
  sha256: string;
  bytes: number;
}

interface TransactionJournalFixture {
  operation: string;
  entries: TransactionEntryFixture[];
}

interface TransactionEntryFixture {
  path: string;
  oldSha256: string;
  oldBytes: number;
  newSha256: string;
  newBytes: number;
}

function currentCommit(): string {
  return "bc5c9161b46feddc13282652fd2cfdf1e5bab4a9";
}

function canonicalHeader(commit: string): string {
  return `<!--\nSkizzles prompt layer provenance\nRepository: https://github.com/openai/codex\nCommit: ${commit}\nPath: codex-rs/protocol/src/prompts/base_instructions/default.md\nBaseline role: pinned generic upstream compatibility baseline; not a claim about any selected model's active baseline\n-->\n\n`;
}

function gitBlobId(bytes: Buffer): string {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

async function fixture(): Promise<string> {
  const source = resolve(import.meta.dir, "../../..");
  const root = await mkdtemp(join(tmpdir(), "skizzles-prompt-layer-test-"));
  roots.push(root);
  await cp(
    join(source, "packages/core/prompt-layer"),
    join(root, "packages/core/prompt-layer"),
    {
      recursive: true,
    },
  );
  await cp(join(source, "instructions"), join(root, "instructions"), {
    recursive: true,
  });
  return root;
}

async function changedCandidate(root: string, delta: string): Promise<string> {
  const candidatePath = join(root, "reviewed-candidate.md");
  const current = await readFile(
    join(root, "instructions/skizzles-base.md"),
    "utf8",
  );
  await writeFile(candidatePath, `${current}\n<!-- ${delta} -->\n`);
  return candidatePath;
}

async function leaveCrashedAuthorTransaction(root: string): Promise<void> {
  const candidatePath = await changedCandidate(root, "crashed author");
  try {
    await authorPromptPatch(root, candidatePath, {
      transactionFault: { promotionIndex: 3, simulateCrash: true },
    });
  } catch (error) {
    if (String(error).includes("Simulated transaction crash")) return;
    throw error;
  }
  throw new Error("Expected a simulated transaction crash.");
}

async function writeMutationOwner(
  root: string,
  pid: number,
  token: string,
  operation: "build" | "author" | "rebase",
  processStartIdentity = "test-process-start",
): Promise<void> {
  const lockPath = join(root, "packages/core/prompt-layer/.mutation-lock");
  await mkdir(lockPath);
  await writeFile(
    join(lockPath, "owner.json"),
    mutationOwnerBytes(pid, token, operation, processStartIdentity),
  );
}

function mutationOwnerBytes(
  pid: number,
  token: string,
  operation: "build" | "author" | "rebase",
  processStartIdentity: string,
): string {
  return `${JSON.stringify(
    {
      version: 1,
      operation,
      pid,
      processStartIdentity,
      token,
      createdAtUnixMs: Date.now(),
    },
    null,
    2,
  )}\n`;
}

function identityProvider(
  identities: Array<readonly [number, string]>,
): ProcessIdentityProvider {
  return mutableIdentityProvider(new Map(identities));
}

function mutableIdentityProvider(
  identities: Map<number, string>,
): ProcessIdentityProvider {
  return {
    processStartIdentity: async (pid) => identities.get(pid),
  };
}

async function pathExistsForTest(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function exitedPid(): Promise<number> {
  const child = Bun.spawn(["bun", "-e", "process.exit(0)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const pid = child.pid;
  await child.exited;
  return pid;
}

function fixtureFetcher(root: string, baseline: Buffer) {
  return async (url: string) => {
    if (url.endsWith("/LICENSE")) {
      return {
        status: 200,
        body: await readFile(
          join(root, "packages/core/prompt-layer/upstream/LICENSE"),
        ),
      };
    }
    if (url.endsWith("/NOTICE")) {
      return {
        status: 200,
        body: await readFile(
          join(root, "packages/core/prompt-layer/upstream/NOTICE"),
        ),
      };
    }
    return { status: 200, body: baseline };
  };
}

async function updateManifestFact(
  root: string,
  key: "patch" | "output",
  bytes: Buffer,
): Promise<void> {
  const path = join(root, "packages/core/prompt-layer/manifest.json");
  const manifest = (await Bun.file(path).json()) as ManifestFixture;
  manifest[key].sha256 = createHash("sha256").update(bytes).digest("hex");
  manifest[key].bytes = bytes.byteLength;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of await filesUnder(root)) {
    result[path] = createHash("sha256")
      .update(await readFile(join(root, path)))
      .digest("hex");
  }
  return result;
}

async function filesUnder(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await filesUnder(root, path)));
    else paths.push(path);
  }
  return paths.sort();
}
