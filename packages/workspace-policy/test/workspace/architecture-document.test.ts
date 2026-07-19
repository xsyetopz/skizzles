// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EDGE_BLOCK_END,
  EDGE_BLOCK_START,
  validateWorkspaceArchitecture,
  validateWorkspaceArchitectureDocument,
  workspaceDependencyEdges,
} from "../../src/workspace/architecture-document.ts";
import type {
  PackageManifest,
  WorkspaceFinding,
  WorkspaceManifest,
  WorkspacePackage,
} from "../../src/workspace/contract.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("workspace architecture dependency contract", () => {
  it("derives sorted unique edges from every manifest dependency map", () => {
    const { packages, rootManifest } = topology();

    expect(workspaceDependencyEdges(rootManifest, packages)).toEqual([
      "@skizzles/one -> @skizzles/three",
      "@skizzles/one -> @skizzles/two",
      "@skizzles/two -> @skizzles/three",
      "skizzles -> @skizzles/three",
    ]);
  });

  it("accepts one exact marked text fence without parsing surrounding prose", () => {
    const { packages, rootManifest } = topology();
    const findings: WorkspaceFinding[] = [];
    const edges = workspaceDependencyEdges(rootManifest, packages);

    validateWorkspaceArchitectureDocument(
      `# Architecture\n\nArbitrary prose is outside the contract.\n\n${edgeDocument(edges)}\nTrailing prose remains outside it.\n`,
      rootManifest,
      packages,
      findings,
    );

    expect(findings).toEqual([]);
  });

  it.each([
    [
      "missing",
      (edges: readonly string[]): readonly string[] => edges.slice(1),
    ],
    [
      "extra",
      (edges: readonly string[]): readonly string[] =>
        [...edges, "@skizzles/three -> @skizzles/one"].toSorted(),
    ],
    [
      "changed",
      (edges: readonly string[]): readonly string[] => [
        ...edges.slice(0, -1),
        "skizzles -> @skizzles/two",
      ],
    ],
  ])("rejects %s manifest-edge drift", (_, mutate) => {
    const { packages, rootManifest } = topology();
    const findings: WorkspaceFinding[] = [];
    const documented = mutate(workspaceDependencyEdges(rootManifest, packages));

    validateWorkspaceArchitectureDocument(
      edgeDocument(documented),
      rootManifest,
      packages,
      findings,
    );

    expect(findings).toEqual([
      {
        code: "workspace-architecture-dependency-drift",
        path: "docs/workspace-architecture.md",
        message:
          "documented dependency edges must exactly match workspace manifests",
      },
    ]);
  });

  it.each([
    ["missing markers", "```text\n@skizzles/one -> @skizzles/two\n```"],
    [
      "wrong fence",
      `${EDGE_BLOCK_START}\n\`\`\`json\n@skizzles/one -> @skizzles/two\n\`\`\`\n${EDGE_BLOCK_END}`,
    ],
    [
      "unsorted edges",
      edgeDocument([
        "@skizzles/two -> @skizzles/three",
        "@skizzles/one -> @skizzles/two",
      ]),
    ],
    [
      "duplicate edges",
      edgeDocument([
        "@skizzles/one -> @skizzles/two",
        "@skizzles/one -> @skizzles/two",
      ]),
    ],
    [
      "duplicate marker blocks",
      `${edgeDocument(["@skizzles/one -> @skizzles/two"])}\n${edgeDocument(["@skizzles/one -> @skizzles/two"])}`,
    ],
  ])("rejects a malformed contract with %s", (_, document) => {
    const { packages, rootManifest } = topology();
    const findings: WorkspaceFinding[] = [];

    validateWorkspaceArchitectureDocument(
      document,
      rootManifest,
      packages,
      findings,
    );

    expect(findings).toEqual([
      {
        code: "workspace-architecture-contract",
        path: "docs/workspace-architecture.md",
        message:
          "dependency edges must use one marked text fence with sorted unique package edges",
      },
    ]);
  });

  it("rejects a missing architecture document in expected-topology mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "skizzles-architecture-doc-"));
    roots.push(root);
    const { packages, rootManifest } = topology();
    const findings: WorkspaceFinding[] = [];

    await validateWorkspaceArchitecture(root, rootManifest, packages, findings);

    expect(findings.map(({ code }) => code)).toEqual([
      "workspace-architecture-contract",
    ]);
  });
});

function edgeDocument(edges: readonly string[]): string {
  return `${EDGE_BLOCK_START}\n\`\`\`text\n${edges.join("\n")}\n\`\`\`\n${EDGE_BLOCK_END}`;
}

function topology(): {
  rootManifest: WorkspaceManifest;
  packages: WorkspacePackage[];
} {
  const one = manifest("@skizzles/one");
  one.dependencies["@skizzles/two"] = "workspace:*";
  one.devDependencies["@skizzles/three"] = "workspace:*";
  const two = manifest("@skizzles/two");
  two.optionalDependencies["@skizzles/three"] = "workspace:*";
  const three = manifest("@skizzles/three");
  const rootManifest: WorkspaceManifest = {
    ...manifest("skizzles"),
    workspaces: ["packages/*"],
  };
  rootManifest.devDependencies["@skizzles/three"] = "workspace:*";
  return {
    rootManifest,
    packages: [one, two, three].map((packageManifest, index) => ({
      root: `/workspace/packages/${index}`,
      relativeRoot: `packages/${index}`,
      manifest: packageManifest,
    })),
  };
}

function manifest(name: string): PackageManifest {
  return {
    name,
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
  };
}
