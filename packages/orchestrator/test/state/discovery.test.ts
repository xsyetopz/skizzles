import { describe, expect, it } from "bun:test";
import { createHarness, repositoryContext } from "../facade/support.ts";

function scanResult(
  input: Readonly<Record<string, unknown>>,
  entries: readonly unknown[],
  complete = true,
): Readonly<Record<string, unknown>> {
  return {
    repositoryId: input["repositoryId"],
    requestDigest: input["requestDigest"],
    treeDigest: input["treeDigest"],
    root: input["root"],
    entries,
    skippedSymlinks: [],
    complete,
    stoppedBy: complete ? null : "files",
  };
}

describe("bounded repository discovery", () => {
  it("returns explicit complete and incomplete snapshots", async () => {
    for (const complete of [true, false]) {
      const { orchestrator } = createHarness({
        discoveryScan(input) {
          return scanResult(
            input,
            [{ path: `${input.root}/index.ts`, kind: "file", bytes: 1 }],
            complete,
          );
        },
      });
      const context = await repositoryContext(orchestrator);
      const result = await orchestrator.discover({
        ...context,
        root: "packages/orchestrator",
      });
      if (result.status !== "accepted") throw new Error("scan rejected");
      expect(result.discovery.complete).toBe(complete);
      expect(result.discovery.stoppedBy).toBe(complete ? null : "files");
    }
  });

  it("rejects excluded entries and any traversal through a reported symlink", async () => {
    const excluded = createHarness({
      discoveryScan(input) {
        return scanResult(input, [
          {
            path: "packages/orchestrator/node_modules/pkg/index.js",
            kind: "file",
            bytes: 1,
          },
        ]);
      },
    });
    const context = await repositoryContext(excluded.orchestrator);
    await expect(
      excluded.orchestrator.discover({
        ...context,
        root: "packages/orchestrator",
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "DISCOVERY_AUTHORITY_REJECTED",
    });

    const symlink = createHarness({
      discoveryScan(input) {
        return {
          ...scanResult(input, [
            {
              path: `${input.root}/linked/foreign.ts`,
              kind: "file",
              bytes: 1,
            },
          ]),
          skippedSymlinks: [`${input.root}/linked`],
        };
      },
    });
    const symlinkContext = await repositoryContext(symlink.orchestrator);
    await expect(
      symlink.orchestrator.discover({
        ...symlinkContext,
        root: "packages/orchestrator",
      }),
    ).resolves.toMatchObject({ status: "rejected" });
  });

  it("enforces file, byte, depth, and elapsed-time bounds", async () => {
    const fixtures = [
      Array.from({ length: 101 }, (_, index) => ({
        path: `packages/orchestrator/file-${index}.ts`,
        kind: "file",
        bytes: 1,
      })),
      [
        {
          path: "packages/orchestrator/huge.bin",
          kind: "file",
          bytes: 100_001,
        },
      ],
      [
        {
          path: `packages/orchestrator/${Array.from(
            { length: 9 },
            () => "d",
          ).join("/")}/x.ts`,
          kind: "file",
          bytes: 1,
        },
      ],
    ];
    for (const entries of fixtures) {
      const { orchestrator } = createHarness({
        discoveryScan(input) {
          return scanResult(input, entries);
        },
      });
      const context = await repositoryContext(orchestrator);
      await expect(
        orchestrator.discover({ ...context, root: "packages/orchestrator" }),
      ).resolves.toMatchObject({ status: "rejected" });
    }

    let advance: ((value: number) => void) | undefined;
    const timed = createHarness({
      discoveryScan(input) {
        advance?.(101);
        return scanResult(input, []);
      },
    });
    advance = timed.clock.advance;
    const timedContext = await repositoryContext(timed.orchestrator);
    await expect(
      timed.orchestrator.discover({
        ...timedContext,
        root: "packages/orchestrator",
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "DISCOVERY_LIMIT_EXCEEDED",
    });
  });

  it("requires reviewed bounded expansion and rejects out-of-scope roots", async () => {
    const { orchestrator, counts } = createHarness();
    const context = await repositoryContext(orchestrator);
    const initial = await orchestrator.discover({
      ...context,
      root: "packages/orchestrator",
    });
    if (initial.status !== "accepted") throw new Error("scan rejected");
    const first = await orchestrator.expandDiscovery({
      discovery: initial.discovery,
      root: "packages",
    });
    if (first.status !== "accepted") throw new Error("expansion rejected");
    const second = await orchestrator.expandDiscovery({
      discovery: first.discovery,
      root: "packages",
    });
    if (second.status !== "accepted") throw new Error("expansion rejected");
    await expect(
      orchestrator.expandDiscovery({
        discovery: second.discovery,
        root: "packages",
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "DISCOVERY_EXPANSION_REJECTED",
    });
    expect(counts.expansion).toBe(2);
    await expect(
      orchestrator.discover({ ...context, root: "plugins" }),
    ).resolves.toEqual({
      status: "rejected",
      code: "DISCOVERY_OUT_OF_SCOPE",
    });
  });
});
