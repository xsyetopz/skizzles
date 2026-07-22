// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { describe, expect, it } from "bun:test";
import { digestValue } from "../../../src/digest.ts";
import {
  createDependencyScheduler,
  createSchedulerWorkerAuthority,
  type SchedulerDispatchRequest,
  type SchedulerTask,
} from "../../../src/paradigms/scheduler/index.ts";

const digest = digestValue("scheduler-fixture");

describe("dependency-aware scheduler", () => {
  it("dispatches deterministic prerequisite waves with real bounded concurrency", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    const scheduler = schedulerWith(async (request) => {
      started.push(request.task.id);
      active += 1;
      peak = Math.max(peak, active);
      if (request.task.id === "a") await first.promise;
      if (request.task.id === "b") await second.promise;
      active -= 1;
      return completed(request);
    }, 2);
    const running = scheduler.run(
      schedule("parallel", [
        task("c", ["a", "b"], "repo", ["src/c.ts"]),
        task("b", [], "repo", ["src/b.ts"]),
        task("a", [], "repo", ["src/a.ts"]),
      ]),
    );
    await eventually(() => started.length === 2);
    expect(started).toEqual(["a", "b"]);
    expect(peak).toBe(2);
    first.resolve();
    await Promise.resolve();
    expect(started).toEqual(["a", "b"]);
    second.resolve();
    const result = await running;
    expect(result.status).toBe("completed");
    expect(started).toEqual(["a", "b", "c"]);
    if (result.status !== "completed") throw new Error("schedule rejected");
    expect(result.receipt.completedTaskIds).toEqual(["a", "b", "c"]);
    expect(result.receipt.entries.map(({ wave }) => wave)).toEqual([1, 1, 2]);
  });

  it("serializes overlapping repository claims while using free capacity elsewhere", async () => {
    const release = deferred<void>();
    const started: string[] = [];
    const scheduler = schedulerWith(async (request) => {
      started.push(request.task.id);
      if (request.task.id === "a" || request.task.id === "c") {
        await release.promise;
      }
      return completed(request);
    }, 3);
    const running = scheduler.run(
      schedule("claims", [
        task("a", [], "repo-a", ["src"]),
        task("b", [], "repo-a", ["src/nested/file.ts"]),
        task("c", [], "repo-b", ["src/nested/file.ts"]),
      ]),
    );
    await eventually(() => started.length === 2);
    expect(started).toEqual(["a", "c"]);
    release.resolve();
    await running;
    expect(started).toEqual(["a", "c", "b"]);
  });

  it("blocks every unsafe descendant after failure or cancellation", async () => {
    const dispatched: string[] = [];
    const scheduler = schedulerWith(async (request) => {
      dispatched.push(request.task.id);
      if (request.task.id === "failed") {
        return Object.freeze({
          status: "failed" as const,
          bindingDigest: request.bindingDigest,
          code: "FIXTURE_FAILURE",
          evidenceDigest: digestValue("failed"),
        });
      }
      if (request.task.id === "cancelled") {
        return Object.freeze({
          status: "cancelled" as const,
          bindingDigest: request.bindingDigest,
          evidenceDigest: digestValue("cancelled"),
        });
      }
      return completed(request);
    });
    const result = await scheduler.run(
      schedule("blocked", [
        task("cancelled", [], "repo", ["cancelled"]),
        task("cancelled-child", ["cancelled"], "repo", ["cancelled-child"]),
        task("failed", [], "repo", ["failed"]),
        task("failed-child", ["failed"], "repo", ["failed-child"]),
        task("grandchild", ["failed-child"], "repo", ["grandchild"]),
        task("safe", [], "repo", ["safe"]),
      ]),
    );
    if (result.status !== "completed") throw new Error("schedule rejected");
    expect(dispatched.sort((left, right) => left.localeCompare(right))).toEqual(
      ["cancelled", "failed", "safe"],
    );
    expect(result.receipt.failedTaskIds).toEqual(["failed"]);
    expect(result.receipt.cancelledTaskIds).toEqual(["cancelled"]);
    expect(result.receipt.blockedTaskIds).toEqual([
      "cancelled-child",
      "failed-child",
      "grandchild",
    ]);
  });

  it("rejects duplicate IDs, missing prerequisites, cycles, mutable graphs, and hostile proxies", async () => {
    const scheduler = schedulerWith(async (request) => completed(request));
    const invalid = [
      schedule("duplicates", [task("a"), task("a")]),
      schedule("missing", [task("a", ["absent"])]),
      schedule("cycle", [task("a", ["b"]), task("b", ["a"])]),
      schedule("traversal", [task("a", [], "repo", ["src/../secret"])]),
      schedule("empty-write", [task("a", [], "repo", [])]),
      schedule("read-with-write", [
        task("a", [], "repo", ["src/a.ts"], "read-only"),
      ]),
      { version: 1, executionId: "mutable", tasks: [] },
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("hostile graph");
          },
        },
      ),
    ];
    for (const input of invalid) {
      await expect(scheduler.run(input)).resolves.toEqual({
        status: "rejected",
        code: "INVALID_SCHEDULER_INPUT",
      });
    }
  });

  it("authenticates worker authorities and immutable receipts and rejects replay/lookalikes", async () => {
    let issuedRequest: SchedulerDispatchRequest | undefined;
    let workerCalls = 0;
    const authority = worker(async (request) => {
      issuedRequest = request;
      workerCalls += 1;
      return completed(request);
    });
    expect(
      createDependencyScheduler(
        Object.freeze({
          maximumParallelism: 2,
          worker: Object.freeze({
            authorityId: authority.authorityId,
            dispatch: authority.dispatch,
          }),
        }),
      ),
    ).toEqual({ status: "rejected", code: "INVALID_SCHEDULER_CONFIG" });
    const created = createDependencyScheduler(
      Object.freeze({ maximumParallelism: 2, worker: authority }),
    );
    if (created.status !== "created") throw new Error("scheduler rejected");
    const request = schedule("authentic", [task("a")]);
    const result = await created.scheduler.run(request);
    if (result.status !== "completed") throw new Error("schedule rejected");
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(Object.isFrozen(result.receipt.entries)).toBe(true);
    expect(created.scheduler.verify(result.receipt).status).toBe("valid");
    if (issuedRequest === undefined)
      throw new Error("dispatch was not captured");
    await expect(authority.dispatch(issuedRequest)).resolves.toMatchObject({
      status: "failed",
      code: "UNTRUSTED_DISPATCH_REQUEST",
    });
    expect(workerCalls).toBe(1);
    expect(created.scheduler.verify({ ...result.receipt })).toEqual({
      status: "rejected",
      code: "INVALID_RECEIPT",
    });
    await expect(created.scheduler.run(request)).resolves.toEqual({
      status: "rejected",
      code: "REPLAY_REJECTED",
    });
    const hostile = new Proxy(
      {},
      {
        isExtensible() {
          throw new Error("hostile config");
        },
      },
    );
    expect(() => createDependencyScheduler(hostile)).not.toThrow();
    expect(createDependencyScheduler(hostile)).toEqual({
      status: "rejected",
      code: "INVALID_SCHEDULER_CONFIG",
    });
    expect(() => createSchedulerWorkerAuthority(hostile)).not.toThrow();
    expect(createSchedulerWorkerAuthority(hostile)).toEqual({
      status: "rejected",
      code: "INVALID_WORKER_AUTHORITY",
    });
    const forged = Object.freeze({
      executionId: "forged",
      task: task("forged"),
      prerequisiteReceiptDigests: Object.freeze([]),
      bindingDigest: digest,
    });
    await expect(authority.dispatch(forged)).resolves.toMatchObject({
      status: "failed",
      code: "UNTRUSTED_DISPATCH_REQUEST",
    });
  });

  it("fail-closes thrown and malformed worker results without dispatching descendants", async () => {
    const scheduler = schedulerWith(async (request) => {
      if (request.task.id === "throw") throw new Error("worker failed");
      return Object.freeze({ status: "completed" });
    });
    const result = await scheduler.run(
      schedule("hostile-worker", [
        task("malformed"),
        task("malformed-child", ["malformed"]),
        task("throw"),
        task("throw-child", ["throw"]),
      ]),
    );
    if (result.status !== "completed") throw new Error("schedule rejected");
    expect(result.receipt.failedTaskIds).toEqual(["malformed", "throw"]);
    expect(result.receipt.blockedTaskIds).toEqual([
      "malformed-child",
      "throw-child",
    ]);
  });
});

function schedulerWith(
  dispatch: (request: SchedulerDispatchRequest) => unknown | Promise<unknown>,
  maximumParallelism = 4,
) {
  const created = createDependencyScheduler(
    Object.freeze({ maximumParallelism, worker: worker(dispatch) }),
  );
  if (created.status !== "created") throw new Error("scheduler rejected");
  return created.scheduler;
}

function worker(
  dispatch: (request: SchedulerDispatchRequest) => unknown | Promise<unknown>,
) {
  const created = createSchedulerWorkerAuthority(
    Object.freeze({ authorityId: "fixture-worker", dispatch }),
  );
  if (created.status !== "created") throw new Error("worker rejected");
  return created.authority;
}

function schedule(executionId: string, tasks: readonly SchedulerTask[]) {
  return Object.freeze({
    version: 1 as const,
    executionId,
    tasks: Object.freeze([...tasks]),
  });
}

function task(
  id: string,
  dependencies: readonly string[] = [],
  repositoryId = "repo",
  writePaths: readonly string[] = [`src/${id}.ts`],
  access: SchedulerTask["access"] = "isolated-write",
): SchedulerTask {
  return Object.freeze({
    id,
    dependencies: Object.freeze([...dependencies]),
    repositoryId,
    access,
    writePaths: Object.freeze([...writePaths]),
    objectiveDigest: digest,
  });
}

function completed(request: SchedulerDispatchRequest) {
  return Object.freeze({
    status: "completed" as const,
    bindingDigest: request.bindingDigest,
    evidenceDigest: digestValue({ task: request.task.id }),
  });
}

function deferred<Value>() {
  let resolve: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((fulfilled) => {
    resolve = fulfilled;
  });
  return Object.freeze({
    promise,
    resolve(value: Value) {
      if (resolve === undefined) throw new Error("deferred resolver missing");
      resolve(value);
    },
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("scheduler did not reach expected concurrent state");
}
