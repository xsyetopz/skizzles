import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  WorkspaceFinding,
  WorkspacePackage,
} from "../../src/workspace/contract.ts";
import { parseSourceDependencies } from "../../src/workspace/source/parser.ts";
import {
  TEMPORARY_OWNERSHIP_DISPOSITIONS,
  type TemporaryOwnershipUse,
  validateTemporaryOwnership,
} from "../../src/workspace/source/temporary.ts";

describe("temporary ownership dispositions", () => {
  it("keeps every exception exact, documented, unique, and visible", () => {
    const paths = TEMPORARY_OWNERSHIP_DISPOSITIONS.map(({ path }) => path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.every((path) => path.startsWith("packages/"))).toBeTrue();
    expect(paths.every((path) => !path.includes("*"))).toBeTrue();
    expect(
      TEMPORARY_OWNERSHIP_DISPOSITIONS.every(
        ({ reason }) => reason.trim().length > 0,
      ),
    ).toBeTrue();
    expect(
      TEMPORARY_OWNERSHIP_DISPOSITIONS.filter(
        ({ allowedUses }) => allowedUses.length > 0,
      ).map(({ path }) => path),
    ).toEqual([
      "packages/scratchspace/src/process/platform.ts",
      "packages/container-lab/src/state/layout.ts",
      "packages/command-observation/src/codex-command/settings.ts",
      "packages/installer/src/prompt-policy/lock.ts",
    ]);
  });

  it("allows only the declared primitive on each exact owner", () => {
    for (const disposition of TEMPORARY_OWNERSHIP_DISPOSITIONS) {
      const findings: WorkspaceFinding[] = [];
      validateAtPath(
        disposition.path,
        disposition.allowedUses.map((kind) => ({ kind })),
        findings,
      );
      expect(findings).toEqual([]);
    }
  });

  it("does not let an exact path authorize another primitive or adjacent file", () => {
    const exactFindings: WorkspaceFinding[] = [];
    validateAtPath(
      "packages/container-lab/src/state/layout.ts",
      [{ kind: "mkdtemp" }],
      exactFindings,
    );
    expect(exactFindings).toHaveLength(1);

    const adjacentFindings: WorkspaceFinding[] = [];
    validateAtPath(
      "packages/scratchspace/src/adjacent.ts",
      [{ kind: "tmpdir" }],
      adjacentFindings,
    );
    expect(adjacentFindings).toHaveLength(1);
  });

  it("matches every exact disposition to the real authored source", async () => {
    const repositoryRoot = resolve(import.meta.dir, "../../../..");
    for (const disposition of TEMPORARY_OWNERSHIP_DISPOSITIONS) {
      const path = resolve(repositoryRoot, disposition.path);
      const source = await readFile(path);
      const [parsed] = await parseSourceDependencies([
        { path, source, loader: "ts" },
      ]);
      expect(parsed?.error).toBeUndefined();
      expect(parsed?.temporaryOwnership?.map(({ kind }) => kind) ?? []).toEqual(
        [...disposition.allowedUses].sort((left, right) =>
          left.localeCompare(right),
        ),
      );
    }
  });
});

function validateAtPath(
  path: string,
  uses: readonly TemporaryOwnershipUse[],
  findings: WorkspaceFinding[],
): void {
  const segments = path.split("/");
  const packageRoot = segments.slice(0, 2).join("/");
  const relativePath = segments.slice(2).join("/");
  const item: WorkspacePackage = {
    root: packageRoot,
    relativeRoot: packageRoot,
    manifest: {
      name: `@fixture/${segments[1] ?? "package"}`,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {},
      dependencies: {},
      devDependencies: {},
      optionalDependencies: {},
      peerDependencies: {},
      exports: {},
      bin: {},
    },
  };
  validateTemporaryOwnership(item, relativePath, uses, findings);
}
