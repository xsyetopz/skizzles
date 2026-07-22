import { afterEach, describe, expect, test } from "bun:test";
import {
  crashServiceApply,
  createLabServiceFixtureScope,
  join,
  labLockPath,
  syncJournals,
  withFileLock,
  writeFile,
} from "./support.ts";

const fixtures = createLabServiceFixtureScope();
const { provisionedSyncFixture } = fixtures;
afterEach(fixtures.cleanup);

describe("service synchronization recovery", () => {
  it("recovers a crash journal before issuing a new service preview", async () => {
    const fixture = await provisionedSyncFixture(
      "thread-sync-preview-recovery",
    );
    await writeFile(join(fixture.lab.sourceRoot, "tracked.txt"), "changed\n");
    const crashed = await fixture.service.preview(fixture.lab.id, "push");
    await crashServiceApply(fixture.lab, crashed.token);
    expect(
      await Bun.file(join(fixture.lab.workspace, "tracked.txt")).text(),
    ).toBe("changed\n");

    const preview = await fixture.service.preview(fixture.lab.id, "push");

    expect(preview.changes.map((change) => change.path)).toEqual([
      "tracked.txt",
    ]);
    expect(
      await Bun.file(join(fixture.lab.workspace, "tracked.txt")).text(),
    ).toBe("base\n");
    expect(await syncJournals(fixture.lab)).toEqual([]);
  });

  it("recovers a crash journal before consuming an existing service apply token", async () => {
    const fixture = await provisionedSyncFixture("thread-sync-apply-recovery");
    await writeFile(join(fixture.lab.sourceRoot, "tracked.txt"), "changed\n");
    const crashed = await fixture.service.preview(fixture.lab.id, "push");
    const pending = await fixture.service.preview(fixture.lab.id, "push");
    await crashServiceApply(fixture.lab, crashed.token);

    expect(
      await fixture.service.apply(fixture.lab.id, "push", pending.token),
    ).toEqual({ labId: fixture.lab.id, direction: "push", applied: 1 });
    expect(
      await Bun.file(join(fixture.lab.workspace, "tracked.txt")).text(),
    ).toBe("changed\n");
    expect(await syncJournals(fixture.lab)).toEqual([]);
  });

  it("serializes concurrent preview and apply with activity then lab lock ordering", async () => {
    const fixture = await provisionedSyncFixture("thread-sync-lock-order");
    const token = (await fixture.service.preview(fixture.lab.id, "push")).token;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = withFileLock(
      labLockPath(fixture.roots.stateRoot, fixture.owner, fixture.lab.id),
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;
    let previewSettled = false;
    let applySettled = false;
    const preview = fixture.service
      .preview(fixture.lab.id, "push")
      .finally(() => {
        previewSettled = true;
      });
    const apply = fixture.service
      .apply(fixture.lab.id, "push", token)
      .finally(() => {
        applySettled = true;
      });
    try {
      await Bun.sleep(100);
      expect(previewSettled).toBe(false);
      expect(applySettled).toBe(false);
    } finally {
      release.resolve();
    }
    await held;
    await Promise.all([preview, apply]);
  });
});
