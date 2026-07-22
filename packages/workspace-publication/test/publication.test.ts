import { describe, expect, it } from "bun:test";
import {
  type CrashStep,
  createLocalRepositoryLeaseAuthority,
  createWorkspaceTransaction,
  type ExpectedSnapshot,
} from "../src/index.ts";
import {
  ApprovalFixture,
  digest,
  IsolatedDestinationFixture,
  recoveryRequest,
  writeRequest,
} from "./support.ts";

function harness(
  destination = new IsolatedDestinationFixture(),
  approval = new ApprovalFixture(),
  crashStep?: CrashStep,
) {
  const leases = createLocalRepositoryLeaseAuthority([
    { repositoryId: "repo-1", rootIdentity: "root-1", ownerId: "worker-1" },
    { repositoryId: "repo-1", rootIdentity: "root-1", ownerId: "indexer-1" },
  ]);
  const transaction = createWorkspaceTransaction({
    destination,
    approvals: approval,
    leases,
    ...(crashStep === undefined
      ? {}
      : {
          crashInjection: {
            async checkpoint(input: { step: CrashStep }) {
              return input.step === crashStep;
            },
          },
        }),
  });
  return { destination, approval, leases, transaction };
}

describe("workspace publication", () => {
  it("uses locale-independent canonical ordering for non-ASCII paths", async () => {
    const publishFixture = async (paths: readonly string[]) => {
      const destination = new IsolatedDestinationFixture();
      const approval = new ApprovalFixture();
      const transaction = createWorkspaceTransaction({
        destination,
        approvals: approval,
        leases: createLocalRepositoryLeaseAuthority([
          {
            repositoryId: "repo-1",
            rootIdentity: "root-1",
            ownerId: "worker-1",
          },
        ]),
      });
      const result = await transaction.publish({
        version: 1,
        repositoryId: "repo-1",
        rootIdentity: "root-1",
        ownerId: "worker-1",
        approvalReference: "approval-unicode-order",
        targets: paths.map((path) => ({
          path,
          operation: "write",
          expected: { state: "missing" },
          candidateBytes: [...new TextEncoder().encode(path.normalize("NFC"))],
        })),
      });
      if (!result.ok || approval.bindings === undefined) {
        throw new Error("Unicode ordering fixture did not publish");
      }
      return { destination, result, bindings: approval.bindings };
    };

    const decomposed = await publishFixture([
      "src/中.ts",
      "src/e\u0301.ts",
      "src/ä.ts",
    ]);
    const canonical = await publishFixture([
      "src/ä.ts",
      "src/é.ts",
      "src/中.ts",
    ]);

    expect(decomposed.bindings.requestDigest).toBe(
      canonical.bindings.requestDigest,
    );
    expect(decomposed.bindings.targetSetDigest).toBe(
      canonical.bindings.targetSetDigest,
    );
    expect(decomposed.bindings.baselineDigest).toBe(
      canonical.bindings.baselineDigest,
    );
    expect(decomposed.result.transactionId).toBe(
      canonical.result.transactionId,
    );
    expect(decomposed.destination.files.has("src/e\u0301.ts")).toBe(false);
    expect(decomposed.destination.files.has("src/é.ts")).toBe(true);
  });

  it("publishes writes and deletions through owned siblings", async () => {
    const fixture = new IsolatedDestinationFixture();
    const oldWrite = fixture.setFile("src/write.ts", "old-write");
    const oldDelete = fixture.setFile("src/delete.ts", "old-delete");
    const { transaction } = harness(fixture);
    const result = await transaction.publish({
      version: 1,
      repositoryId: "repo-1",
      rootIdentity: "root-1",
      ownerId: "worker-1",
      approvalReference: "approval-ref-1",
      targets: [
        {
          path: "src/write.ts",
          operation: "write",
          expected: oldWrite,
          candidateBytes: [...new TextEncoder().encode("new-write")],
        },
        { path: "src/delete.ts", operation: "delete", expected: oldDelete },
      ],
    });

    expect(result.ok).toBe(true);
    expect(fixture.currentText("src/write.ts")).toBe("new-write");
    expect(fixture.currentText("src/delete.ts")).toBeUndefined();
    expect(fixture.renameCount).toBe(2);
    expect(fixture.siblings.size).toBe(0);
    expect(await fixture.readJournal()).toBeUndefined();
  });

  it("normalizes targets before rejecting duplicates and escapes", async () => {
    const { destination, transaction } = harness();
    const missing: ExpectedSnapshot = { state: "missing" };
    const duplicate = await transaction.publish({
      ...writeRequest(missing, "src//file.ts"),
      targets: [
        {
          path: "src//file.ts",
          operation: "write",
          expected: missing,
          candidateBytes: [1],
        },
        {
          path: "src/file.ts",
          operation: "write",
          expected: missing,
          candidateBytes: [2],
        },
      ],
    });
    expect(duplicate).toMatchObject({ ok: false, code: "DUPLICATE_TARGET" });

    for (const path of [
      "../escape",
      "/absolute",
      "C:/drive",
      "src\\windows",
    ] as const) {
      const escaped = await transaction.publish(writeRequest(missing, path));
      expect(escaped).toMatchObject({ ok: false, code: "PATH_ESCAPE" });
    }
    expect(destination.captureCount).toBe(0);
  });

  it("performs zero renames when a target drifts before publication", async () => {
    const fixture = new IsolatedDestinationFixture();
    const baseline = fixture.setFile("src/file.ts", "old");
    fixture.onInspect = (current) => {
      if (current.inspectCount === 2) {
        current.setFile("src/file.ts", "manual-change");
      }
    };
    const { transaction } = harness(fixture);
    const result = await transaction.publish(writeRequest(baseline));

    expect(result).toMatchObject({ ok: false, code: "TARGET_DRIFT" });
    expect(fixture.renameCount).toBe(0);
    expect(fixture.currentText("src/file.ts")).toBe("manual-change");
  });

  it("rejects symlinks, hardlinks, and cross-device targets", async () => {
    const cases = [
      {
        kind: "symlink" as const,
        linkCount: 1,
        deviceId: "device-1",
        code: "SYMLINK_REJECTED",
      },
      {
        kind: "file" as const,
        linkCount: 2,
        deviceId: "device-1",
        code: "HARDLINK_REJECTED",
      },
      {
        kind: "file" as const,
        linkCount: 1,
        deviceId: "device-2",
        code: "CROSS_DEVICE",
      },
    ];
    for (const entry of cases) {
      const fixture = new IsolatedDestinationFixture();
      if (entry.kind === "symlink") {
        fixture.setUnsafe("src/file.ts", "symlink", entry.deviceId);
      } else {
        fixture.setFile("src/file.ts", "old", entry);
      }
      const identity = fixture.files.get("src/file.ts")?.identity;
      if (identity === undefined) {
        throw new Error("fixture identity missing");
      }
      const baseline: ExpectedSnapshot = {
        state: "file" as const,
        identity,
        deviceId: entry.deviceId,
        byteLength: 3,
        contentDigest: digest("old"),
        linkCount: 1,
      };
      const { transaction } = harness(fixture);
      const result = await transaction.publish(writeRequest(baseline));
      expect(result).toMatchObject({ ok: false, code: entry.code });
      expect(fixture.renameCount).toBe(0);
    }
  });

  it("fails closed on an authority approval binding mismatch", async () => {
    const approval = new ApprovalFixture();
    approval.mismatch = true;
    const { transaction } = harness(new IsolatedDestinationFixture(), approval);
    const result = await transaction.publish(
      writeRequest({ state: "missing" }),
    );
    expect(result).toMatchObject({
      ok: false,
      code: "APPROVAL_BINDING_MISMATCH",
    });
  });

  it("rejects consumed approval replay after old-state recovery", async () => {
    const fixture = new IsolatedDestinationFixture();
    const approval = new ApprovalFixture();
    const { transaction } = harness(fixture, approval, "journal-preparing");
    const crashed = await transaction.publish(
      writeRequest({ state: "missing" }),
    );
    expect(crashed).toMatchObject({ ok: false, code: "CRASH_INJECTED" });
    if (crashed.ok || crashed.evidence?.transactionId === undefined) {
      throw new Error("expected transaction identity evidence");
    }
    const recoveryHarness = harness(fixture, approval);
    expect(
      await recoveryHarness.transaction.recover(
        recoveryRequest(approval, crashed.evidence.transactionId),
      ),
    ).toMatchObject({
      ok: true,
      status: "recovered-old",
    });
    expect(
      await recoveryHarness.transaction.publish(
        writeRequest({ state: "missing" }),
      ),
    ).toMatchObject({
      ok: false,
      code: "APPROVAL_REPLAYED",
    });
  });
});

describe("repository lease exclusion", () => {
  it("returns BUSY for concurrent publishers", async () => {
    const { leases, transaction } = harness();
    const held = await leases.acquirePublication({
      repositoryId: "repo-1",
      rootIdentity: "root-1",
      ownerId: "worker-1",
    });
    expect(held.status).toBe("acquired");
    expect(
      await transaction.publish(writeRequest({ state: "missing" })),
    ).toMatchObject({ ok: false, code: "BUSY" });
    if (held.status === "acquired") {
      await held.lease.release();
    }
  });

  it("publication excludes active indexing and indexing excludes publication", async () => {
    const { leases, transaction } = harness();
    const index = await leases.acquireIndexing({
      repositoryId: "repo-1",
      rootIdentity: "root-1",
      ownerId: "indexer-1",
    });
    expect(index.status).toBe("acquired");
    expect(
      await transaction.publish(writeRequest({ state: "missing" })),
    ).toMatchObject({ ok: false, code: "BUSY" });
    if (index.status === "acquired") {
      await index.lease.release();
    }
    const publication = await leases.acquirePublication({
      repositoryId: "repo-1",
      rootIdentity: "root-1",
      ownerId: "worker-1",
    });
    expect(publication.status).toBe("acquired");
    expect(
      await leases.acquireIndexing({
        repositoryId: "repo-1",
        rootIdentity: "root-1",
        ownerId: "indexer-1",
      }),
    ).toMatchObject({ status: "busy" });
    if (publication.status === "acquired") {
      await publication.lease.release();
    }
  });

  it("rejects unknown owners before destination mutation", async () => {
    const request = {
      ...writeRequest({ state: "missing" }),
      ownerId: "stranger",
    };
    const { destination, transaction } = harness();
    expect(await transaction.publish(request)).toMatchObject({
      ok: false,
      code: "UNKNOWN_OWNER",
    });
    expect(destination.renameCount).toBe(0);
  });
});

describe("hostile public inputs", () => {
  it("contains proxy traps for publish and recover", async () => {
    const { transaction } = harness();
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile prototype trap");
        },
      },
    );

    expect(await transaction.publish(hostile)).toEqual({
      ok: false,
      code: "MALFORMED_INPUT",
      message: "transaction request could not be safely inspected",
    });
    expect(await transaction.recover(hostile)).toEqual({
      ok: false,
      code: "MALFORMED_INPUT",
      message: "recovery request could not be safely inspected",
    });
  });

  it("rejects accessors without invoking their getters", async () => {
    const { destination, transaction } = harness();
    let publishReads = 0;
    const publishInput = Object.defineProperty({}, "version", {
      enumerable: true,
      get() {
        publishReads += 1;
        throw new Error("publish getter must not execute");
      },
    });
    let recoveryReads = 0;
    const recoveryInput = Object.defineProperty({}, "repositoryId", {
      enumerable: true,
      get() {
        recoveryReads += 1;
        throw new Error("recovery getter must not execute");
      },
    });

    expect(await transaction.publish(publishInput)).toMatchObject({
      ok: false,
      code: "MALFORMED_INPUT",
    });
    expect(await transaction.recover(recoveryInput)).toMatchObject({
      ok: false,
      code: "MALFORMED_INPUT",
    });
    expect(publishReads).toBe(0);
    expect(recoveryReads).toBe(0);
    expect(destination.captureCount).toBe(0);
  });

  it("snapshots proxy data descriptors exactly once", async () => {
    const { transaction } = harness();
    const target = writeRequest({ state: "missing" });
    let versionSnapshots = 0;
    let propertyReads = 0;
    const input = new Proxy(target, {
      get() {
        propertyReads += 1;
        throw new Error("parser must not perform live property reads");
      },
      getOwnPropertyDescriptor(inner, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(inner, property);
        if (property !== "version" || descriptor === undefined) {
          return descriptor;
        }
        versionSnapshots += 1;
        return { ...descriptor, value: versionSnapshots };
      },
    });

    expect(await transaction.publish(input)).toMatchObject({
      ok: true,
      status: "committed",
    });
    expect(versionSnapshots).toBe(1);
    expect(propertyReads).toBe(0);
  });

  it("contains hostile nested target and byte-array proxies", async () => {
    const nestedTarget = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile target keys");
        },
      },
    );
    const request = {
      ...writeRequest({ state: "missing" }),
      targets: [nestedTarget],
    };
    const { transaction } = harness();
    expect(await transaction.publish(request)).toMatchObject({
      ok: false,
      code: "MALFORMED_INPUT",
    });

    const byteProxy = new Proxy([1, 2, 3], {
      getOwnPropertyDescriptor(_target, property) {
        if (property === "1") {
          throw new Error("hostile candidate descriptor");
        }
        return Reflect.getOwnPropertyDescriptor([1, 2, 3], property);
      },
    });
    const byteRequest = {
      ...writeRequest({ state: "missing" }),
      approvalReference: `approval-${digest("bytes")}`,
      targets: [
        {
          path: "src/bytes.ts",
          operation: "write",
          expected: { state: "missing" },
          candidateBytes: byteProxy,
        },
      ],
    };
    expect(await transaction.publish(byteRequest)).toMatchObject({
      ok: false,
      code: "MALFORMED_INPUT",
    });
  });
});
