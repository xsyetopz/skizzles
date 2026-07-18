// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { buildPrompt, checkPrompt } from "../src/prompt-layer.ts";
import {
  ACTIVE_MUTATION_ERROR,
  BOUNDED_GRACE_ERROR,
  cleanupFixtures,
  exitedPid,
  fixture,
  identityProvider,
  LIVE_ORPHAN_ERROR,
  LIVE_PID_ERROR,
  MALFORMED_ERROR,
  mutableIdentityProvider,
  mutationOwnerBytes,
  pathExistsForTest,
  QUARANTINE_ERROR,
  REPLACEMENT_OWNER_ERROR,
  snapshot,
  writeMutationOwner,
} from "./prompt-fixture.ts";

afterEach(cleanupFixtures);

describe("exclusive prompt mutation lock contracts", () => {
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
      await rm(join(root, "packages/prompt-layer/assets/.mutation-lock"), {
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
      join(root, "packages/prompt-layer/assets/.mutation-lock/reclaim.json"),
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
        join(root, "packages/prompt-layer/assets/.mutation-lock"),
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
      join(racedRoot, "packages/prompt-layer/assets/.mutation-lock/owner.json"),
      "utf8",
    );
    expect(replacement).toContain(replacementToken);
    await rm(join(racedRoot, "packages/prompt-layer/assets/.mutation-lock"), {
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
        join(root, "packages/prompt-layer/assets/.mutation-lock/owner.json"),
      ).exists(),
    ).toBe(true);

    releaseReplacement?.();
    await replacement;
  });

  test("handles incomplete-lock clock skew without deleting a live replacement", async () => {
    const futureRoot = await fixture();
    const futureLock = join(
      futureRoot,
      "packages/prompt-layer/assets/.mutation-lock",
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
      "packages/prompt-layer/assets/.mutation-lock",
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
      `packages/prompt-layer/assets/.mutation-stale-${staleToken}`,
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
      (await readdir(join(releaseRoot, "packages/prompt-layer/assets"))).some(
        (name) => name.startsWith(".mutation-release-"),
      ),
    ).toBe(false);

    const malformedRoot = await fixture();
    const malformed = join(
      malformedRoot,
      "packages/prompt-layer/assets/.mutation-stale-not-a-token",
    );
    await mkdir(malformed);
    await expect(buildPrompt(malformedRoot)).rejects.toThrow(MALFORMED_ERROR);
    expect(await pathExistsForTest(malformed)).toBe(true);

    const liveRoot = await fixture();
    const liveToken = "88888888-8888-4888-8888-888888888888";
    const liveOrphan = join(
      liveRoot,
      `packages/prompt-layer/assets/.mutation-release-${liveToken}`,
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
      "packages/prompt-layer/assets/.mutation-unrelated",
    );
    await mkdir(unrelated);
    await buildPrompt(unrelatedRoot);
    expect(await pathExistsForTest(unrelated)).toBe(true);
  });
});
