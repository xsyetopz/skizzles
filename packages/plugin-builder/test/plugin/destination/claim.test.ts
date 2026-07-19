// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import process from "node:process";
import { replaceDirectoryTransaction } from "../../../src/plugin/destination/transaction.ts";
import {
  collectMessages,
  crashAt,
  temporaryRoot as createTemporaryRoot,
  currentClaim,
  expectProcessGone,
  nonAllocatorArtifacts,
  seededDestination,
  spawnTransaction,
  startWorker,
  waitForFile,
  writeWorkerModule,
} from "./claim-fixture.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("plugin destination atomic claims", () => {
  it("does not recover when only the live controller's helper is killed", async () => {
    const parent = await temporaryRoot("skizzles-claim-helper-killed-");
    const destination = await seededDestination(parent);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let competingConstructionRan = false;
    const active = replaceDirectoryTransaction(destination, async (stage) => {
      await writeFile(join(stage, "first"), "first\n");
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const claim = await currentClaim(parent);
    process.kill(claim.pid, "SIGKILL");

    await expect(
      replaceDirectoryTransaction(destination, () => {
        competingConstructionRan = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow("locked by another operation");
    expect(competingConstructionRan).toBe(false);

    release.resolve();
    await active;
    expect(await nonAllocatorArtifacts(parent)).toEqual([]);
  });

  it("rejects a spoofed retirement marker for a live controller", async () => {
    const parent = await temporaryRoot("skizzles-claim-marker-spoof-");
    const destination = await seededDestination(parent);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const active = replaceDirectoryTransaction(destination, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const claim = await currentClaim(parent);
    await writeFile(
      `${claim.path}.retired`,
      `${JSON.stringify({ dev: "0", ino: "0", token: claim.token })}\n`,
      { mode: 0o600 },
    );
    process.kill(claim.pid, "SIGKILL");

    await expect(
      replaceDirectoryTransaction(destination, () => Promise.resolve()),
    ).rejects.toThrow("locked by another operation");
    expect(await Bun.file(`${claim.path}.retired`).exists()).toBe(true);
    release.resolve();
    await active;
  });

  it("rejects an orphaned recovery retirement sidecar", async () => {
    const parent = await temporaryRoot("skizzles-lease-marker-spoof-");
    const destination = await seededDestination(parent);
    expect(crashAt(destination, "owner-ready")).toBe(73);
    const claim = await currentClaim(parent);
    const marker = `${claim.path}.recovery-1.retired`;
    await writeFile(
      marker,
      `${JSON.stringify({ dev: "0", ino: "0", token: claim.token })}\n`,
      { mode: 0o600 },
    );
    let constructed = false;
    await expect(
      replaceDirectoryTransaction(destination, () => {
        constructed = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow("locked by another operation");
    expect(constructed).toBe(false);
    expect(await Bun.file(marker).exists()).toBe(true);
  });

  it("reaps claim and recovery helpers when owner identification fails", async () => {
    const parent = await temporaryRoot("skizzles-claim-helper-setup-");
    const destination = await seededDestination(parent);
    let helperPid = 0;
    await expect(
      replaceDirectoryTransaction(destination, () => Promise.resolve(), {
        checkpoint: (point, path) => {
          if (point !== "claim-helper-ready" || path === undefined) return;
          helperPid = Number(path);
          process.kill(helperPid, "SIGKILL");
        },
      }),
    ).rejects.toThrow("could not identify lock owner");
    await expectProcessGone(helperPid);

    expect(crashAt(destination, "owner-ready")).toBe(73);
    helperPid = 0;
    await expect(
      replaceDirectoryTransaction(destination, () => Promise.resolve(), {
        checkpoint: (point, path) => {
          if (point !== "recovery-helper-ready" || path === undefined) return;
          helperPid = Number(path);
          process.kill(helperPid, "SIGKILL");
        },
      }),
    ).rejects.toThrow("could not identify lock owner");
    await expectProcessGone(helperPid);
    await expect(
      replaceDirectoryTransaction(destination, () =>
        Promise.reject(new Error("recovered after owner failure")),
      ),
    ).rejects.toThrow("recovered after owner failure");
    expect(await nonAllocatorArtifacts(parent)).toEqual([]);
  });

  it("reaps claim and recovery helpers when setup checkpoints fail", async () => {
    const parent = await temporaryRoot("skizzles-claim-helper-checkpoint-");
    const destination = await seededDestination(parent);
    let claimHelperPid = 0;
    await expect(
      replaceDirectoryTransaction(destination, () => Promise.resolve(), {
        checkpoint: (point, path) => {
          if (point !== "claim-helper-ready" || path === undefined) return;
          claimHelperPid = Number(path);
          throw new Error("claim checkpoint failed");
        },
      }),
    ).rejects.toThrow("claim checkpoint failed");
    await expectProcessGone(claimHelperPid);

    expect(crashAt(destination, "owner-ready")).toBe(73);
    let recoveryHelperPid = 0;
    await expect(
      replaceDirectoryTransaction(destination, () => Promise.resolve(), {
        checkpoint: (point, path) => {
          if (point !== "recovery-helper-ready" || path === undefined) return;
          recoveryHelperPid = Number(path);
          throw new Error("recovery checkpoint failed");
        },
      }),
    ).rejects.toThrow("recovery checkpoint failed");
    await expectProcessGone(recoveryHelperPid);
    await expect(
      replaceDirectoryTransaction(destination, () =>
        Promise.reject(new Error("recovered")),
      ),
    ).rejects.toThrow("recovered");
    expect(await nonAllocatorArtifacts(parent)).toEqual([]);
  });

  it("identifies claim and recovery helpers repeatedly under load", async () => {
    const destinations = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const parent = await temporaryRoot(`skizzles-helper-load-${index}-`);
        const destination = await seededDestination(parent);
        expect(crashAt(destination, "owner-ready")).toBe(73);
        return destination;
      }),
    );
    const messages = await Promise.all(
      destinations.map(async (destination, index) => {
        try {
          await replaceDirectoryTransaction(destination, () =>
            Promise.reject(new Error(`constructed-${index}`)),
          );
          return "resolved unexpectedly";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }),
    );
    expect(messages).toEqual(
      Array.from(
        { length: destinations.length },
        (_, index) => `constructed-${index}`,
      ),
    );
  }, 20_000);

  it("publishes ownership before creating a cross-process lock directory", async () => {
    const parent = await temporaryRoot("skizzles-claim-process-");
    const destination = await seededDestination(parent);
    const claimEntered = join(parent, "claim-entered");
    const claimRelease = join(parent, "claim-release");
    const secondEntered = join(parent, "second-entered");
    const secondRelease = join(parent, "second-release");
    const first = spawnTransaction(destination, "first", {
      CLAIM_ENTERED: claimEntered,
      CLAIM_RELEASE: claimRelease,
    });
    await waitForFile(claimEntered, first);
    const second = spawnTransaction(destination, "second", {
      ENTERED: secondEntered,
      RELEASE: secondRelease,
    });
    await waitForFile(secondEntered);
    await writeFile(claimRelease, "release\n");
    expect(await first.exited).toBe(42);
    expect((await first.stderr.text()).trim()).toContain(
      "locked by another operation",
    );
    await writeFile(secondRelease, "release\n");
    expect(await second.exited).toBe(0);
    expect(await readFile(join(destination, "second"), "utf8")).toBe(
      "second\n",
    );
    expect(await nonAllocatorArtifacts(parent)).toEqual([]);
  }, 20_000);

  it("fails closed when PATH supplies a failing ps command", async () => {
    const parent = await temporaryRoot("skizzles-claim-ps-failure-");
    const destination = await seededDestination(parent);
    const entered = join(parent, "first-entered");
    const release = join(parent, "first-release");
    const first = spawnTransaction(destination, "first", {
      ENTERED: entered,
      RELEASE: release,
    });
    await waitForFile(entered, first);
    const failingPath = join(parent, "failing-path");
    await mkdir(failingPath);
    await writeFile(join(failingPath, "ps"), "#!/bin/sh\nexit 9\n");
    await chmod(join(failingPath, "ps"), 0o755);
    const blocked = spawnTransaction(destination, "second", {
      PATH: `${failingPath}${delimiter}${process.env["PATH"] ?? ""}`,
    });
    expect(await blocked.exited).toBe(42);
    expect((await blocked.stderr.text()).trim()).toContain(
      "locked by another operation",
    );
    await writeFile(release, "release\n");
    expect(await first.exited).toBe(0);
    expect(await nonAllocatorArtifacts(parent)).toEqual([]);
  }, 20_000);

  it("blocks a live Worker owner and recovers after Worker retirement", async () => {
    const parent = await temporaryRoot("skizzles-claim-worker-");
    const destination = await seededDestination(parent);
    const gate = join(parent, "worker-release");
    const workerModule = await writeWorkerModule(parent);
    const first = startWorker(workerModule, destination, "first", gate);
    const firstMessages = collectMessages(first);
    expect((await firstMessages.next()).value).toEqual({ event: "entered" });
    const blocked = startWorker(workerModule, destination, "second", gate);
    const blockedMessages = collectMessages(blocked);
    expect((await blockedMessages.next()).value).toEqual({
      event: "error",
      message: "Plugin staging destination is locked by another operation.",
    });
    blocked.terminate();
    first.terminate();
    const recovered = startWorker(workerModule, destination, "second", gate);
    const recoveredMessages = collectMessages(recovered);
    expect((await recoveredMessages.next()).value).toEqual({
      event: "constructed",
    });
    expect((await recoveredMessages.next()).value).toEqual({ event: "done" });
    recovered.terminate();
    expect(await readFile(join(destination, "second"), "utf8")).toBe(
      "second\n",
    );
    expect(await nonAllocatorArtifacts(parent)).toEqual([]);
  }, 20_000);
});

function temporaryRoot(prefix: string): Promise<string> {
  return createTemporaryRoot(prefix, roots);
}
