// biome-ignore lint/style/noExcessiveLinesPerFile: this file is an adversarial trust-boundary matrix.
// biome-ignore lint/correctness/noUnresolvedImports: Bun's test module is provided by the runtime.
import { describe, expect, it } from "bun:test";

import type {
  ExternalSkillDirectoryReference,
  ReflexionFailureRecord,
  ReflexionFailureRecordInput,
  ReflexionMemoryPersistenceAuthority,
} from "../src/index.ts";
import {
  createReflexionFailureRecord,
  createReflexionMemoryQuery,
  createReflexionMemoryRecorder,
  createReflexionPersistenceReceipt,
  isReflexionFailureRecord,
  isReflexionMemoryQuery,
  isReflexionMemoryRecorder,
  parseReflexionFailureRecord,
  parseReflexionMemorySnapshot,
  parseReflexionPersistenceReceipt,
} from "../src/index.ts";

const digestA = `sha256:${"a".repeat(64)}` as const;
const digestB = `sha256:${"b".repeat(64)}` as const;
const digestC = `sha256:${"c".repeat(64)}` as const;

function skillReference(): ExternalSkillDirectoryReference {
  return {
    kind: "external-skill-directory",
    access: "read-only",
    directoryId: "catalog-security",
    relativeSkillPath: "verification/SKILL.md",
    revisionDigest: digestC,
  };
}

function input(
  taskId = "task-alpha",
  runId = "run-alpha",
): ReflexionFailureRecordInput {
  return {
    origin: { taskId, runId },
    failure: {
      kind: "verification-failure",
      summary: "The candidate violated its verification contract.",
      evidenceDigests: [digestB, digestA],
    },
    critique: {
      cause: "The implementation assumed an unproved boundary.",
      correction: "Bind the candidate to independently checked evidence.",
      prevention: "Require the evidence binding before approval.",
    },
    skillReferences: [skillReference()],
  };
}

class InMemoryPersistence implements ReflexionMemoryPersistenceAuthority {
  readonly records = new Map<string, ReflexionFailureRecord>();

  storeFailureRecordIfAbsent(record: ReflexionFailureRecord): Promise<unknown> {
    const duplicate = this.records.has(record.recordDigest);
    if (!duplicate) {
      this.records.set(record.recordDigest, record);
    }
    return Promise.resolve(
      createReflexionPersistenceReceipt({
        disposition: duplicate ? "duplicate" : "stored",
        recordDigest: record.recordDigest,
        persistenceRevisionDigest: digestC,
      }),
    );
  }

  source() {
    return {
      readFailureRecords: () =>
        Promise.resolve(Object.freeze([...this.records.values()])),
    };
  }
}

describe("failure record canonicalization", () => {
  it("creates deterministic deeply immutable content-addressed records", () => {
    const first = createReflexionFailureRecord(input());
    const second = createReflexionFailureRecord(input());
    expect(first).toEqual(second);
    expect(first.failure.evidenceDigests).toEqual([digestA, digestB]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.origin)).toBe(true);
    expect(Object.isFrozen(first.failure)).toBe(true);
    expect(Object.isFrozen(first.failure.evidenceDigests)).toBe(true);
    expect(Object.isFrozen(first.critique)).toBe(true);
    expect(Object.isFrozen(first.skillReferences)).toBe(true);
    expect(Object.isFrozen(first.skillReferences[0])).toBe(true);
    expect(isReflexionFailureRecord(first)).toBe(true);
  });

  it("binds origin, failure, critique, evidence, and skill references", () => {
    const baseline = createReflexionFailureRecord(input());
    const variants = [
      { ...input(), origin: { taskId: "task-beta", runId: "run-alpha" } },
      {
        ...input(),
        failure: { ...input().failure, summary: "A different failure." },
      },
      {
        ...input(),
        critique: { ...input().critique, prevention: "A different guard." },
      },
      {
        ...input(),
        failure: { ...input().failure, evidenceDigests: [digestA] },
      },
      { ...input(), skillReferences: [] },
    ];
    for (const variant of variants) {
      expect(createReflexionFailureRecord(variant).recordDigest).not.toBe(
        baseline.recordDigest,
      );
    }
  });

  it("rejects mutable, forged, accessor-backed, and proxied boundary records", () => {
    const canonical = createReflexionFailureRecord(input());
    expect(parseReflexionFailureRecord({ ...canonical })).toBeUndefined();
    expect(
      parseReflexionFailureRecord(
        Object.freeze({ ...canonical, recordDigest: digestA }),
      ),
    ).toBeUndefined();
    expect(isReflexionFailureRecord(new Proxy(canonical, {}))).toBe(false);

    let accessed = false;
    const accessor = Object.freeze({
      schema: canonical.schema,
      domain: canonical.domain,
      version: canonical.version,
      origin: canonical.origin,
      failure: canonical.failure,
      critique: canonical.critique,
      skillReferences: canonical.skillReferences,
      get recordDigest() {
        accessed = true;
        return canonical.recordDigest;
      },
    });
    expect(parseReflexionFailureRecord(accessor)).toBeUndefined();
    expect(accessed).toBe(false);
  });

  it("rejects accessor inputs without invoking them", () => {
    let accessed = false;
    const hostileOrigin = Object.freeze({
      get taskId() {
        accessed = true;
        return "task-alpha";
      },
      runId: "run-alpha",
    });
    expect(() =>
      createReflexionFailureRecord({ ...input(), origin: hostileOrigin }),
    ).toThrow();
    expect(accessed).toBe(false);
  });
});

describe("external skill references", () => {
  it("canonicalizes structured references as read-only values", () => {
    const referenceA: ExternalSkillDirectoryReference = {
      kind: "external-skill-directory",
      access: "read-only",
      directoryId: "catalog-zeta",
      relativeSkillPath: "zeta/SKILL.md",
      revisionDigest: digestB,
    };
    const referenceB: ExternalSkillDirectoryReference = {
      kind: "external-skill-directory",
      access: "read-only",
      directoryId: "catalog-alpha",
      relativeSkillPath: "alpha/SKILL.md",
      revisionDigest: digestA,
    };
    const record = createReflexionFailureRecord({
      ...input(),
      skillReferences: [referenceA, referenceB],
    });
    expect(record.skillReferences.map((entry) => entry.directoryId)).toEqual([
      "catalog-alpha",
      "catalog-zeta",
    ]);
    expect(
      record.skillReferences.every((entry) => entry.access === "read-only"),
    ).toBe(true);
  });

  it("rejects duplicate aliases, traversal, host paths, and writable references", () => {
    const reference = skillReference();
    expect(() =>
      createReflexionFailureRecord({
        ...input(),
        skillReferences: [reference, reference],
      }),
    ).toThrow();
    for (const relativeSkillPath of [
      "../SKILL.md",
      "skills//SKILL.md",
      "/skills/SKILL.md",
      "C:\\skills\\SKILL.md",
      "skills/e\u0301/SKILL.md",
    ]) {
      expect(() =>
        createReflexionFailureRecord({
          ...input(),
          skillReferences: [{ ...reference, relativeSkillPath }],
        }),
      ).toThrow();
    }
    expect(() =>
      createReflexionFailureRecord({
        ...input(),
        skillReferences: [{ ...reference, access: "read-write" } as never],
      }),
    ).toThrow();
  });

  it("rejects reordered references and shared aliases at a strict boundary", () => {
    const referenceA = skillReference();
    const referenceB: ExternalSkillDirectoryReference = {
      ...referenceA,
      directoryId: "catalog-alpha",
    };
    const canonical = createReflexionFailureRecord({
      ...input(),
      skillReferences: [referenceA, referenceB],
    });
    const reordered = Object.freeze({
      ...canonical,
      skillReferences: Object.freeze([...canonical.skillReferences].reverse()),
    });
    expect(parseReflexionFailureRecord(reordered)).toBeUndefined();

    const aliased = Object.freeze({
      ...canonical,
      skillReferences: Object.freeze([referenceB, referenceB]),
    });
    expect(parseReflexionFailureRecord(aliased)).toBeUndefined();
  });
});

describe("write-only recorder", () => {
  it("brands the write-only facade and rejects method copies", () => {
    const persistence = new InMemoryPersistence();
    const recorder = createReflexionMemoryRecorder(persistence);
    expect(isReflexionMemoryRecorder(recorder)).toBe(true);
    expect(isReflexionMemoryRecorder({ ...recorder })).toBe(false);
  });

  it("stores through the injected authority and returns only a bound receipt", async () => {
    const persistence = new InMemoryPersistence();
    const recorder = createReflexionMemoryRecorder(persistence);
    const receipt = await recorder.recordFailure(input());
    expect(receipt.disposition).toBe("stored");
    expect(receipt.recordDigest).toBe(
      createReflexionFailureRecord(input()).recordDigest,
    );
    expect(Object.keys(receipt)).not.toContain("critique");
    expect(persistence.records.size).toBe(1);
  });

  it("rejects sequential, concurrent, and cross-recorder replays", async () => {
    const persistence = new InMemoryPersistence();
    const recorder = createReflexionMemoryRecorder(persistence);
    await recorder.recordFailure(input());
    await expect(recorder.recordFailure(input())).rejects.toThrow("replay");
    await expect(
      createReflexionMemoryRecorder(persistence).recordFailure(input()),
    ).rejects.toThrow("replay");

    const deferredPersistence: ReflexionMemoryPersistenceAuthority = {
      async storeFailureRecordIfAbsent(record) {
        await Promise.resolve();
        return createReflexionPersistenceReceipt({
          disposition: "stored",
          recordDigest: record.recordDigest,
          persistenceRevisionDigest: digestC,
        });
      },
    };
    const concurrent = createReflexionMemoryRecorder(deferredPersistence);
    const first = concurrent.recordFailure(input("task-beta", "run-beta"));
    await expect(
      concurrent.recordFailure(input("task-beta", "run-beta")),
    ).rejects.toThrow("replay");
    await expect(first).resolves.toMatchObject({ disposition: "stored" });
  });

  it("rejects mutable, accessor, proxy, and wrong-record receipts", async () => {
    const record = createReflexionFailureRecord(input());
    const valid = createReflexionPersistenceReceipt({
      disposition: "stored",
      recordDigest: record.recordDigest,
      persistenceRevisionDigest: digestC,
    });
    expect(parseReflexionPersistenceReceipt(valid)).toEqual(valid);
    expect(parseReflexionPersistenceReceipt({ ...valid })).toBeUndefined();
    expect(
      parseReflexionPersistenceReceipt(new Proxy(valid, {})),
    ).toBeUndefined();
    const accessor = Object.freeze({
      schema: valid.schema,
      domain: valid.domain,
      version: valid.version,
      disposition: valid.disposition,
      recordDigest: valid.recordDigest,
      get persistenceRevisionDigest() {
        return digestC;
      },
    });
    expect(parseReflexionPersistenceReceipt(accessor)).toBeUndefined();

    const forged: ReflexionMemoryPersistenceAuthority = {
      storeFailureRecordIfAbsent() {
        return Promise.resolve(
          createReflexionPersistenceReceipt({
            disposition: "stored",
            recordDigest: digestA,
            persistenceRevisionDigest: digestC,
          }),
        );
      },
    };
    await expect(
      createReflexionMemoryRecorder(forged).recordFailure(input()),
    ).rejects.toThrow("does not bind");
  });

  it("clears in-flight state after persistence failure so a safe retry can proceed", async () => {
    let attempts = 0;
    const persistence: ReflexionMemoryPersistenceAuthority = {
      storeFailureRecordIfAbsent(record) {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new Error("storage unavailable"));
        }
        return Promise.resolve(
          createReflexionPersistenceReceipt({
            disposition: "stored",
            recordDigest: record.recordDigest,
            persistenceRevisionDigest: digestC,
          }),
        );
      },
    };
    const recorder = createReflexionMemoryRecorder(persistence);
    await expect(recorder.recordFailure(input())).rejects.toThrow(
      "storage unavailable",
    );
    await expect(recorder.recordFailure(input())).resolves.toMatchObject({
      disposition: "stored",
    });
  });
});

describe("read-only memory snapshots", () => {
  it("brands the read-only facade and rejects method copies", () => {
    const persistence = new InMemoryPersistence();
    const query = createReflexionMemoryQuery(persistence.source());
    expect(isReflexionMemoryQuery(query)).toBe(true);
    expect(isReflexionMemoryQuery({ ...query })).toBe(false);
  });

  it("excludes every record produced by the current task or current run", async () => {
    const records = Object.freeze([
      createReflexionFailureRecord(input("task-current", "run-old")),
      createReflexionFailureRecord(input("task-old", "run-current")),
      createReflexionFailureRecord(input("task-old", "run-old")),
    ]);
    const query = createReflexionMemoryQuery({
      readFailureRecords: () => Promise.resolve(records),
    });
    const snapshot = await query.snapshot({
      currentTaskId: "task-current",
      currentRunId: "run-current",
    });
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]?.origin).toEqual({
      taskId: "task-old",
      runId: "run-old",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.scope)).toBe(true);
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    expect(parseReflexionMemorySnapshot(snapshot)).toEqual(snapshot);
  });

  it("sorts records and produces deterministic scope-bound digests", async () => {
    const first = createReflexionFailureRecord(input("task-a", "run-a"));
    const second = createReflexionFailureRecord(input("task-b", "run-b"));
    const scope = { currentTaskId: "task-c", currentRunId: "run-c" };
    const left = await createReflexionMemoryQuery({
      readFailureRecords: () => Promise.resolve(Object.freeze([first, second])),
    }).snapshot(scope);
    const right = await createReflexionMemoryQuery({
      readFailureRecords: () => Promise.resolve(Object.freeze([second, first])),
    }).snapshot(scope);
    expect(left).toEqual(right);
    const differentScope = await createReflexionMemoryQuery({
      readFailureRecords: () => Promise.resolve(Object.freeze([first, second])),
    }).snapshot({ currentTaskId: "task-d", currentRunId: "run-d" });
    expect(differentScope.snapshotDigest).not.toBe(left.snapshotDigest);
  });

  it("rejects mutable sources, invalid records, and replayed aliases", async () => {
    const record = createReflexionFailureRecord(input());
    await expect(
      createReflexionMemoryQuery({
        readFailureRecords: () => Promise.resolve([record]),
      }).snapshot({ currentTaskId: "task-next", currentRunId: "run-next" }),
    ).rejects.toThrow("immutable array");
    await expect(
      createReflexionMemoryQuery({
        readFailureRecords: () =>
          Promise.resolve(Object.freeze([{ ...record }])),
      }).snapshot({ currentTaskId: "task-next", currentRunId: "run-next" }),
    ).rejects.toThrow("invalid");
    await expect(
      createReflexionMemoryQuery({
        readFailureRecords: () =>
          Promise.resolve(Object.freeze([record, record])),
      }).snapshot({ currentTaskId: "task-next", currentRunId: "run-next" }),
    ).rejects.toThrow("replayed");
  });

  it("rejects snapshot digest forgery, reordering, accessors, and current-run leaks", async () => {
    const records = Object.freeze([
      createReflexionFailureRecord(input("task-a", "run-a")),
      createReflexionFailureRecord(input("task-b", "run-b")),
    ]);
    const snapshot = await createReflexionMemoryQuery({
      readFailureRecords: () => Promise.resolve(records),
    }).snapshot({ currentTaskId: "task-current", currentRunId: "run-current" });

    expect(
      parseReflexionMemorySnapshot(
        Object.freeze({ ...snapshot, snapshotDigest: digestA }),
      ),
    ).toBeUndefined();
    expect(
      parseReflexionMemorySnapshot(
        Object.freeze({
          ...snapshot,
          records: Object.freeze([...snapshot.records].reverse()),
        }),
      ),
    ).toBeUndefined();
    expect(
      parseReflexionMemorySnapshot(
        Object.freeze({
          ...snapshot,
          scope: Object.freeze({
            currentTaskId: snapshot.records[0]?.origin.taskId,
            currentRunId: "run-current",
          }),
        }),
      ),
    ).toBeUndefined();

    let accessed = false;
    const accessor = Object.freeze({
      schema: snapshot.schema,
      domain: snapshot.domain,
      version: snapshot.version,
      scope: snapshot.scope,
      records: snapshot.records,
      get snapshotDigest(): string {
        accessed = true;
        return snapshot.snapshotDigest;
      },
    });
    expect(parseReflexionMemorySnapshot(accessor)).toBeUndefined();
    expect(accessed).toBe(false);
  });
});
