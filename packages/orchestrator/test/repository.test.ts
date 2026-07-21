// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import { createHarness, normalize } from "./support.ts";

describe("repository authority", () => {
  it("orders immutable anchors by framework precedence", async () => {
    const { orchestrator } = createHarness();
    const result = await orchestrator.preflight({
      request: normalize(orchestrator),
      repository: { id: "repo-a" },
    });
    if (result.status !== "accepted") {
      throw new Error("fixture rejected");
    }
    expect(
      result.approval.repository.anchors.map((anchor) => anchor.id),
    ).toEqual(["runtime"]);
    expect(result.approval.repository.treeDigest).toStartWith("sha256:");
    expect(result.approval.repository.contextDigest).toStartWith("sha256:");
    expect(Object.isFrozen(result.approval.repository.treeBytes)).toBe(true);
  });

  it("rejects malformed repository identity without throwing", async () => {
    const { orchestrator } = createHarness();
    await expect(
      orchestrator.preflight({
        request: normalize(orchestrator),
        repository: null,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "INVALID_REPOSITORY",
    });
  });
});
