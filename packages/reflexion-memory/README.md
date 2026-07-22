# `@skizzles/reflexion-memory`

`@skizzles/reflexion-memory` owns Skizzles' local Reflexion failure-memory
contract. It creates immutable, content-addressed failure records and exposes
two deliberately separate capabilities:

- a write-only recorder backed by an injected local persistence authority;
- a read-only query surface backed by an injected record source.

Snapshots never expose records produced by their current task or run. This
prevents an active execution from turning its own newly written critique into
self-reinforcing evidence. Later tasks can query validated records through a
new snapshot.

The portable factories perform no filesystem access. Hosts may inject atomic
`storeFailureRecordIfAbsent` persistence, or explicitly construct the concrete
local SQLite adapter with `createReflexionLocalDatabase()`. That adapter accepts
only a normalized absolute `.sqlite3` path, returns separate read-only query and
write-only recorder facades, opens query connections in read-only mode, and
uses parameterized insert-only writes. It never selects an ambient home path.
External skill directories are represented only by frozen, structured,
read-only references; the memory engine never opens or mutates them.

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

Persistence receipts, records, and snapshots are strict trust boundaries:
proxies, accessors, mutable values, duplicate/replayed records, non-canonical
ordering, aliases, and digest forgeries are rejected.
