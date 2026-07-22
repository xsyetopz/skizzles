// biome-ignore lint/correctness/noUnresolvedImports: Bun provides its test module at runtime.
import { describe, expect, it } from "bun:test";
import {
  createCandidateMutationGateway,
  createPathInspectionAuthority,
} from "../src/policy/path-scope.ts";

function authority(inspect: (path: string) => unknown) {
  const result = createPathInspectionAuthority({ id: "lstat-v1", inspect });
  if (result.status !== "created") throw new Error("test authority rejected");
  return result.authority;
}

describe("candidate mutation path scope", () => {
  it("authorizes immutable write and delete receipts for exact declared targets", async () => {
    const created = createCandidateMutationGateway({
      targets: [
        { path: "src/new.ts", operation: "write" },
        { path: "src/old.ts", operation: "delete" },
      ],
      pathAuthority: authority((path) => ({
        requestedPath: path,
        resolvedPath: path,
        symlinkEncountered: false,
      })),
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    const bytes = [1, 2, 3];
    const write = await created.gateway.authorize({
      path: "src/new.ts",
      operation: "write",
      candidateBytes: bytes,
    });
    bytes[0] = 9;
    expect(write.status).toBe("authorized");
    if (write.status === "authorized") {
      expect(Object.isFrozen(write.receipt)).toBe(true);
      expect(write.receipt.candidateDigest).toHaveLength(64);
    }
    expect(
      (
        await created.gateway.authorize({
          path: "src/old.ts",
          operation: "delete",
        })
      ).status,
    ).toBe("authorized");
  });

  it("rejects traversal, absolute, backslash, and undeclared paths", async () => {
    const created = createCandidateMutationGateway({
      targets: [{ path: "src/a.ts", operation: "write" }],
      pathAuthority: authority((path) => ({
        requestedPath: path,
        resolvedPath: path,
        symlinkEncountered: false,
      })),
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    for (const path of [
      "../src/a.ts",
      "/tmp/a.ts",
      "src\\a.ts",
      "src/b.ts",
      ".git/config",
      "nested/.GIT/config",
    ]) {
      expect(
        (
          await created.gateway.authorize({
            path,
            operation: "write",
            candidateBytes: [],
          })
        ).status,
      ).toBe("rejected");
    }
    expect(
      (
        await created.gateway.authorize({
          path: "src/a.ts",
          operation: "delete",
        })
      ).status,
    ).toBe("rejected");
  });

  it("rejects case-folded and Unicode normalization target aliases", () => {
    expect(
      createCandidateMutationGateway({
        targets: [
          { path: "src/A.ts", operation: "write" },
          { path: "src/a.ts", operation: "write" },
        ],
        pathAuthority: authority((path) => ({
          requestedPath: path,
          resolvedPath: path,
          symlinkEncountered: false,
        })),
      }).status,
    ).toBe("rejected");
    expect(
      createCandidateMutationGateway({
        targets: [
          { path: "src/caf\u00e9.ts", operation: "write" },
          { path: "src/cafe\u0301.ts", operation: "write" },
        ],
        pathAuthority: authority((path) => ({
          requestedPath: path,
          resolvedPath: path,
          symlinkEncountered: false,
        })),
      }).status,
    ).toBe("rejected");
  });

  it("rejects symlink-shaped and redirected target inspections", async () => {
    for (const inspect of [
      (path: string) => ({
        requestedPath: path,
        resolvedPath: path,
        symlinkEncountered: true,
      }),
      (path: string) => ({
        requestedPath: path,
        resolvedPath: "outside/a.ts",
        symlinkEncountered: false,
      }),
    ]) {
      const created = createCandidateMutationGateway({
        targets: [{ path: "src/a.ts", operation: "write" }],
        pathAuthority: authority(inspect),
      });
      if (created.status !== "created") throw new Error("gateway rejected");
      expect(
        await created.gateway.authorize({
          path: "src/a.ts",
          operation: "write",
          candidateBytes: [],
        }),
      ).toEqual({ status: "rejected", code: "PATH_REDIRECTION_REJECTED" });
    }
  });

  it("rejects forged, proxy, and accessor authorities", () => {
    expect(
      createCandidateMutationGateway({
        targets: [{ path: "src/a.ts", operation: "write" }],
        pathAuthority: { id: "forged" },
      }).status,
    ).toBe("rejected");
    expect(
      createPathInspectionAuthority(
        new Proxy({ id: "x", inspect: () => ({}) }, {}),
      ).status,
    ).toBe("rejected");
    const accessor = Object.defineProperty({ id: "x" }, "inspect", {
      get: () => () => ({}),
    });
    expect(createPathInspectionAuthority(accessor).status).toBe("rejected");
    expect(
      createPathInspectionAuthority({
        id: "x",
        inspect: () => ({}),
        success: true,
      }).status,
    ).toBe("rejected");
  });
});
