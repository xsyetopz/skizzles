import { createHash } from "node:crypto";
import type {
  ApprovalAuthorityPort,
  ApprovalBindings,
  ApprovalDecision,
  DestinationAuthorityPort,
  ExpectedSnapshot,
  FileSnapshot,
  JournalSnapshot,
  OwnershipTag,
  RepositoryIdentity,
  SiblingSnapshot,
  TargetSnapshot,
} from "../src/index.ts";

export function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function digest(value: Uint8Array | string): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : value)
    .digest("hex");
}

type StoredFile = {
  bytes: Uint8Array;
  identity: string;
  deviceId: string;
  kind: "file" | "symlink" | "directory" | "other";
  linkCount: number;
};

type StoredSibling = StoredFile & { name: string; ownership: OwnershipTag };

function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function fileSnapshot(file: StoredFile): TargetSnapshot {
  if (file.kind !== "file") {
    return {
      state: file.kind,
      identity: file.identity,
      deviceId: file.deviceId,
      linkCount: file.linkCount,
    };
  }
  return {
    state: "file",
    identity: file.identity,
    deviceId: file.deviceId,
    byteLength: file.bytes.byteLength,
    contentDigest: digest(file.bytes),
    linkCount: file.linkCount,
  };
}

function exactExpected(
  expected: ExpectedSnapshot,
  current: TargetSnapshot,
): boolean {
  if (expected.state !== current.state) {
    return false;
  }
  if (expected.state === "missing") {
    return true;
  }
  return (
    current.state === "file" &&
    expected.identity === current.identity &&
    expected.deviceId === current.deviceId &&
    expected.byteLength === current.byteLength &&
    expected.contentDigest === current.contentDigest &&
    expected.linkCount === current.linkCount
  );
}

export class IsolatedDestinationFixture implements DestinationAuthorityPort {
  readonly repository: RepositoryIdentity = {
    repositoryId: "repo-1",
    rootIdentity: "root-1",
    deviceId: "device-1",
  };

  readonly files = new Map<string, StoredFile>();
  readonly siblings = new Map<string, StoredSibling>();
  renameCount = 0;
  inspectCount = 0;
  inspectSiblingCount = 0;
  inspectSiblingFailureAt: number | undefined;
  writeJournalCount = 0;
  writeJournalFailureAt: number | undefined;
  replaceTargetCount = 0;
  replaceTargetFailureAt: number | undefined;
  captureCount = 0;
  onInspect: ((fixture: IsolatedDestinationFixture) => void) | undefined;
  cleanupFailureName: string | undefined;
  private journal:
    | {
        bytes: Uint8Array;
        identity: string;
        revision: string;
        deviceId: string;
        kind: JournalSnapshot["kind"];
        linkCount: number;
      }
    | undefined;
  private identityCounter = 1;
  private revisionCounter = 1;

  setFile(
    path: string,
    value: string,
    options: Partial<
      Pick<StoredFile, "deviceId" | "kind" | "linkCount" | "identity">
    > = {},
  ): FileSnapshot {
    const file: StoredFile = {
      bytes: bytes(value),
      identity: options.identity ?? `file-${this.identityCounter++}`,
      deviceId: options.deviceId ?? this.repository.deviceId,
      kind: options.kind ?? "file",
      linkCount: options.linkCount ?? 1,
    };
    this.files.set(path, file);
    const snapshot = fileSnapshot(file);
    if (snapshot.state !== "file") {
      throw new Error("fixture expected a regular file");
    }
    return snapshot;
  }

  setUnsafe(
    path: string,
    kind: "symlink" | "directory" | "other",
    deviceId = "device-1",
  ): void {
    this.files.set(path, {
      bytes: new Uint8Array(),
      identity: `unsafe-${this.identityCounter++}`,
      deviceId,
      kind,
      linkCount: 1,
    });
  }

  currentText(path: string): string | undefined {
    const file = this.files.get(path);
    return file === undefined
      ? undefined
      : new TextDecoder().decode(file.bytes);
  }

  corruptJournal(
    bytesValue: Uint8Array,
    kind: JournalSnapshot["kind"] = "file",
  ): void {
    this.journal = {
      bytes: cloneBytes(bytesValue),
      identity: `journal-${this.identityCounter++}`,
      revision: `revision-${this.revisionCounter++}`,
      deviceId: this.repository.deviceId,
      kind,
      linkCount: 1,
    };
  }

  foreignizeSibling(name: string): void {
    const sibling = this.siblings.get(name);
    if (sibling !== undefined) {
      sibling.ownership = {
        ...sibling.ownership,
        transactionId: digest("foreign"),
      };
    }
  }

  async captureRepository(repositoryId: string): Promise<RepositoryIdentity> {
    this.captureCount += 1;
    if (repositoryId !== this.repository.repositoryId) {
      throw new Error("unknown repository");
    }
    return { ...this.repository };
  }

  async inspectTargets(
    _repository: RepositoryIdentity,
    paths: readonly string[],
  ): Promise<readonly TargetSnapshot[]> {
    this.inspectCount += 1;
    this.onInspect?.(this);
    return paths.map((path) => {
      const file = this.files.get(path);
      return file === undefined ? { state: "missing" } : fileSnapshot(file);
    });
  }

  async readJournal(): Promise<JournalSnapshot | undefined> {
    return this.journal === undefined
      ? undefined
      : {
          ...this.journal,
          bytes: cloneBytes(this.journal.bytes),
        };
  }

  async writeJournal(
    _repository: RepositoryIdentity,
    expectedRevision: string | undefined,
    value: Uint8Array,
  ): Promise<JournalSnapshot> {
    this.writeJournalCount += 1;
    if (this.writeJournalCount === this.writeJournalFailureAt) {
      throw new Error(`writeJournal rejected at ${this.writeJournalCount}`);
    }
    if (expectedRevision === undefined) {
      if (this.journal !== undefined) {
        throw new Error("journal already exists");
      }
    } else if (this.journal?.revision !== expectedRevision) {
      throw new Error("journal revision changed");
    }
    this.journal = {
      bytes: cloneBytes(value),
      identity: this.journal?.identity ?? `journal-${this.identityCounter++}`,
      revision: `revision-${this.revisionCounter++}`,
      deviceId: this.repository.deviceId,
      kind: "file",
      linkCount: 1,
    };
    return { ...this.journal, bytes: cloneBytes(this.journal.bytes) };
  }

  async removeJournal(
    _repository: RepositoryIdentity,
    expectedRevision: string,
  ): Promise<void> {
    if (this.journal?.revision !== expectedRevision) {
      throw new Error("journal revision changed");
    }
    this.journal = undefined;
  }

  async createSibling(
    _repository: RepositoryIdentity,
    name: string,
    value: Uint8Array,
    ownership: OwnershipTag,
  ): Promise<SiblingSnapshot> {
    if (this.siblings.has(name)) {
      throw new Error("sibling already exists");
    }
    const sibling: StoredSibling = {
      name,
      bytes: cloneBytes(value),
      identity: `sibling-${this.identityCounter++}`,
      deviceId: this.repository.deviceId,
      kind: "file",
      linkCount: 1,
      ownership: { ...ownership },
    };
    this.siblings.set(name, sibling);
    return this.siblingSnapshot(sibling);
  }

  async inspectSibling(
    _repository: RepositoryIdentity,
    name: string,
  ): Promise<SiblingSnapshot | undefined> {
    this.inspectSiblingCount += 1;
    if (this.inspectSiblingCount === this.inspectSiblingFailureAt) {
      throw new Error(`inspectSibling rejected at ${this.inspectSiblingCount}`);
    }
    const sibling = this.siblings.get(name);
    return sibling === undefined ? undefined : this.siblingSnapshot(sibling);
  }

  async removeSibling(
    _repository: RepositoryIdentity,
    sibling: SiblingSnapshot,
    ownership: OwnershipTag,
  ): Promise<void> {
    if (this.cleanupFailureName === sibling.name) {
      throw new Error("injected cleanup failure");
    }
    const stored = this.siblings.get(sibling.name);
    if (
      stored === undefined ||
      stored.identity !== sibling.identity ||
      stored.ownership.transactionId !== ownership.transactionId ||
      stored.ownership.targetPath !== ownership.targetPath ||
      stored.ownership.role !== ownership.role
    ) {
      throw new Error("sibling rebound");
    }
    this.siblings.delete(sibling.name);
  }

  async replaceTargetFromSibling(
    _repository: RepositoryIdentity,
    targetPath: string,
    expectedTarget: ExpectedSnapshot,
    sibling: SiblingSnapshot,
  ): Promise<FileSnapshot> {
    this.replaceTargetCount += 1;
    if (this.replaceTargetCount === this.replaceTargetFailureAt) {
      throw new Error(`replaceTarget rejected at ${this.replaceTargetCount}`);
    }
    const currentFile = this.files.get(targetPath);
    const current =
      currentFile === undefined
        ? { state: "missing" as const }
        : fileSnapshot(currentFile);
    if (!exactExpected(expectedTarget, current)) {
      throw new Error("target rebound before rename");
    }
    const stored = this.siblings.get(sibling.name);
    if (stored === undefined || stored.identity !== sibling.identity) {
      throw new Error("candidate rebound before rename");
    }
    this.files.set(targetPath, {
      bytes: cloneBytes(stored.bytes),
      identity: stored.identity,
      deviceId: stored.deviceId,
      kind: "file",
      linkCount: 1,
    });
    this.siblings.delete(sibling.name);
    this.renameCount += 1;
    const published = fileSnapshot(this.files.get(targetPath) as StoredFile);
    if (published.state !== "file") {
      throw new Error("fixture publication failed");
    }
    return published;
  }

  async retireTargetToSibling(
    _repository: RepositoryIdentity,
    targetPath: string,
    expectedTarget: FileSnapshot,
    siblingName: string,
    ownership: OwnershipTag,
  ): Promise<SiblingSnapshot> {
    const current = this.files.get(targetPath);
    if (
      current === undefined ||
      !exactExpected(expectedTarget, fileSnapshot(current)) ||
      this.siblings.has(siblingName)
    ) {
      throw new Error("delete target rebound before rename");
    }
    const sibling: StoredSibling = {
      ...current,
      name: siblingName,
      ownership: { ...ownership },
    };
    this.siblings.set(siblingName, sibling);
    this.files.delete(targetPath);
    this.renameCount += 1;
    return this.siblingSnapshot(sibling);
  }

  private siblingSnapshot(sibling: StoredSibling): SiblingSnapshot {
    return {
      name: sibling.name,
      identity: sibling.identity,
      deviceId: sibling.deviceId,
      byteLength: sibling.bytes.byteLength,
      contentDigest: digest(sibling.bytes),
      linkCount: sibling.linkCount,
      kind: "file",
      ownership: { ...sibling.ownership },
    };
  }
}

export class ApprovalFixture implements ApprovalAuthorityPort {
  readonly approvalDigest = digest("approval-1");
  bindings: ApprovalBindings | undefined;
  consumed = false;
  mismatch = false;

  async verifyAndConsume(
    bindings: ApprovalBindings,
  ): Promise<ApprovalDecision> {
    this.bindings = bindings;
    if (this.consumed) {
      return { status: "already-consumed" };
    }
    this.consumed = true;
    return {
      status: "approved",
      approvalDigest: this.approvalDigest,
      bindings: this.mismatch
        ? { ...bindings, rootIdentity: "different-root" }
        : bindings,
    };
  }
}

export function writeRequest(
  expected: ExpectedSnapshot,
  path = "src/file.ts",
  content = "new",
): Readonly<Record<string, unknown>> {
  return {
    version: 1,
    repositoryId: "repo-1",
    rootIdentity: "root-1",
    ownerId: "worker-1",
    approvalReference: "approval-ref-1",
    targets: [
      {
        path,
        operation: "write",
        expected,
        candidateBytes: [...bytes(content)],
      },
    ],
  };
}

export function recoveryRequest(
  approval: ApprovalFixture,
  transactionId: string,
): Readonly<Record<string, unknown>> {
  if (approval.bindings === undefined) {
    throw new Error("approval has not captured bindings");
  }
  return {
    version: 1,
    repositoryId: approval.bindings.repositoryId,
    rootIdentity: approval.bindings.rootIdentity,
    ownerId: approval.bindings.ownerId,
    transactionId,
    requestDigest: approval.bindings.requestDigest,
    approvalDigest: approval.approvalDigest,
  };
}
