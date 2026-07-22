import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import process from "node:process";
import {
  type CommandObservationReceipt,
  type CommandObservationSpec,
  observeCommand,
  recoverCommandOutput,
} from "../src/index.ts";

function specification(
  source: string,
  overrides: Partial<CommandObservationSpec> = {},
): CommandObservationSpec {
  return {
    version: 1,
    argv: [process.execPath, "--eval", source],
    cwd: import.meta.dir,
    env: {},
    timeoutMilliseconds: 2000,
    maximumOutputBytes: 4096,
    drainMilliseconds: 100,
    signalGraceMilliseconds: 100,
    ...overrides,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bunWrite(stream: "stderr" | "stdout", expression: string): string {
  return ["Bun.", stream, ".write(", expression, ")"].join("");
}

function environmentLookup(name: string): string {
  return `process.env[${JSON.stringify(name)}]`;
}

function expectInvalid(receipt: CommandObservationReceipt): void {
  const invalid =
    receipt.outcome.kind === "invalid-spec" &&
    receipt.outcome.exitCode === null &&
    receipt.outcome.signal === null &&
    receipt.outcome.failureCode === "INVALID_SPEC" &&
    receipt.outcome.outputLimitStream === null &&
    receipt.lifecycle.drain === "not-started" &&
    receipt.lifecycle.cleanup === "not-required" &&
    recoverCommandOutput(receipt, "stdout").byteLength === 0 &&
    recoverCommandOutput(receipt, "stderr").byteLength === 0;
  if (!invalid) {
    throw new Error("expected a redacted invalid-spec no-spawn receipt");
  }
}

describe("direct argv command observation", () => {
  it("treats stderr from a zero exit as evidence rather than failure", async () => {
    const receipt = await observeCommand(
      specification(bunWrite("stderr", '"warning\\n"')),
    );

    expect(receipt.outcome).toEqual({
      kind: "exited",
      exitCode: 0,
      signal: null,
      failureCode: null,
      outputLimitStream: null,
    });
    expect(
      new TextDecoder().decode(recoverCommandOutput(receipt, "stderr")),
    ).toBe("warning\n");
    expect(receipt.stderr.observedBytes).toBe(8);
    expect(receipt.lifecycle).toEqual({
      drain: "complete",
      cleanup: "not-required",
    });
  });

  it("preserves a nonzero exit with empty stderr", async () => {
    const receipt = await observeCommand(specification("process.exit(23)"));

    expect(receipt.outcome.kind).toBe("exited");
    expect(receipt.outcome.exitCode).toBe(23);
    expect(receipt.stderr.observedBytes).toBe(0);
    expect(recoverCommandOutput(receipt, "stderr")).toEqual(new Uint8Array());
  });

  it("uses the exact bounded working directory and environment", async () => {
    const environment = { OBSERVED: "explicit" };
    const expression = [
      "process.cwd()",
      '"\\n"',
      `(${environmentLookup("OBSERVED")} ?? "missing")`,
    ].join("+");
    const receipt = await observeCommand(
      specification(bunWrite("stdout", expression), { env: environment }),
    );

    expect(
      new TextDecoder().decode(recoverCommandOutput(receipt, "stdout")),
    ).toBe(`${import.meta.dir}\nexplicit`);
  });

  it("distinguishes timeouts and records process-tree cleanup", async () => {
    const receipt = await observeCommand(
      specification("await Bun.sleep(10_000)", {
        timeoutMilliseconds: 25,
      }),
    );

    expect(receipt.outcome.kind).toBe("timed-out");
    expect(receipt.outcome.exitCode).not.toBeNull();
    expect(["terminated", "killed"]).toContain(receipt.lifecycle.cleanup);
  });

  it("distinguishes an abort from timeout and exit", async () => {
    const controller = new AbortController();
    const observed = observeCommand(
      specification("await Bun.sleep(10_000)", {
        abortSignal: controller.signal,
      }),
    );
    controller.abort();
    const receipt = await observed;

    expect(receipt.outcome.kind).toBe("aborted");
    expect(receipt.outcome.exitCode).not.toBeNull();
    expect(["terminated", "killed"]).toContain(receipt.lifecycle.cleanup);
  });

  it("does not spawn when the supplied signal is already aborted", async () => {
    const signal = AbortSignal.abort();
    const receipt = await observeCommand(
      specification("process.exit(99)", {
        abortSignal: signal,
      }),
    );

    expect(receipt.outcome.kind).toBe("aborted");
    expect(receipt.outcome.exitCode).toBeNull();
    expect(receipt.lifecycle).toEqual({
      drain: "not-started",
      cleanup: "not-required",
    });
  });

  it("preserves natural signal termination", async () => {
    if (process.platform === "win32") {
      return;
    }
    const receipt = await observeCommand(
      specification('process.kill(process.pid, "SIGTERM")'),
    );

    expect(receipt.outcome.kind).toBe("signaled");
    expect(receipt.outcome.signal).toBe("SIGTERM");
    expect(receipt.outcome.exitCode).toBe(143);
  });

  it("returns a bounded spawn-failure receipt", async () => {
    const receipt = await observeCommand(
      specification("", { argv: ["/definitely/not/an/executable"] }),
    );

    expect(receipt.outcome).toEqual({
      kind: "spawn-failed",
      exitCode: null,
      signal: null,
      failureCode: "ENOENT",
      outputLimitStream: null,
    });
    expect(receipt.lifecycle.drain).toBe("not-started");
  });

  it("stops on overflow while retaining a digest-bound prefix", async () => {
    const expression = ["new Uint8Array(", "1024", ").fill(", "97", ")"].join(
      "",
    );
    const receipt = await observeCommand(
      specification(bunWrite("stdout", expression), {
        maximumOutputBytes: 16,
      }),
    );
    const bytes = recoverCommandOutput(receipt, "stdout");

    expect(receipt.outcome.kind).toBe("output-limit");
    expect(receipt.outcome.outputLimitStream).toBe("stdout");
    expect(receipt.stdout.observedBytes).toBeGreaterThan(16);
    expect(receipt.stdout.retainedBytes).toBe(16);
    expect(receipt.stdout.truncated).toBe(true);
    expect(receipt.stdout.sha256).toBe(sha256(bytes));
    expect(bytes).toEqual(new Uint8Array(16).fill(97));
  });

  it("distinguishes incomplete drain and cleans up descendants", async () => {
    if (process.platform === "win32") {
      return;
    }
    const receipt = await observeCommand(
      specification("", {
        argv: ["/bin/sh", "-c", "sleep 2 &"],
        drainMilliseconds: 10,
      }),
    );

    expect(receipt.outcome.kind).toBe("exited");
    expect(receipt.outcome.exitCode).toBe(0);
    expect(receipt.lifecycle.drain).toBe("incomplete");
    expect(["terminated", "killed"]).toContain(receipt.lifecycle.cleanup);
  });

  it("preserves arbitrary bytes and returns defensive copies", async () => {
    const receipt = await observeCommand(
      specification("Bun.stdout.write(Uint8Array.from([0, 255, 1]))"),
    );
    const first = recoverCommandOutput(receipt, "stdout");
    first[0] = 42;

    expect(recoverCommandOutput(receipt, "stdout")).toEqual(
      Uint8Array.from([0, 255, 1]),
    );
    expect(receipt.stdout.sha256).toBe(sha256(Uint8Array.from([0, 255, 1])));
  });

  it("binds a frozen receipt to the parsed invocation and terminal evidence", async () => {
    const argv = [process.execPath, "--eval", bunWrite("stdout", '"bound"')];
    const input = specification("", { argv });
    const observed = observeCommand(input);
    argv[2] = 'Bun.stdout.write("mutated")';
    const receipt = await observed;
    const other = await observeCommand(
      specification('Bun.stdout.write("different")'),
    );

    expect(
      new TextDecoder().decode(recoverCommandOutput(receipt, "stdout")),
    ).toBe("bound");
    expect(receipt.invocationSha256).not.toBe(other.invocationSha256);
    expect(receipt.receiptSha256).not.toBe(other.receiptSha256);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.outcome)).toBe(true);
    expect(Object.isFrozen(receipt.stdout)).toBe(true);
  });

  it("returns typed no-spawn receipts for malformed unknown input", async () => {
    expectInvalid(
      await observeCommand({ ...specification(""), shell: "echo hidden" }),
    );
    expectInvalid(
      await observeCommand({
        ...specification(""),
        argv: ["relative-command"],
      }),
    );
    expectInvalid(await observeCommand(null));
    const missing = { ...specification("") } as Record<string, unknown>;
    delete missing["cwd"];
    expectInvalid(await observeCommand(missing));
    expectInvalid(await observeCommand({ ...specification(""), version: 2 }));
    const accessor = specification("") as unknown as Record<string, unknown>;
    let getterReads = 0;
    Object.defineProperty(accessor, "cwd", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return import.meta.dir;
      },
    });
    expectInvalid(await observeCommand(accessor));
    expect(getterReads).toBe(0);
    expectInvalid(
      await observeCommand({ ...specification(""), env: new Date() }),
    );
    const symbolKeyed = { ...specification("") } as Record<
      PropertyKey,
      unknown
    >;
    symbolKeyed[Symbol("unknown")] = true;
    expectInvalid(await observeCommand(symbolKeyed));
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("hostile ownKeys trap");
        },
      },
    );
    expectInvalid(await observeCommand(throwingProxy));
  });

  it("snapshots hostile top-level descriptors once without property reads", async () => {
    const descriptorReads = new Map<PropertyKey, number>();
    let propertyReads = 0;
    const target = specification("await Bun.sleep(20)", {
      timeoutMilliseconds: 500,
    });
    const proxy = new Proxy(target, {
      get: () => {
        propertyReads += 1;
        throw new Error("public fields must not be read through getters");
      },
      getOwnPropertyDescriptor: (object, key) => {
        const count = (descriptorReads.get(key) ?? 0) + 1;
        descriptorReads.set(key, count);
        const descriptor = Reflect.getOwnPropertyDescriptor(object, key);
        if (key === "timeoutMilliseconds" && descriptor) {
          return { ...descriptor, value: count === 1 ? 500 : 1 };
        }
        return descriptor;
      },
    });

    const receipt = await observeCommand(proxy);

    expect(receipt.outcome.kind).toBe("exited");
    expect(propertyReads).toBe(0);
    for (const count of descriptorReads.values()) {
      expect(count).toBe(1);
    }
  });

  it("snapshots nested argv and environment data descriptors once", async () => {
    const argvReads = new Map<PropertyKey, number>();
    const environmentReads = new Map<PropertyKey, number>();
    const argv = new Proxy(
      [
        process.execPath,
        "--eval",
        bunWrite("stdout", environmentLookup("VALUE")),
      ],
      {
        get: () => {
          throw new Error("argv property access is forbidden");
        },
        getOwnPropertyDescriptor: (target, key) => {
          argvReads.set(key, (argvReads.get(key) ?? 0) + 1);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const environment = new Proxy(
      { VALUE: "nested" },
      {
        get: () => {
          throw new Error("environment property access is forbidden");
        },
        getOwnPropertyDescriptor: (target, key) => {
          environmentReads.set(key, (environmentReads.get(key) ?? 0) + 1);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    const receipt = await observeCommand(
      specification("", { argv, env: environment }),
    );

    expect(receipt.outcome.kind).toBe("exited");
    expect(
      new TextDecoder().decode(recoverCommandOutput(receipt, "stdout")),
    ).toBe("nested");
    for (const count of [...argvReads.values(), ...environmentReads.values()]) {
      expect(count).toBe(1);
    }
  });

  it("rejects nested accessors without invoking them", async () => {
    const argv = [process.execPath, "--eval", "process.exit(0)"];
    let argvGetterReads = 0;
    Object.defineProperty(argv, "2", {
      enumerable: true,
      get: () => {
        argvGetterReads += 1;
        return "process.exit(0)";
      },
    });
    const environment: Record<string, string> = {};
    let environmentGetterReads = 0;
    Object.defineProperty(environment, "VALUE", {
      enumerable: true,
      get: () => {
        environmentGetterReads += 1;
        return "hidden";
      },
    });

    expectInvalid(await observeCommand(specification("", { argv })));
    expectInvalid(
      await observeCommand(specification("", { env: environment })),
    );
    expect(argvGetterReads).toBe(0);
    expect(environmentGetterReads).toBe(0);
  });

  it("rejects a hostile authentic signal before spawning a child", async () => {
    const controller = new AbortController();
    const hostilePrototype = Object.create(AbortSignal.prototype) as object;
    Object.defineProperty(hostilePrototype, "addEventListener", {
      value: () => {
        throw new Error("hostile listener");
      },
    });
    Object.setPrototypeOf(controller.signal, hostilePrototype);
    const originalSpawn = Bun.spawn;
    let spawnCalls = 0;
    Bun.spawn = ((...arguments_: Parameters<typeof Bun.spawn>) => {
      spawnCalls += 1;
      return originalSpawn(...arguments_);
    }) as typeof Bun.spawn;
    let receipt: CommandObservationReceipt;
    try {
      receipt = await observeCommand(
        specification("await Bun.sleep(10_000)", {
          abortSignal: controller.signal,
        }),
      );
    } finally {
      Bun.spawn = originalSpawn;
    }

    expectInvalid(receipt);
    expect(spawnCalls).toBe(0);

    const ownOverride = new AbortController().signal;
    Object.defineProperty(ownOverride, "addEventListener", {
      value: () => {
        throw new Error("hostile own listener");
      },
    });
    expectInvalid(
      await observeCommand(
        specification("process.exit(0)", { abortSignal: ownOverride }),
      ),
    );
  });

  it("rejects forged receipts and invalid stream selectors", async () => {
    const receipt = await observeCommand(specification(""));
    expect(() => recoverCommandOutput({ ...receipt }, "stdout")).toThrow(
      "command observation receipt is not authentic",
    );
    expect(() => recoverCommandOutput(receipt, "combined" as "stdout")).toThrow(
      "command output stream is invalid",
    );
  });
});
