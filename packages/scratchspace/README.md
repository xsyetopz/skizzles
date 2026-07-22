# `@skizzles/scratchspace`

This leaf package owns temporary work for one framework run. Call `create()`
when a task needs an owner-only checkout, build, download, agent-home, or test
area that can be stopped, measured, preserved explicitly, and reclaimed as one
unit.

## Run workspace API

```ts
import { create } from "@skizzles/scratchspace";

const workspace = await create({ signal: operationSignal });
try {
  const checkout = workspace.path("checkout");
  const usage = await workspace.inspectUsage({
    byteLimit: 10 * 1024 * 1024 * 1024,
    entryLimit: 100_000,
    scanLimit: 100_001,
  });
  if (usage.state !== "within") {
    throw new Error("run workspace quota unavailable or exceeded");
  }
} finally {
  const report = await workspace.close();
  if (report.state === "cleanup-failed") throw new Error(report.error);
}
```

Each `create()` call makes one owner-only root below the operating system's
canonical temporary directory. A synced marker binds the root filesystem
identity to the creating PID, process-start identity, and platform boot
identity where required.

`path()` with no arguments returns the root. Relative components with empty
segments, `.` or `..`, NUL, POSIX absolute paths, or Windows absolute paths are
rejected. `registerChild()` accepts an adapter whose `waitForExit()` resolves
only after its entire owned process scope is absent; numeric PID alone is never
treated as process-tree ownership.

Close requests stop children in reverse registration order. All children share
one graceful deadline and then one force deadline before root deletion.
`preserve(reason)` is the only retention opt-in and durably updates the marker
before returning, but preservation still stops registered children. `close()`
is single-flight while active, idempotent after success, and retryable after
cleanup failure. Deletion claims and revalidates the complete root; it never
removes selected nested directories independently.

## Usage inspection and stale cleanup

`inspectUsage()` performs a bounded, fail-closed inspection of the exact root.
It reports logical bytes, allocated bytes, and directory-entry count. Exact
limits pass; a value above either byte limit or the entry limit returns
`exceeded`. The scan never follows symlinks and counts hard-linked storage once
by filesystem identity.

Linux uses `/proc/self/fd` for descriptor-relative enumeration. Darwin uses
libc `getdirentries64`, `fstatat`, and `openat` through Bun FFI. Platforms
without a working descriptor adapter, including Windows, return `unknown`
before enumeration. Unreadable, raced, replaced, numerically unrepresentable,
or scan-truncated state also returns `unknown` with bounded observations.

Malformed limits, accessors, symbols, and proxy inputs return `unknown` with
code `INVALID_USAGE_LIMIT` without scanning. Configure `scanLimit` above
`entryLimit` when one-over entry detection must remain distinct from scan
truncation. One inspection accepts at most 1,000,000 scanned entries. The root
marker and every entry below the root count toward usage; the root directory
itself does not.

`cleanupStale()` scans only direct children and deletes only roots with exact
markers plus a definitely absent owner or a process-start mismatch proving PID
reuse. Live, preserved, too-young, unobservable, malformed, insecure, unmarked,
and identity-mismatched roots are retained. Every candidate, including an
interrupted `reaping-` root, is atomically renamed to a unique claim before
revalidation and deletion. Reports contain bounded root names and finite codes,
not machine paths or raw host errors.

## Signals and platform limits

`create({ handleSignals: true })` opts into scoped `SIGINT`, `SIGTERM`, and, on
Unix, `SIGHUP` coordination. Importing the module installs no signal handlers.
The package aborts `workspace.signal`, starts cleanup, and escalates children on
a repeated signal, then removes its handlers after successful cleanup.
Executables remain responsible for mapping an aborted operation to status 130,
143, or 129. Blind signal re-emission is rejected because it would redeliver
the signal to unrelated listeners. `SIGKILL`, crashes, and power loss are stale
cleanup cases.

Linux identity is boot ID plus `/proc/<pid>/stat` start ticks. Darwin uses
`kern.boottime` and normalized `/bin/ps -o lstart=` output. Windows invokes
`Get-Process` through the absolute system PowerShell path and uses UTC
`StartTime.ToFileTimeUtc()`; if identity or liveness cannot be established,
cleanup skips the root.

POSIX roots verify mode `0700` and current-user ownership. Windows inherits
access control from the per-user temporary directory and private created root;
Node/Bun mode bits do not independently prove the effective ACL. Marker files
are bounded canonical JSON regular files with owner-only permissions. Contents
are synced before publication, and parent-directory sync runs on Unix. Windows
has no equivalent portable directory handle through Node/Bun, so atomic rename
plus file sync is the strongest portable behavior here.

Windows recursive deletion uses bounded `fs.rm` retries for locked-file
classes. A terminal failure keeps the marked root for a later `close()` or
janitor retry. Shared caches are outside this package's ownership and need a
separate named owner with size and age bounds. The package has no runtime
package dependencies.

## Verify the package

From this directory:

```sh
bun run check
bun run typecheck
bun run test
bun run build
```
