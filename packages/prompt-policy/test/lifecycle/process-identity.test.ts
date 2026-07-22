import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { buildPrompt, type ProcessIdentityProvider } from "../../src/cli.ts";
import {
  CURRENT_PROCESS_IDENTITY_ERROR,
  cleanupFixtures,
  fixture,
  identityProvider,
  LIVE_PID_ERROR,
  pathExistsForTest,
  restoreEnvironment,
  UNVERIFIABLE_PROCESS_IDENTITY_ERROR,
  writeMutationOwner,
} from "./fixture.ts";

afterEach(cleanupFixtures);

describe("prompt mutation process-identity contracts", () => {
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
        join(reusedRoot, "packages/prompt-policy/assets/.mutation-lock"),
      ),
    ).toBe(false);
  });

  test("keeps a Darwin live owner stable across caller timezone and locale changes", async () => {
    if (process.platform !== "darwin") {
      return;
    }
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
        join(root, "packages/prompt-policy/assets"),
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
        join(acquisitionRoot, "packages/prompt-policy/assets/.mutation-lock"),
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
          "packages/prompt-policy/assets/.mutation-lock/owner.json",
        ),
        "utf8",
      ),
    ).toContain(token);
  });
});
