// biome-ignore lint/correctness/noUnresolvedImports: Biome does not resolve Bun built-in modules.
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { PhysicalCandidateTarget } from "../../src/lab/physical/contract.ts";
import {
  candidateDigestOf,
  digestValue,
  parseCandidateTargets,
  targetSetDigestOf,
} from "../../src/lab/physical/input.ts";
import { synchronizeCandidateWorkspace } from "../../src/lab/physical/workspace.ts";
import { writeLab } from "../../src/state/lab/store.ts";
import { createLabServiceFixtureScope } from "./support.ts";

const fixtures = createLabServiceFixtureScope();
const digest = `sha256:${"a".repeat(64)}`;

afterEach(fixtures.cleanup);

describe("physical candidate workspace", () => {
  it("accepts only exact immutable sorted candidate target bytes", () => {
    const first = target("src/a.ts", "export const a = 1;\n");
    const second = target("src/b.ts", "export const b = 2;\n");
    expect(parseCandidateTargets(Object.freeze([first, second]))).toEqual([
      first,
      second,
    ]);
    expect(parseCandidateTargets([first, second])).toBeUndefined();
    expect(
      parseCandidateTargets(Object.freeze([second, first])),
    ).toBeUndefined();
    expect(
      parseCandidateTargets(
        Object.freeze([Object.freeze({ ...first, path: "../escape.ts" })]),
      ),
    ).toBeUndefined();
    expect(
      parseCandidateTargets(
        Object.freeze([Object.freeze({ ...first, bytes: [...first.bytes] })]),
      ),
    ).toBeUndefined();
    expect(
      parseCandidateTargets(
        new Proxy(Object.freeze([first]), {
          get() {
            throw new Error("hostile target array");
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("publishes and then measures exact candidate bytes in the authentic lab workspace", async () => {
    const fixture = await readyFixture();
    const targets = Object.freeze([
      target("src/a.ts", "export const a = 1;\n"),
      target("src/nested/b.ts", "export const b = 2;\n"),
    ]);

    const evidence = await synchronizeCandidateWorkspace(
      workspaceInput(fixture, targets),
    );

    expect(
      await readFile(join(fixture.lab.workspace, "src/a.ts"), "utf8"),
    ).toBe("export const a = 1;\n");
    expect(
      await readFile(join(fixture.lab.workspace, "src/nested/b.ts"), "utf8"),
    ).toBe("export const b = 2;\n");
    expect(evidence.targets).toEqual(
      targets.map(({ path, digest: targetDigest, byteLength }) => ({
        path,
        digest: targetDigest,
        byteLength,
      })),
    );
    expect(evidence.candidateDigest).toBe(candidateDigestOf(evidence.targets));
    expect(evidence.targetSetDigest).toBe(targetSetDigestOf(evidence.targets));
    expect(evidence.workspaceIdentityDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(evidence.provenanceMeasurementDigest).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );
    expect(evidence.provenanceMeasurementDigest).not.toBe(digest);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.targets)).toBe(true);
  });

  it("rejects stale or unrelated lab identities", async () => {
    const fixture = await readyFixture();
    const input = workspaceInput(
      fixture,
      Object.freeze([target("src/a.ts", "export {};\n")]),
    );

    await expect(
      synchronizeCandidateWorkspace({ ...input, ownerKey: "other-owner" }),
    ).rejects.toThrow("identity changed");
    await expect(
      synchronizeCandidateWorkspace({
        ...input,
        labUpdatedAt: new Date(1).toISOString(),
      }),
    ).rejects.toThrow("identity changed");

    await rm(fixture.lab.workspace, { recursive: true });
    await symlink(fixture.lab.sourceRoot, fixture.lab.workspace, "dir");
    await expect(synchronizeCandidateWorkspace(input)).rejects.toThrow(
      "authentic directory",
    );
  });

  it("rejects path traversal and symlinked parents", async () => {
    const fixture = await readyFixture();
    await expect(
      synchronizeCandidateWorkspace(
        workspaceInput(
          fixture,
          Object.freeze([target("../escape.ts", "export {};\n")]),
        ),
      ),
    ).rejects.toThrow("escapes workspace");

    await symlink(
      fixture.lab.sourceRoot,
      join(fixture.lab.workspace, "linked"),
    );
    await expect(
      synchronizeCandidateWorkspace(
        workspaceInput(
          fixture,
          Object.freeze([target("linked/escape.ts", "export {};\n")]),
        ),
      ),
    ).rejects.toThrow("not a real directory");
  });

  it("rejects byte and digest drift after physical publication", async () => {
    const fixture = await readyFixture();
    const valid = target("src/a.ts", "export {};\n");
    const drifted = Object.freeze({ ...valid, digest: digestValue("wrong") });

    await expect(
      synchronizeCandidateWorkspace(
        workspaceInput(fixture, Object.freeze([drifted])),
      ),
    ).rejects.toThrow("drifted");
  });
});

async function readyFixture() {
  const fixture = await fixtures.durableFixture("owner", "ready", true);
  fixture.lab.sourceRepositoryIdentity = "a".repeat(64);
  await writeLab(fixture.roots, fixture.lab);
  return fixture;
}

function target(path: string, text: string): PhysicalCandidateTarget {
  const bytes = Object.freeze([...new TextEncoder().encode(text)]);
  return Object.freeze({
    path,
    digest: `sha256:${createHash("sha256")
      .update(Uint8Array.from(bytes))
      .digest("hex")}`,
    byteLength: bytes.length,
    bytes,
  });
}

function workspaceInput(
  fixture: Awaited<ReturnType<typeof readyFixture>>,
  targets: readonly PhysicalCandidateTarget[],
) {
  return {
    roots: fixture.roots,
    owner: fixture.owner,
    labId: fixture.lab.id,
    ownerKey: fixture.lab.ownerKey,
    composeProject: fixture.lab.composeProject,
    sourceRepositoryIdentity: fixture.lab.sourceRepositoryIdentity ?? "",
    labUpdatedAt: fixture.lab.updatedAt,
    declarationDigest: digestValue("declaration"),
    manifestDigest: digestValue("manifest"),
    profileDigest: digestValue("profile"),
    provenanceDigest: digest,
    targets,
  };
}
