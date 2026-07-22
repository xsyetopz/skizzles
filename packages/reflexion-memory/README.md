# `@skizzles/reflexion-memory`

This package owns Skizzles' local Reflexion failure-memory contract. Agent
runtimes use it to record a terminal failure for later tasks or to query prior
failures without exposing newly written critique to the active task.

## Public capabilities

The package root exports three main factories:

- `createReflexionMemoryRecorder` creates a write-only recorder backed by an
  injected persistence authority.
- `createReflexionMemoryQuery` creates a read-only query surface backed by an
  injected record source.
- `createReflexionLocalDatabase` creates the concrete local SQLite adapter and
  returns separate read-only query and write-only recorder facades.

```ts
import {
  createReflexionMemoryQuery,
  createReflexionMemoryRecorder,
} from "@skizzles/reflexion-memory";

const recorder = createReflexionMemoryRecorder(localStore);
await recorder.recordFailure(failure);

const memory = createReflexionMemoryQuery(localSource);
const snapshot = await memory.snapshot({
  currentTaskId: "task-next",
  currentRunId: "run-next",
});
```

Snapshots exclude records from their current task or run. A later task can
query validated records through a new snapshot.

## Storage and trust limits

The portable recorder and query factories perform no filesystem access. Hosts
may inject atomic `storeFailureRecordIfAbsent` persistence or opt into the
SQLite adapter. That adapter accepts only a normalized absolute `.sqlite3`
path, opens query connections in read-only mode, and uses parameterized
insert-only writes. It never chooses an ambient home path.

External skill directories are frozen structured references only; the memory
engine never opens or mutates them. Persistence receipts, records, and
snapshots reject proxies, accessors, mutable values, duplicate or replayed
records, noncanonical ordering, aliases, and digest forgeries. The package has
no runtime package dependencies.

## Verify the package

From this directory:

```sh
bun run check
bun run typecheck
bun run test
bun run build
```
