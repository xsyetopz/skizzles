import type {
  PublicationLease,
  PublicationLeaseDecision,
  RepositoryLeaseAuthorityPort,
} from "../protocol/contracts.ts";

export type KnownLeaseOwner = Readonly<{
  repositoryId: string;
  rootIdentity: string;
  ownerId: string;
}>;

export type IndexLease = Readonly<{
  leaseId: string;
  repositoryId: string;
  rootIdentity: string;
  ownerId: string;
  release(): Promise<void>;
}>;

export type IndexLeaseDecision =
  | Readonly<{ status: "acquired"; lease: IndexLease }>
  | Readonly<{ status: "busy" | "unknown-owner" }>;

export type LocalRepositoryLeaseAuthority = RepositoryLeaseAuthorityPort &
  Readonly<{
    acquireIndexing(
      input: Readonly<{
        repositoryId: string;
        rootIdentity: string;
        ownerId: string;
      }>,
    ): Promise<IndexLeaseDecision>;
  }>;

type RepositoryLeaseState = {
  publicationLeaseId?: string;
  indexingLeaseIds: Set<string>;
};

function ownerKey(owner: KnownLeaseOwner): string {
  return `${owner.repositoryId}\0${owner.rootIdentity}\0${owner.ownerId}`;
}

function repositoryKey(
  input: Readonly<{ repositoryId: string; rootIdentity: string }>,
): string {
  return `${input.repositoryId}\0${input.rootIdentity}`;
}

export function createLocalRepositoryLeaseAuthority(
  knownOwners: readonly KnownLeaseOwner[],
): LocalRepositoryLeaseAuthority {
  const owners = new Set(knownOwners.map(ownerKey));
  const states = new Map<string, RepositoryLeaseState>();
  let nextLease = 1;

  function isKnown(input: KnownLeaseOwner): boolean {
    return owners.has(ownerKey(input));
  }

  function stateFor(
    input: Readonly<{ repositoryId: string; rootIdentity: string }>,
  ): RepositoryLeaseState {
    const key = repositoryKey(input);
    const existing = states.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created = { indexingLeaseIds: new Set<string>() };
    states.set(key, created);
    return created;
  }

  return {
    async acquirePublication(input): Promise<PublicationLeaseDecision> {
      if (!isKnown(input)) {
        return { status: "unknown-owner" };
      }
      const state = stateFor(input);
      if (
        state.publicationLeaseId !== undefined ||
        state.indexingLeaseIds.size > 0
      ) {
        return { status: "busy" };
      }
      const leaseId = `publication-${nextLease++}`;
      state.publicationLeaseId = leaseId;
      let released = false;
      const lease: PublicationLease = {
        leaseId,
        ...input,
        async release(): Promise<void> {
          if (!released && state.publicationLeaseId === leaseId) {
            delete state.publicationLeaseId;
            released = true;
          }
        },
      };
      return { status: "acquired", lease };
    },

    async acquireIndexing(input): Promise<IndexLeaseDecision> {
      if (!isKnown(input)) {
        return { status: "unknown-owner" };
      }
      const state = stateFor(input);
      if (state.publicationLeaseId !== undefined) {
        return { status: "busy" };
      }
      const leaseId = `index-${nextLease++}`;
      state.indexingLeaseIds.add(leaseId);
      let released = false;
      const lease: IndexLease = {
        leaseId,
        ...input,
        async release(): Promise<void> {
          if (!released) {
            state.indexingLeaseIds.delete(leaseId);
            released = true;
          }
        },
      };
      return { status: "acquired", lease };
    },
  };
}
