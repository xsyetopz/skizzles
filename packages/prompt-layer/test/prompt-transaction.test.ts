// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, test } from "bun:test";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorPromptPatch,
  buildPrompt,
  checkPrompt,
  PromptLayerError,
} from "../src/prompt-layer.ts";
import {
  changedCandidate,
  cleanupFixtures,
  fixture,
  leaveCrashedAuthorTransaction,
  MACHINE_PATH,
  SYMLINK_ERROR,
  snapshot,
  type TransactionEntryFixture,
  type TransactionJournalFixture,
  trackFixtureRoot,
} from "./prompt-fixture.ts";

afterEach(cleanupFixtures);

describe("durable prompt transaction contracts", () => {
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
          join(root, "packages/prompt-layer/assets/.transaction"),
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
      join(root, "packages/prompt-layer/assets/.transaction/journal.json"),
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
        "packages/prompt-layer/assets/.transaction/journal.json",
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
          join(
            root,
            "packages/prompt-layer/assets/instructions/skizzles-base.md",
          ),
          "external post-crash edit\n",
        );
      },
      async (root) => {
        await rm(
          join(
            root,
            "packages/prompt-layer/assets/instructions/skizzles-base.md",
          ),
        );
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
          join(root, "packages/prompt-layer/assets/.transaction/journal.json"),
        ).exists(),
      ).toBe(true);
    }
  });

  test("rejects symlinked instructions and prompt-layer ancestors without outside writes", async () => {
    for (const target of [
      "packages/prompt-layer/assets/instructions",
      "packages/prompt-layer/assets",
    ]) {
      const root = await fixture();
      const external = await mkdtemp(join(tmpdir(), "skizzles-prompt-escape-"));
      trackFixtureRoot(external);
      const externalTarget = join(external, "target");
      await cp(join(root, target), externalTarget, { recursive: true });
      await writeFile(join(externalTarget, "sentinel.txt"), "outside\n");
      const outsideBefore = await snapshot(externalTarget);
      await rm(join(root, target), { force: true, recursive: true });
      await symlink(externalTarget, join(root, target), "dir");

      await expect(buildPrompt(root)).rejects.toThrow(SYMLINK_ERROR);

      expect(await snapshot(externalTarget)).toEqual(outsideBefore);
    }
  });
});
