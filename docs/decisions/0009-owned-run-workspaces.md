# ADR 0009: Own disposable run workspaces as one lifecycle capability

- **Status:** Accepted
- **Date:** 2026-07-19
- **Decision owner:** `@skizzles/run-workspace`
- **Scope:** Cross-platform temporary roots, child shutdown, signals, preservation,
  and stale-run reclamation

## Context and evidence

Prompt patching, model-catalog probes, repository-security tools, plugin comparison,
installer previews, doctor probes, and package tests create disposable files beneath
the host temporary directory. Their local `try/finally` cleanup handles ordinary
returns and exceptions, but each owner independently selects roots, terminates child
processes, and recovers crashes. None supplies a common ownership marker or a janitor
that can distinguish a dead owner from PID reuse.

This is a lifecycle and security boundary rather than a filesystem helper. Deleting a
recognizable nested directory is unsafe because names such as `.codex`, `.gradle`,
`build`, and `Downloads` can exist inside unrelated roots. Automatic deletion must be
limited to the exact root created and marked by this capability.

Primary runtime contracts support the portable primitives but not the complete
policy. [`os.tmpdir()`](https://nodejs.org/api/os.html#ostmpdir) follows the platform's
temporary-directory environment. [`fs.rm`](https://nodejs.org/api/fs.html#fspromisesrmpath-options)
offers bounded retries for busy, permission, and non-empty failures. Bun exposes
subprocess termination and an awaited `exited` lifecycle, but a PID does not prove
ownership of a process tree. Node signal listeners replace default termination
behavior, so cleanup handlers must be scoped and callers must preserve terminal exit
semantics. Windows exposes process creation time through `GetProcessTimes` and
PowerShell `Get-Process`; inaccessible evidence cannot safely be interpreted as stale.

## Decision

Create the zero-workspace-dependency package `@skizzles/run-workspace`. One
top-level operation creates one `RunWorkspace` and injects it downward. Helpers receive
that workspace and never silently create another root.

The public surface is limited to:

- `create()` and `cleanupStale()`;
- `RunWorkspace.path()`, `registerChild()`, `preserve()`, `close()`, and its
  cancellation signal;
- the child lifecycle port, result types, and deterministic package errors required
  to use those operations.

`path()` with no components returns the owned root. Components containing absolute
paths, traversal, empty ambiguity, or NUL are rejected. Child adapters own their real
scope and implement graceful stop, forced stop, and proof that the complete scope has
exited. The manager never infers tree ownership from a PID.

Creation uses the canonical platform temporary directory, a private managed parent,
an unpredictable root, and an exclusive owner-only marker. The strict marker records
the schema/version, run identifier, root name and filesystem identity, creation/update
time, owner PID and process-start identity, lifecycle state, and optional preservation
or failure reason. Unsupported, malformed, oversized, symlinked, or identity-mismatched
markers are not deletion authority.

`close()` is idempotent and single-flight. It stops registered children in reverse
order, applies bounded graceful and force deadlines, and requires confirmed exit
before deletion. Preservation is explicit and durable before `preserve()` returns;
preserved close still terminates children. Normal cleanup revalidates the root and
marker, claims the whole root at its parent, revalidates again, and recursively removes
only that root. An unconfirmed child or removal failure retains a `cleanup-failed`
marked root and returns an observable failure.

`cleanupStale()` performs a bounded scan of direct managed-parent children. It claims
one candidate atomically, then repeats marker and filesystem identity validation. A
root is eligible only after the minimum age and only when the owner PID is absent or
its current start identity definitely differs. Preserved, live, unknown, unmarked, and
malformed candidates remain. Concurrent janitors race on the claim rather than on
recursive deletion.

Process-start identity binds Linux boot ID plus `/proc/<pid>/stat` field 22, macOS boot
identity plus normalized `ps -o lstart=`, and Windows process creation time from an
absolute system PowerShell executable. Provider failure and access denial are
`unknown`, never stale. Signal handling is installed only for opted-in active
workspaces, aborts work before cleanup, coordinates concurrent roots, and unregisters
when unused. `SIGKILL` and crashes remain janitor responsibility.

## Separate lifecycle classes

The janitor must not sweep:

- Container Lab state, runtime roots, journals, or workspaces that intentionally span
  commands and are owned by lab manifests and the reaper;
- bounded command-supervisor output retained as operational evidence;
- installer prompt-policy locks used for cross-process coordination;
- model-catalog persistent output, status, and cache;
- atomic sibling `*.tmp` files that must share a durable target filesystem.

Those owners must use platform path APIs, explicit bounds, and their existing recovery
contracts. A durable store is not made safer by mislabelling it disposable.

## Alternatives considered

- **Put the manager in command-supervisor:** rejected because policy, prompt, model,
  installer, and packaging owners would depend on a delivery-specific retained-output
  package.
- **Keep one implementation per package:** rejected because marker, PID-reuse,
  signal, and deletion semantics would diverge and nested composition could not enforce
  one root.
- **Place ambient helpers under root scripts:** rejected because the repository root is
  orchestration and cannot express a TypeScript dependency boundary.
- **Delete familiar nested directories:** rejected because names are not ownership
  evidence.
- **Treat PID existence as liveness:** rejected because PIDs are reused.
- **Delete unknown-owner or malformed roots:** rejected because failure to prove a
  live owner is not proof of safe deletion.

## Consequences and limitations

Consumers gain one injectable cancellation and cleanup boundary, and crash residue can
be reclaimed without scanning arbitrary temporary content. The package adds lifecycle
code and platform probes, and every creating composition root must propagate its signal
and register owned children correctly. A caller that continues writing after abort can
race cleanup; signal-aware composition is therefore an acceptance rule.

Injected macOS tests do not establish native Windows deletion, ACL, PowerShell, or
process-tree behavior. Bun's Node compatibility must be verified on the supported Bun
version. Real Linux and Windows jobs remain release evidence. Windows safety relies on
atomic user-temp creation, reparse-point rejection, identities, and current-user
process evidence; this ADR does not claim a native ACL proof. Preserved roots have no
automatic expiry and require an explicit later operator decision.

## Fitness checks

```sh
bun run --cwd packages/run-workspace check
bun run --cwd packages/run-workspace typecheck
bun run --cwd packages/run-workspace test
bun run --cwd packages/run-workspace build
bun run workspace:check
bun run verify
```

Tests cover normal/exception/timeout/cancellation paths, nonzero and unresponsive
children, child-before-root ordering, concurrent runs and janitors, stale PID, PID
reuse, unknown identity, preservation, malformed/replaced markers, cleanup retry and
failure recovery, Windows locked-file seams, Unix signals, interrupted cleanup claims,
path rejection, and whole-root deletion with same-named outside sentinels. Clean Linux
and Windows execution must supplement injected platform seams.

Architecture policy rejects new production `mkdtemp` or hard-coded host temporary
paths outside this owner unless an exact documented durable/atomic exception applies.
Generated plugin parity proves that bundled consumers retain the same lifecycle.

## Review and supersession

Review on Bun/Node upgrades, supported-platform changes, marker-schema changes, new
temporary creators, janitor or signal incidents, PID probe changes, preserved-root
growth, or a cleanup failure in acceptance. Supersession must migrate all consumers,
remove the displaced marker/janitor/signal path, update architecture enforcement and
tests, and preserve the rule that automatic deletion requires exact root ownership.
