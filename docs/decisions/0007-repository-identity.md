# 0007: Bind source repositories and dissociate clone object stores

## Status

Accepted.

## Context

Container Lab persisted a 12-hex digest of the canonical common-Git pathname as `repoHash` and recomputed that value before synchronization recovery. Replacing a repository with an unrelated repository at the same pathname preserved the digest, so recovery could target the replacement. The local `--no-hardlinks` clone also copied a source `objects/info/alternates` file. Such a workspace retained an absolute host path and became corrupt when the external object store moved.

The source pathname remains part of the lab contract. Normal commits, checkouts, branch changes, garbage collection, and temporary movement followed by restoring the same source repository must not change its identity. Linked worktrees must resolve through the common Git directory. Existing version-1 state must remain safely destroyable where destruction does not require journal recovery.

## Decision

New lab state stores `sourceRepositoryIdentity`, a full SHA-256 digest with an explicit domain separator over the canonical common-Git pathname plus that directory's filesystem device, inode, and birth-time identities. Provisioning fails when the filesystem cannot supply a positive stable birth identity. Sync preview, sync apply, and journal recovery recompute the token and reject a missing or mismatched value with fixed path-free errors. The existing `repoHash` and source-root path behavior remain unchanged for Compose naming and compatibility.

Local cloning adds Git's `--dissociate` option while retaining `--local --no-hardlinks`. The Git adapter disables reflogs so clone messages cannot persist the source pathname. After remote removal, provisioning resolves the clone's common Git directory and requires `objects/info/alternates` to be absent before checkout. Gitfiles and linked worktrees therefore use the same verification path as ordinary repositories.

## Alternatives

- Keep hashing only the pathname: rejected because same-path replacement is the reproduced failure.
- Bind only `HEAD` or a selected Git object: rejected because normal checkout and history maintenance can change or prune that content, while an unrelated clone can deliberately contain the same object.
- Persist only device and inode: rejected because inode reuse after deletion is possible. Adding the stable birth identity distinguishes a newly created directory even if the filesystem reuses an inode.
- Reject every source with alternates: safe but rejected because it unnecessarily excludes shared clones and linked worktrees when Git can make the destination self-contained and the implementation verifies that postcondition.
- Use the ordinary local transport without `--local`: rejected because it enters the Git-aware upload-pack path and expands executable-configuration reachability.
- Trust `--dissociate` without inspection: rejected because isolation is a product invariant, not an undocumented assumption about one Git build.

## Consequences

An ordinary unrelated repository recreated at the same source path receives a different durable filesystem binding and is rejected. Restoring the original common-Git directory to the recorded path remains valid. Shared sources remain supported, but their disposable clones do not retain external object-store dependencies or source-path reflogs. Legacy manifests without the new binding cannot synchronize or recover journals; journal-free explicit destruction remains available, while retained journals may require operator intervention before lifecycle state can be removed.

The identity is local-host state, not a portable repository UUID and not a defense against a privileged actor capable of forging filesystem metadata. Filesystem support for a stable birth identity is now a provisioning requirement.

## Fitness checks

```sh
TMPDIR="$(mktemp -d)" SHELL=/bin/zsh bun test \
  packages/container-lab/test/lab-service/repository.test.ts \
  packages/container-lab/test/lab-service/recovery.test.ts \
  packages/container-lab/test/state.test.ts
bun run --cwd packages/container-lab typecheck
bunx @biomejs/biome@2.5.4 check --config-path biome.jsonc --vcs-root . \
  packages/container-lab docs/decisions/0007-repository-identity.md \
  docs/decisions/README.md
bun run workspace:check
bun run security:check
bun run plugin:check
```

The production-entrypoint counterexamples must prove that a repository replaced at the same pathname is rejected before preview, apply, or retained-journal recovery; restoring the original filesystem object permits safe recovery and cleanup; an ordinary self-contained repository remains usable; and a linked worktree backed by a shared alternate object store provisions successfully only as a self-contained clone. The clone must have no alternates file, contain none of the source, shared-repository, or external-store absolute paths, and remain `git fsck --full --no-dangling` clean after those external stores move. State validation must reject malformed identity tokens, and legacy state must prove both journal-free destruction and fixed fail-closed synchronization diagnostics. Package tests, typecheck, Biome 2.5.4, workspace policy, repository security, and generated-plugin parity remain aggregate acceptance gates.

## Review and supersession

Review this decision when a supported filesystem cannot supply stable birth identity, device/inode/birth semantics change across a supported platform or restore mechanism, Git changes local-clone or `--dissociate` behavior, a new clone mode or object backend is introduced, durable lab state advances beyond version 1, or migration of legacy identity state becomes possible. Also review on any recurrence of alternates, external machine paths, reflog source paths, incomplete borrowed objects, or a same-path replacement passing identity validation.

Supersede this ADR before weakening the common-directory filesystem binding, admitting a filesystem without equivalent replacement detection, removing dissociation or the post-clone alternates check, re-enabling clone reflogs, changing legacy-state recovery semantics, or adopting a portable repository identifier. A replacement must define state migration and rollback, retain the same-path and shared-worktree counterexamples, and preserve package, workspace, security, and generated-plugin fitness gates.
