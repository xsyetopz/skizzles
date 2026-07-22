import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  authorPromptPatch,
  checkPrompt,
  PromptLayerError,
  parseImmutableCommit,
  rebasePrompt,
} from "../../src/cli.ts";
import {
  canonicalHeader,
  changedCandidate,
  cleanupFixtures,
  compareCodeUnits,
  currentCommit,
  FAILED_OLD_REPLAY,
  fixture,
  fixtureFetcher,
  type ManifestFixture,
  pathExistsForTest,
  REBASE_PROBE_DIAGNOSTIC,
  snapshot,
} from "./fixture.ts";

afterEach(cleanupFixtures);

describe("immutable upstream rebase contracts", () => {
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
            join(root, "packages/prompt-policy/assets/upstream/LICENSE"),
          ),
        };
      }
      if (url.endsWith("/NOTICE")) {
        return {
          status: 200,
          body: await readFile(
            join(root, "packages/prompt-policy/assets/upstream/NOTICE"),
          ),
        };
      }
      return {
        status: 200,
        body: await readFile(
          join(root, "packages/prompt-policy/assets/upstream/default.md"),
        ),
      };
    };
    const before = await snapshot(root);
    await expect(rebasePrompt(root, commit, { fetcher })).rejects.toThrow(
      REBASE_PROBE_DIAGNOSTIC,
    );
    expect(await snapshot(root)).toEqual(before);
    expect(fetched.sort(compareCodeUnits)).toEqual(
      [
        `https://raw.githubusercontent.com/openai/codex/${commit}/LICENSE`,
        `https://raw.githubusercontent.com/openai/codex/${commit}/NOTICE`,
        `https://raw.githubusercontent.com/openai/codex/${commit}/codex-rs/protocol/src/prompts/base_instructions/default.md`,
      ].sort(),
    );

    const candidatePath = join(root, "reviewed-rebase.md");
    const candidate = (
      await readFile(
        join(
          root,
          "packages/prompt-policy/assets/instructions/skizzles-base.md",
        ),
        "utf8",
      )
    ).replace(currentCommit(), commit);
    await writeFile(candidatePath, candidate);
    await rebasePrompt(root, commit, { candidatePath, fetcher });
    await checkPrompt(root);
    const manifest = (await Bun.file(
      join(root, "packages/prompt-policy/assets/manifest.json"),
    ).json()) as ManifestFixture;
    expect(manifest.upstream.commit).toBe(commit);
    expect(
      await readFile(
        join(
          root,
          "packages/prompt-policy/assets/instructions/skizzles-base.md",
        ),
        "utf8",
      ),
    ).toContain(commit);
  });

  test("reports no-candidate rebase scope honestly after prior recovery", async () => {
    const root = await fixture();
    const candidatePath = await changedCandidate(root, "rebase recovery");
    const beforeInterruptedAuthor = await snapshot(root);
    await expect(
      authorPromptPatch(root, candidatePath, {
        transactionFault: { promotionIndex: 3, simulateCrash: true },
      }),
    ).rejects.toThrow("Simulated transaction crash");
    expect(
      await pathExistsForTest(
        join(root, "packages/prompt-policy/assets/.transaction/journal.json"),
      ),
    ).toBe(true);

    const commit = "9".repeat(40);
    const baseline = await readFile(
      join(root, "packages/prompt-policy/assets/upstream/default.md"),
    );
    await expect(
      rebasePrompt(root, commit, {
        fetcher: fixtureFetcher(root, baseline),
      }),
    ).rejects.toThrow(REBASE_PROBE_DIAGNOSTIC);

    expect(await snapshot(root)).toEqual(beforeInterruptedAuthor);
    const manifest = (await Bun.file(
      join(root, "packages/prompt-policy/assets/manifest.json"),
    ).json()) as ManifestFixture;
    expect(manifest.upstream.commit).toBe(currentCommit());
  });

  test("rebases a reviewed candidate when the old patch fails on a changed baseline", async () => {
    const root = await fixture();
    const commit = "3".repeat(40);
    const oldBaseline = await readFile(
      join(root, "packages/prompt-policy/assets/upstream/default.md"),
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
      join(root, "packages/prompt-policy/assets/instructions/skizzles-base.md"),
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
        join(root, "packages/prompt-policy/assets/upstream/default.md"),
      ),
    ).toEqual(changedBaseline);
    expect(
      await readFile(
        join(
          root,
          "packages/prompt-policy/assets/instructions/skizzles-base.md",
        ),
        "utf8",
      ),
    ).toBe(candidate);
  });

  test("rolls back a late rebase promotion failure with exact prior bytes", async () => {
    const root = await fixture();
    const commit = "4".repeat(40);
    const oldBaseline = await readFile(
      join(root, "packages/prompt-policy/assets/upstream/default.md"),
    );
    const changedBaseline = Buffer.concat([
      Buffer.from("Changed upstream preface.\n"),
      oldBaseline,
    ]);
    const current = await readFile(
      join(root, "packages/prompt-policy/assets/instructions/skizzles-base.md"),
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
});
