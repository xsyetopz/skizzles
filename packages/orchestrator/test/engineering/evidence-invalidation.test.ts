// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { afterEach, describe, expect, it } from "bun:test";
import {
  createFixture,
  prepareSourceFixture,
  type SourceFixture,
  targetPath,
} from "./source/fixture.ts";

const fixtures: SourceFixture[] = [];
const timeoutMilliseconds = 30_000;

afterEach(() => {
  for (const activeFixture of fixtures.splice(0)) {
    activeFixture.cleanup();
  }
});

async function fixture(
  options: Parameters<typeof createFixture>[0] = {},
): Promise<SourceFixture> {
  const created = await createFixture(options);
  fixtures.push(created);
  return created;
}

describe("real engineering candidate evidence invalidation", () => {
  it(
    "rejects hostile candidate drift after approval is awaited and before publication",
    async () => {
      const preparedFixture = await fixture();
      const prepared = await prepareSourceFixture(preparedFixture);
      if (prepared.status !== "awaiting-approval") {
        throw new Error(`prepare failed: ${prepared.code}`);
      }

      preparedFixture.taskFixture.mutateCandidate(targetPath);
      const promotion = await preparedFixture.workflow.approveAndPromote({
        review: prepared.review,
        token: "approve",
      });
      if (promotion.status !== "cleanup-pending") {
        throw new Error(`expected drift cleanup, received ${promotion.status}`);
      }
      expect(promotion).toMatchObject({
        code: "CLEANUP_FAILED",
        cleanup: {
          complete: false,
          targetReleased: false,
          taskWorktreeCleanup: "pending",
        },
      });
      expect(
        preparedFixture.destination.currentText(targetPath),
      ).toBeUndefined();

      preparedFixture.taskFixture.restoreCandidate(targetPath);
      await expect(
        preparedFixture.workflow.retryCleanup({ handle: promotion.handle }),
      ).resolves.toMatchObject({
        status: "cleaned",
        cleanup: { complete: true, targetReleased: true },
        publication: null,
      });
      expect(
        preparedFixture.destination.currentText(targetPath),
      ).toBeUndefined();
    },
    timeoutMilliseconds,
  );
});

describe("real engineering negative-test evidence invalidation", () => {
  it(
    "rejects a configured negative-test profile with omitted source evidence",
    async () => {
      const preparedFixture = await fixture({ negativeTestProfile: true });

      await expect(
        prepareSourceFixture(preparedFixture),
      ).resolves.toMatchObject({
        status: "rejected",
        code: "ENGINEERING_EVIDENCE_REJECTED",
        cleanup: { complete: true, targetReleased: true },
      });
      expect(
        preparedFixture.destination.currentText(targetPath),
      ).toBeUndefined();
    },
    timeoutMilliseconds,
  );
});
