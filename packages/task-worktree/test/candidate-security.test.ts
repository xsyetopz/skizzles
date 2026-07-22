// biome-ignore lint/correctness/noUnresolvedImports: Bun provides its test module at runtime.
import { afterEach, describe, expect, it } from "bun:test";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskWorktreeCommitAuthority } from "../src/commit/contract.ts";
import { createTaskWorktreeCommitAuthority } from "../src/commit/runtime.ts";
import type { TaskWorktreePrepareInput } from "../src/contract.ts";
import {
  digestTaskWorktreeBytes,
  digestTaskWorktreeValue,
} from "../src/contract.ts";
import type { DependencyResolutionService } from "../src/dependency/resolution.ts";
import {
  createDependencyResolutionService,
  createDependencyResolverAuthority,
} from "../src/dependency/resolution.ts";
import type { TaskWorktreeDiffAuthority } from "../src/diff/contract.ts";
import {
  createTaskWorktreeDiffAuthority,
  isTaskWorktreeSplitPlan,
} from "../src/diff/runtime.ts";
import { prepareCandidate } from "../src/lifecycle/candidate.ts";
import {
  createPortableSandboxBroker,
  createSandboxCapabilityAuthority,
  type PortableSandboxBroker,
} from "../src/sandbox/capabilities.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map(
        async (fixture) => await rm(fixture, { force: true, recursive: true }),
      ),
  );
});

describe("candidate exact-path security gateway", () => {
  it("writes an existing file through an authenticated fd and preserves exact bytes", async () => {
    const root = await fixture();
    const path = join(root, "tracked.txt");
    await writeFile(path, "baseline\n");
    const candidate = bytes("candidate\n");
    const input = declaration("tracked.txt", "write", "baseline\n", candidate);
    const observedSandbox: string[][] = [];
    const result = await prepare(root, input, observedSandbox);
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") return;
    expect(await readFile(path, "utf8")).toBe("candidate\n");
    expect(result.candidate.diffReceipt.changes[0]?.candidateDigest).toBe(
      digestTaskWorktreeValue([...candidate]),
    );
    expect(result.candidate.diffInput.candidate[0]?.bytes).toEqual([
      ...candidate,
    ]);
    expect(observedSandbox).toEqual([[".writable-cache"]]);
  });

  it("creates each missing parent one segment at a time for a new write", async () => {
    const root = await fixture();
    const candidate = bytes("new\0bytes");
    const result = await prepare(
      root,
      declaration("a/b/new.bin", "write", null, candidate),
    );
    expect(result.status).toBe("prepared");
    expect(await readFile(join(root, "a/b/new.bin"))).toEqual(
      Buffer.from(candidate),
    );
    expect((await lstat(join(root, "a"))).isDirectory()).toBe(true);
    expect((await lstat(join(root, "a/b"))).isDirectory()).toBe(true);
  });

  it("deletes an existing single-link file only after fd identity and digest checks", async () => {
    const root = await fixture();
    const path = join(root, "remove.txt");
    await writeFile(path, "remove me\n");
    const result = await prepare(
      root,
      declaration("remove.txt", "delete", "remove me\n", null),
    );
    expect(result.status).toBe("prepared");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlink parents and symlink targets before any write or delete", async () => {
    const root = await fixture();
    const outside = await mkdtemp(
      join(tmpdir(), "skizzles-candidate-outside-"),
    );
    fixtures.push(outside);
    await writeFile(join(outside, "target.txt"), "outside\n");
    await symlink(outside, join(root, "linked"));
    const parentResult = await prepare(
      root,
      declaration("linked/new.txt", "write", null, bytes("must not write\n")),
    );
    expect(parentResult.status).not.toBe("prepared");
    expect(await readFile(join(outside, "target.txt"), "utf8")).toBe(
      "outside\n",
    );

    await symlink(join(outside, "target.txt"), join(root, "target.txt"));
    const targetResult = await prepare(
      root,
      declaration("target.txt", "delete", "outside\n", null),
    );
    expect(targetResult.status).not.toBe("prepared");
    expect(await readFile(join(outside, "target.txt"), "utf8")).toBe(
      "outside\n",
    );
  });

  it("rejects hard-linked targets for both writes and deletes", async () => {
    const root = await fixture();
    const original = join(root, "original.txt");
    const linked = join(root, "linked.txt");
    await writeFile(original, "shared\n");
    await link(original, linked);
    const writeResult = await prepare(
      root,
      declaration("linked.txt", "write", "shared\n", bytes("no\n")),
    );
    expect(writeResult.status).not.toBe("prepared");
    expect(await readFile(original, "utf8")).toBe("shared\n");
    const deleteResult = await prepare(
      root,
      declaration("linked.txt", "delete", "shared\n", null),
    );
    expect(deleteResult.status).not.toBe("prepared");
    expect(await readFile(linked, "utf8")).toBe("shared\n");
  });

  it("returns immutable structured dependency intervention diagnostics", async () => {
    const root = await fixture();
    const mismatchDependencies = dependencyService(() => ({
      ecosystem: "npm" as const,
      name: "other",
      requestedRange: "^1.0.0",
      resolvedVersion: "1.0.0",
      registry: "fixture",
    }));
    const result = await prepare(
      root,
      declaration("unused.txt", "write", null, bytes("unused")),
      [],
      mismatchDependencies,
      Object.freeze([
        { ecosystem: "npm", name: "lib", requestedRange: "^1.0.0" },
      ]),
    );
    expect(result.status).toBe("intervention-required");
    if (result.status !== "intervention-required") return;
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      kind: "dependency",
      outcome: "mismatch",
      request: { name: "lib" },
    });
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(Object.isFrozen(result.diagnostics[0])).toBe(true);
  });

  it("returns the authentic complete split plan instead of only its digest", async () => {
    const root = await fixture();
    const first = declaration("first.txt", "write", null, bytes("one\n"));
    const second = declaration("second.txt", "write", null, bytes("two\n"));
    const firstChange = first.changes[0];
    const secondChange = second.changes[0];
    if (firstChange === undefined || secondChange === undefined)
      throw new Error("split fixture missing changes");
    const result = await prepare(
      root,
      Object.freeze({
        ...first,
        changes: Object.freeze([firstChange, secondChange]),
      }),
    );
    expect(result.status).toBe("split-required");
    if (result.status !== "split-required") return;
    expect(isTaskWorktreeSplitPlan(result.plan)).toBe(true);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(result.plan.slices.map(({ paths }) => paths)).toEqual([
      ["first.txt"],
      ["second.txt"],
    ]);
  });
});

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skizzles-candidate-security-"));
  fixtures.push(root);
  await mkdir(join(root, "spec"));
  await writeFile(join(root, "spec/rules.md"), "normative\n");
  return root;
}

function declaration(
  path: string,
  operation: "write" | "delete",
  baseline: string | null,
  candidateBytes: Uint8Array | null,
): TaskWorktreePrepareInput {
  return Object.freeze({
    taskId: "candidate-security",
    taskEpochDigest: digestTaskWorktreeValue("epoch"),
    requestDigest: digestTaskWorktreeValue("request"),
    repositoryId: "repo-a",
    rootIdentity: "root-a",
    treeDigest: digestTaskWorktreeValue("tree"),
    baselineDigest: digestTaskWorktreeValue("baseline"),
    changes: Object.freeze([
      Object.freeze({
        path,
        operation,
        baselineDigest:
          baseline === null
            ? null
            : digestTaskWorktreeBytes(new TextEncoder().encode(baseline)),
        candidateBytes:
          candidateBytes === null ? null : Object.freeze([...candidateBytes]),
      }),
    ]),
  });
}

async function prepare(
  root: string,
  input: TaskWorktreePrepareInput,
  observedSandbox: string[][] = [],
  dependencies: DependencyResolutionService = dependencyService((request) => ({
    ...(request as object),
    resolvedVersion: "1.0.0",
    registry: "fixture",
  })),
  dependencyRequests: readonly unknown[] = Object.freeze([]),
) {
  const diff = createTaskWorktreeDiffAuthority(
    Object.freeze({
      maxChangedFiles: 1,
      maxAddedLines: 100,
      maxDeletedLines: 100,
      maxChangedBytes: 10_000,
    }),
  );
  const commit = createTaskWorktreeCommitAuthority(
    Object.freeze({
      maxSubjectLength: 72,
      ownedPackagePaths: Object.freeze([]),
    }),
  );
  if (diff.status !== "created" || commit.status !== "created")
    throw new Error("authority setup failed");
  return await prepareWithAuthorities(
    root,
    input,
    diff.authority,
    commit.authority,
    sandboxBroker(observedSandbox),
    dependencies,
    dependencyRequests,
  );
}

async function prepareWithAuthorities(
  root: string,
  input: TaskWorktreePrepareInput,
  diffAuthority: TaskWorktreeDiffAuthority,
  commitAuthority: TaskWorktreeCommitAuthority,
  sandbox: PortableSandboxBroker,
  dependencies: DependencyResolutionService,
  dependencyRequests: readonly unknown[],
) {
  return await prepareCandidate({
    root,
    authorityId: "candidate-security-authority",
    declaration: input,
    protectedPaths: Object.freeze({
      policyId: "candidate-security-protection",
      testRoots: Object.freeze([]),
      specificationRoots: Object.freeze(["spec"]),
      authorize: async (request: {
        readonly requestDigestOfThisMaterial: string;
      }) =>
        Object.freeze({
          status: "authorized" as const,
          requestDigest: request.requestDigestOfThisMaterial,
          mode: "implementation" as const,
          authorizedTestPaths: Object.freeze([]),
          authorizationDigest: digestTaskWorktreeValue("authorization"),
        }),
    }),
    verificationProfiles: Object.freeze([]),
    diffAuthority,
    commitAuthority,
    sandbox,
    sandboxWritePaths: Object.freeze([".writable-cache"]),
    dependencies,
    dependencyRequests,
  });
}

function sandboxBroker(observed: string[][]): PortableSandboxBroker {
  const authority = createSandboxCapabilityAuthority(
    Object.freeze({
      id: "candidate-test-sandbox",
      attest: async (paths: readonly string[]) => {
        observed.push([...paths]);
        return Object.freeze({
          mechanism: "seatbelt" as const,
          writePaths: paths,
          deniesUndeclaredWrites: true as const,
          deniesSystemControl: true as const,
          readOnlyWorktree: true as const,
          networkDisabled: true as const,
          boundedProcessTree: true as const,
          evidence: "candidate-security-fixture",
        });
      },
      execute: async () => Object.freeze({}),
    }),
  );
  if (authority.status !== "created")
    throw new Error("sandbox authority setup failed");
  const broker = createPortableSandboxBroker(
    Object.freeze({ authority: authority.authority }),
  );
  if (broker.status !== "created")
    throw new Error("sandbox broker setup failed");
  return broker.broker;
}

function dependencyService(
  resolve: (request: unknown) => unknown,
): DependencyResolutionService {
  const authority = createDependencyResolverAuthority(
    Object.freeze({ id: "candidate-test-registry", resolve }),
  );
  if (authority.status !== "created")
    throw new Error("dependency authority setup failed");
  const service = createDependencyResolutionService(
    Object.freeze({ authority: authority.authority }),
  );
  if (service.status !== "created")
    throw new Error("dependency service setup failed");
  return service.service;
}
