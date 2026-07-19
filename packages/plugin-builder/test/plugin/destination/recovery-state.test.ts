// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import {
  link,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { replaceDirectoryTransaction } from "../../../src/plugin/destination/transaction.ts";
import {
  allocatorArtifacts,
  claimArtifacts,
  collectMessages,
  crashAt,
  temporaryRoot as createTemporaryRoot,
  currentClaim,
  durableAllocatorArtifacts,
  expectProcessGone,
  fixtureMarker,
  highWaterAt,
  latestHighWater,
  moveMarkerToTemporary,
  nonAllocatorArtifacts,
  seededDestination,
  spawnRecoveryContender,
  startWorker,
  waitForFile,
  writeRecoveryWorkerModule,
} from "./claim-fixture.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("plugin destination recovery state", () => {
  it("recovers crashes at every recovery-lease publication point", async () => {
    for (const point of [
      "recovery-helper-ready",
      "recovery-temp-ready",
      "recovery-lease-published",
      "recovery-claim-released",
      "recovery-helper-stopped",
    ]) {
      const parent = await temporaryRoot(`skizzles-lease-${point}-`);
      const destination = await seededDestination(parent);
      expect(crashAt(destination, "owner-ready")).toBe(73);
      expect(crashAt(destination, point)).toBe(73);
      await expect(
        replaceDirectoryTransaction(destination, () =>
          Promise.reject(new Error("entered after lease recovery")),
        ),
      ).rejects.toThrow("entered after lease recovery");
      // biome-ignore lint/performance/noAwaitInLoops: every crash fixture proves cleanup.
      expect(await nonAllocatorArtifacts(parent)).toEqual([]);
      // biome-ignore lint/performance/noAwaitInLoops: acquisition aliases must never survive recovery.
      expect(
        (await claimArtifacts(parent)).some((name) => name.endsWith(".tmp")),
      ).toBe(false);
    }
  }, 20_000);

  it("reconciles a Worker-terminated published acquisition alias", async () => {
    const parent = await temporaryRoot("skizzles-recovery-worker-alias-");
    const destination = await seededDestination(parent);
    expect(crashAt(destination, "owner-ready")).toBe(73);
    const module = await writeRecoveryWorkerModule(parent);
    const worker = startWorker(module, destination);
    const messages = collectMessages(worker);
    expect((await messages.next()).value).toEqual({ event: "published" });
    worker.terminate();

    await expect(
      replaceDirectoryTransaction(destination, () =>
        Promise.reject(new Error("worker alias recovered")),
      ),
    ).rejects.toThrow("worker alias recovered");
    expect(
      (await claimArtifacts(parent)).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
  }, 20_000);

  it("rejects mismatched and over-linked published acquisition aliases", async () => {
    for (const variant of ["mismatch", "hardlink"] as const) {
      const parent = await temporaryRoot(`skizzles-recovery-alias-${variant}-`);
      const destination = await seededDestination(parent);
      expect(crashAt(destination, "owner-ready")).toBe(73);
      expect(crashAt(destination, "recovery-lease-published")).toBe(73);
      const record = await latestHighWater(parent);
      await expectProcessGone(record.pid);
      const temporary = (await allocatorArtifacts(parent)).find(
        (name) =>
          name.includes(".recovery-highwater-") &&
          name.endsWith(`.${record.token}.tmp`),
      );
      if (temporary === undefined) throw new Error("acquisition alias missing");
      const temporaryPath = join(parent, temporary);
      if (variant === "mismatch") {
        await unlink(temporaryPath);
        await writeFile(temporaryPath, await readFile(record.path), {
          mode: 0o600,
        });
      } else {
        await link(record.path, `${temporaryPath}.extra`);
      }
      let constructed = false;
      await expect(
        replaceDirectoryTransaction(destination, () => {
          constructed = true;
          return Promise.resolve();
        }),
      ).rejects.toThrow("locked by another operation");
      expect(constructed).toBe(false);
    }
  }, 20_000);

  it("promotes synced claim and recovery retirement temps", async () => {
    const parent = await temporaryRoot("skizzles-retirement-temp-");
    const destination = await seededDestination(parent);
    expect(crashAt(destination, "owner-ready")).toBe(73);
    const claim = await currentClaim(parent);
    await expectProcessGone(claim.pid);
    await moveMarkerToTemporary(claim.path, claim.token);
    await expect(
      replaceDirectoryTransaction(destination, () =>
        Promise.reject(new Error("claim temp recovered")),
      ),
    ).rejects.toThrow("claim temp recovered");
    expect(await nonAllocatorArtifacts(parent)).toEqual([]);

    expect(crashAt(destination, "owner-ready")).toBe(73);
    expect(crashAt(destination, "recovery-lease-published")).toBe(73);
    const highWater = await latestHighWater(parent);
    await expectProcessGone(highWater.pid);
    await moveMarkerToTemporary(highWater.path, highWater.token);
    await expect(
      replaceDirectoryTransaction(destination, () =>
        Promise.reject(new Error("lease temp recovered")),
      ),
    ).rejects.toThrow("lease temp recovered");
    expect(await nonAllocatorArtifacts(parent)).toEqual([]);
    expect(await durableAllocatorArtifacts(parent)).toHaveLength(4);
  }, 20_000);

  it("rejects unsafe retirement temp variants", async () => {
    for (const variant of [
      "hardlink",
      "foreign",
      "malformed",
      "oversize",
      "duplicate",
      "symlink",
    ]) {
      const parent = await temporaryRoot(`skizzles-retirement-${variant}-`);
      const destination = await seededDestination(parent);
      expect(crashAt(destination, "owner-ready")).toBe(73);
      const claim = await currentClaim(parent);
      await expectProcessGone(claim.pid);
      const temporary = await moveMarkerToTemporary(claim.path, claim.token);
      const valid = await fixtureMarker(temporary);
      if (variant === "hardlink") await link(temporary, `${temporary}.link`);
      if (variant === "foreign") {
        await writeFile(
          `${claim.path}.retired.00000000-0000-4000-8000-000000000000.tmp`,
          `${JSON.stringify(valid)}\n`,
          { mode: 0o600 },
        );
      }
      if (variant === "malformed") await writeFile(temporary, "{\n");
      if (variant === "oversize")
        await writeFile(temporary, "x".repeat(20_000));
      if (variant === "duplicate") {
        await writeFile(
          temporary,
          `{"dev":"${valid.dev}","ino":"${valid.ino}","token":"${valid.token}","token":"${valid.token}"}\n`,
        );
      }
      if (variant === "symlink") {
        await unlink(temporary);
        await symlink(claim.path, temporary);
      }
      await expect(
        replaceDirectoryTransaction(destination, () => Promise.resolve()),
      ).rejects.toThrow("locked by another operation");
    }
  }, 20_000);

  it("rejects malformed temps beside canonical and older high-water markers", async () => {
    const parent = await temporaryRoot("skizzles-retirement-conflicts-");
    const destination = await seededDestination(parent);
    expect(crashAt(destination, "owner-ready")).toBe(73);
    const claim = await currentClaim(parent);
    await expectProcessGone(claim.pid);
    await waitForFile(`${claim.path}.retired`);
    await writeFile(`${claim.path}.retired.${claim.token}.tmp`, "{\n", {
      mode: 0o600,
    });
    await expect(
      replaceDirectoryTransaction(destination, () => Promise.resolve()),
    ).rejects.toThrow("locked by another operation");

    const other = await temporaryRoot("skizzles-retirement-old-");
    const otherDestination = await seededDestination(other);
    for (const message of ["generation one", "generation two"]) {
      expect(crashAt(otherDestination, "owner-ready")).toBe(73);
      await expect(
        replaceDirectoryTransaction(otherDestination, () =>
          Promise.reject(new Error(message)),
        ),
      ).rejects.toThrow(message);
    }
    const first = await highWaterAt(other, 1);
    await writeFile(`${first.path}.retired.${first.token}.tmp`, "{\n", {
      mode: 0o600,
    });
    await expect(
      replaceDirectoryTransaction(otherDestination, () => Promise.resolve()),
    ).rejects.toThrow("locked by another operation");
  }, 20_000);

  it("blocks allocation behind an unpublished slow high-water", async () => {
    const parent = await temporaryRoot("skizzles-recovery-highwater-race-");
    const destination = await seededDestination(parent);
    const paused = join(parent, "slow-paused");
    const release = join(parent, "slow-release");
    expect(crashAt(destination, "owner-ready")).toBe(73);
    const slow = spawnRecoveryContender(destination, paused, release);
    await waitForFile(paused, slow);
    let competingConstructionRan = false;
    await expect(
      replaceDirectoryTransaction(destination, () => {
        competingConstructionRan = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow("locked by another operation");
    expect(competingConstructionRan).toBe(false);
    await writeFile(release, "release\n");
    expect(await slow.exited).toBe(0);
    expect(await durableAllocatorArtifacts(parent)).toHaveLength(2);
    expect(crashAt(destination, "owner-ready")).toBe(73);
    await expect(
      replaceDirectoryTransaction(destination, () =>
        Promise.reject(new Error("next generation")),
      ),
    ).rejects.toThrow("next generation");
    expect(await allocatorArtifacts(parent)).toHaveLength(3);
    expect(
      (await claimArtifacts(parent)).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
  }, 20_000);
});

function temporaryRoot(prefix: string): Promise<string> {
  return createTemporaryRoot(prefix, roots);
}
