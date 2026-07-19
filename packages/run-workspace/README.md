# `@skizzles/run-workspace`

This leaf capability owns temporary work for one framework run. Each `create()` call makes one
owner-only root below the operating system's canonical temporary directory. A strict, synced marker
binds the root's filesystem identity to the creating PID, process start identity, and platform boot
identity where the platform requires it.

## Contract

```ts
import { create } from "@skizzles/run-workspace";

const workspace = await create({ signal: operationSignal });
try {
  const checkout = workspace.path("checkout");
  // Put every run-local checkout, build, download, agent home, and test artifact below checkout.
} finally {
  const report = await workspace.close();
  if (report.state === "cleanup-failed") throw new Error(report.error);
}
```

`path()` with no arguments returns the owned root. Relative components containing empty segments,
`.`/`..`, NUL, POSIX absolute paths, or Windows absolute paths are rejected. `registerChild()` accepts
an adapter whose `waitForExit()` resolves only after its entire owned process scope is absent. The
package never assumes a numeric PID owns a process tree. Close requests stops in reverse registration
order, shares one bounded graceful deadline across all children, escalates unresolved children, and
shares one bounded force deadline before considering root deletion.

`preserve(reason)` is the only retention opt-in and durably updates the marker before it returns.
Preservation still stops registered children. `close()` is single-flight while active, idempotent after
success, and retryable after cleanup failure. Deletion always claims and revalidates the complete root;
it never removes nested `.codex`, `.gradle`, `build`, `Downloads`, or any other child independently.

`cleanupStale()` performs a bounded direct-child scan. It deletes only roots with exact markers and a
definitely absent owner or a start-identity mismatch proving PID reuse. Live, preserved, too-young,
unobservable, malformed, insecure, unmarked, and identity-mismatched roots fail closed. Every candidate,
including an interrupted `reaping-` root, is atomically renamed to a unique claim before revalidation
and deletion, so concurrent janitors do not share a deletion lease. Reports contain bounded root names
and finite codes rather than absolute machine paths or raw host errors.

## Signals and cancellation

`create({ handleSignals: true })` opts into scoped `SIGINT`, `SIGTERM`, and, on Unix, `SIGHUP`
coordination. There are no module-import signal side effects. The package aborts `workspace.signal`,
starts cleanup, and escalates children on a repeated signal. It removes its handlers after successful
cleanup. Because library signal listeners suppress the runtime's default exit behavior, an executable
composition root remains responsible for mapping the aborted operation to its conventional status
(`130`, `143`, or `129`). Blind signal re-emission would deliver the signal twice to unrelated existing
listeners and is intentionally rejected. `SIGKILL`, crashes, and power loss are janitor recovery cases.

An external `AbortSignal` also aborts `workspace.signal` and starts cleanup. Callers should still await
`close()` in `finally` to observe the result.

## Platform and durability notes

- Linux identity is boot ID plus `/proc/<pid>/stat` start ticks.
- Darwin identity is `kern.boottime` plus normalized `/bin/ps -o lstart=` output.
- Windows identity is `Get-Process` UTC `StartTime.ToFileTimeUtc()` invoked through the absolute
  system PowerShell path. If identity or liveness cannot be established, cleanup skips the root.
- POSIX roots verify mode `0700` and current-user ownership after `chmod`. Windows inherits access
  control from the per-user platform temp directory and private created root; Node/Bun mode bits do not
  independently prove the effective Windows ACL, which remains a platform limitation.
- Marker files are bounded, canonical JSON regular files with owner-only permissions. File contents are
  synced before publication. Parent-directory sync is performed on Unix; Windows does not expose an
  equivalent portable directory handle through Node/Bun, so atomic rename plus file sync is the
  strongest portable behavior available here.
- Recursive deletion uses bounded `fs.rm` retries for Windows locked-file classes. Terminal deletion
  failures retain a marked root for a later `close()` or janitor retry.
- Shared caches are not owned by this package. They must live outside run roots, have a named capability
  owner, and enforce separate size/age bounds.
