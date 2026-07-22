import { createHash } from "node:crypto";
import type {
  DestinationAuthorityPort,
  ExpectedSnapshot,
  FileSnapshot,
  JournalSnapshot,
  OwnershipTag,
  RepositoryIdentity,
  SiblingSnapshot,
  TargetSnapshot,
} from "@skizzles/workspace-publication";

interface StoredFile {
  readonly bytes: Uint8Array;
  readonly identity: string;
  readonly deviceId: string;
}

interface StoredSibling extends StoredFile {
  readonly name: string;
  readonly ownership: OwnershipTag;
}

export class IsolatedDestination implements DestinationAuthorityPort {
  readonly repository: RepositoryIdentity = {
    repositoryId: "repo-a",
    rootIdentity: "root-a",
    deviceId: "device-a",
  };
  private readonly files = new Map<string, StoredFile>();
  private readonly siblings = new Map<string, StoredSibling>();
  private journal: JournalSnapshot | undefined;
  private sequence = 0;
  captureCount = 0;

  currentText(path: string): string | undefined {
    const file = this.files.get(path);
    if (file === undefined) {
      return;
    }
    return new TextDecoder().decode(file.bytes);
  }

  captureRepository(repositoryId: string): Promise<RepositoryIdentity> {
    this.captureCount += 1;
    if (repositoryId !== this.repository.repositoryId) {
      return Promise.reject(new Error("unknown repository"));
    }
    return Promise.resolve({ ...this.repository });
  }

  inspectTargets(
    _repository: RepositoryIdentity,
    paths: readonly string[],
  ): Promise<readonly TargetSnapshot[]> {
    return Promise.resolve(
      paths.map((path) => {
        const file = this.files.get(path);
        if (file === undefined) {
          return { state: "missing" };
        }
        return snapshot(file);
      }),
    );
  }

  readJournal(): Promise<JournalSnapshot | undefined> {
    if (this.journal === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      ...this.journal,
      bytes: Uint8Array.from(this.journal.bytes),
    });
  }

  writeJournal(
    _repository: RepositoryIdentity,
    expectedRevision: string | undefined,
    bytes: Uint8Array,
  ): Promise<JournalSnapshot> {
    if (this.journal?.revision !== expectedRevision) {
      return Promise.reject(new Error("journal revision changed"));
    }
    this.sequence += 1;
    this.journal = {
      bytes: Uint8Array.from(bytes),
      identity: "journal-a",
      deviceId: this.repository.deviceId,
      revision: `revision-${this.sequence}`,
      linkCount: 1,
      kind: "file",
    };
    return Promise.resolve({ ...this.journal, bytes: Uint8Array.from(bytes) });
  }

  removeJournal(
    _repository: RepositoryIdentity,
    expectedRevision: string,
  ): Promise<void> {
    if (this.journal?.revision !== expectedRevision) {
      return Promise.reject(new Error("journal revision changed"));
    }
    this.journal = undefined;
    return Promise.resolve();
  }

  createSibling(
    _repository: RepositoryIdentity,
    name: string,
    bytes: Uint8Array,
    ownership: OwnershipTag,
  ): Promise<SiblingSnapshot> {
    this.sequence += 1;
    const sibling: StoredSibling = {
      name,
      bytes: Uint8Array.from(bytes),
      identity: `sibling-${this.sequence}`,
      deviceId: this.repository.deviceId,
      ownership: { ...ownership },
    };
    this.siblings.set(name, sibling);
    return Promise.resolve(siblingSnapshot(sibling));
  }

  inspectSibling(
    _repository: RepositoryIdentity,
    name: string,
  ): Promise<SiblingSnapshot | undefined> {
    const sibling = this.siblings.get(name);
    if (sibling === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(siblingSnapshot(sibling));
  }

  removeSibling(
    _repository: RepositoryIdentity,
    sibling: SiblingSnapshot,
    ownership: OwnershipTag,
  ): Promise<void> {
    const stored = this.siblings.get(sibling.name);
    if (
      stored === undefined ||
      stored.identity !== sibling.identity ||
      stored.ownership.transactionId !== ownership.transactionId
    ) {
      return Promise.reject(new Error("sibling ownership changed"));
    }
    this.siblings.delete(sibling.name);
    return Promise.resolve();
  }

  replaceTargetFromSibling(
    _repository: RepositoryIdentity,
    targetPath: string,
    expectedTarget: ExpectedSnapshot,
    sibling: SiblingSnapshot,
  ): Promise<FileSnapshot> {
    if (expectedTarget.state !== "missing" || this.files.has(targetPath)) {
      return Promise.reject(new Error("target drifted"));
    }
    const stored = this.siblings.get(sibling.name);
    if (stored === undefined || stored.identity !== sibling.identity) {
      return Promise.reject(new Error("candidate drifted"));
    }
    this.files.set(targetPath, stored);
    this.siblings.delete(sibling.name);
    return Promise.resolve(snapshot(stored));
  }

  retireTargetToSibling(): Promise<SiblingSnapshot> {
    void this.repository;
    return Promise.reject(new Error("delete is not used by this fixture"));
  }
}

function snapshot(file: StoredFile): FileSnapshot {
  return {
    state: "file",
    identity: file.identity,
    deviceId: file.deviceId,
    byteLength: file.bytes.byteLength,
    contentDigest: digest(file.bytes),
    linkCount: 1,
  };
}

function siblingSnapshot(sibling: StoredSibling): SiblingSnapshot {
  return {
    name: sibling.name,
    identity: sibling.identity,
    deviceId: sibling.deviceId,
    byteLength: sibling.bytes.byteLength,
    contentDigest: digest(sibling.bytes),
    linkCount: 1,
    kind: "file",
    ownership: { ...sibling.ownership },
  };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
