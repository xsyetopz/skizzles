# Safety model

Labs are disposable trusted-project environments, not a policy sandbox for hostile Compose files.

The engine adds only its isolated workspace mount, init behavior, random loopback publications explicitly declared by the manifest, non-sensitive metadata, and exact management labels. It never introduces a Docker socket, credential mount, secret, privileged mode, host namespace, device, capability, language toolchain, database, cache, object store, or project credential. `secret_environment` is the explicit opt-in for Compose top-level secret sources; it accepts names only and injects their values ephemerally for Compose config/up.

Before provisioning, normalized Compose configuration is inspected for host and socket binds, privileged mode, host namespaces, devices, added capabilities, secrets, configs, fixed ports, and non-loopback publications. Findings redact paths, addresses, ports, names, and values. `secret_environment` sources are included in this inspection without exposing their names or values. Every allowlisted name must be present in the invoking CLI environment, and every normalized environment-backed source must be allowlisted; missing or undeclared sources fail closed. Intentional project configuration is preserved; findings let an agent and user make an informed trusted-project decision.

The two manifest environment fields have distinct boundaries. `environment` remains explicit list-form forwarding to the command service. `secret_environment` authorizes project-owned top-level Compose sources with `{ environment: VAR }`; overlapping names are rejected. The no-interpolation normalized model is checked for declared source-name references in plaintext service environment definitions without comparing raw values. Secret names alone may appear in normalized configuration; values are never serialized into YAML, argv, state, metadata, findings, errors, or public output. Compose diagnostics are replaced with fixed redacted errors before reporting.

Every managed resource requires `io.openai.codex-container-lab.managed=true`, the exact `io.openai.codex-container-lab.owner` thread id, and its exact lab label. Normal and archive cleanup both discover resources only through those exact labels. Volumes and networks must additionally pass label inspection for the same owner, exact recorded Compose project, and Docker Compose ownership labels. External resources are never labeled as lab-owned. Cleanup is bounded, idempotent, and never falls back to Compose project teardown, pruning, or name-prefix guesses.

Dockerfile shorthand receives a deterministic owner/lab image tag, recorded in the durable lab manifest, and its generated build applies the same exact managed, owner, and lab labels to the image. Cleanup resolves that tag only to inspect ownership, requires those exact labels and a structurally valid immutable `sha256` image id, and removes only that verified id. A genuinely absent internal tag is idempotent; malformed, mismatched, or otherwise uncertain inspection fails closed without image removal. Image mode and project-declared Compose images are never removed. Exact-label container removal includes anonymous volumes.

Synchronization is limited to Git-tracked and non-ignored untracked regular files and symlinks. Paths are lexical-checked and existing parent symlinks are rejected. Apply tokens bind owner, lab, direction, canonical roots, manifests, and expiry. Preview and apply take the same crash-recoverable lab activity lock as attached execution; apply also rechecks both manifests, atomically claims the token, journals backups, and rolls back interrupted target changes. Crash cleanup recovers only journals whose recorded roots match the exact durable lab identity.

Normal durable-state reads use the same fail-closed trust boundary as cleanup. The configured state root and every owner, lab, and marker parent must remain an exact non-symlink directory chain. Each JSON file is opened with no-follow semantics, and the reader compares the parent-chain and opened-file device/inode identities before and after I/O. Symlinked files, replaced parents, and files rebound during a read are rejected before reconciliation, provisioning, status, attached execution, or Docker access.

The archive reaper never writes Codex's database. It opens the configured database with SQLite read-only flags, does not change journal mode, and reads the live database together with its WAL. It performs no cleanup when the database is unavailable or busy, the schema is unexpected, a query fails, an owner row is missing, or archive columns disagree. Tests create disposable fixture databases under injected temporary directories and must never point at a live `~/.codex` database.

Owner discovery, final archive rechecks, and owner removal are serialized with lab creation through a durable owner lock. After the final archived recheck, a small exact-owner tombstone prevents a queued or later create from resurrecting that reaped identity.

To keep output and resource use bounded, previews expose at most 100 fully visible entries. A preview issues an apply token only when that complete, untruncated public result fits within the 16 KiB JSON budget; otherwise it fails closed and the change set must be reduced. Synchronization is capped at 20,000 paths, 64 MiB per file, and 512 MiB total. One owner has at most eight labs. Attached command arguments and environment payloads are bounded, and service-log responses have both line and hard byte caps. Internal persistence and runtime fields never cross the normal public JSON boundary.

Host-side Docker and Git subprocesses use a private process adapter. An
already-aborted request is rejected before spawn. On POSIX, the adapter starts
each command as a dedicated process-group leader and owns that exact group
until it has disappeared. Timeout, abort, stream failure, and leader exit with
descendants still holding output pipes all enter the same cleanup path: send
`SIGTERM`, wait for a bounded grace period, send `SIGKILL` if required, and
probe until the group is absent before reporting the command outcome. A
transient permission-denied probe is treated as potentially present, while a
permission-denied signal is a cleanup failure. The adapter never signals the
group again after observing it absent. Captured stdout and stderr are truncated
to their configured memory cap without changing an otherwise completed
command's result.

This process-group boundary contains cooperative trusted tooling; it is not a
host sandbox. A same-user command can deliberately create a new session with
`setsid`, detach from the owned group, and retain inherited resources. Windows
has no supported tree primitive in this package, so the host subprocess adapter
rejects every Windows request before spawn instead of offering a partial
direct-child path or claiming that it cleaned a process tree.
