import { mkdir } from "node:fs/promises";
import { create } from "../src/api.ts";
import type { Runtime } from "../src/platform.ts";
import { systemRuntime } from "../src/platform.ts";

export interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

export function deferred(): Deferred {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

export function runtimeWith(
  base: Runtime,
  overrides: Partial<Runtime>,
): Runtime {
  return { ...base, ...overrides };
}

export async function withHarness<T>(
  operation: (runtime: Runtime, fixtureRoot: string) => Promise<T>,
): Promise<T> {
  const owner = await create();
  const fixtureRoot = owner.path("fixtures");
  await mkdir(fixtureRoot, { recursive: true });
  const runtime = runtimeWith(systemRuntime(), {
    temporaryDirectory: () => fixtureRoot,
  });
  try {
    return await operation(runtime, fixtureRoot);
  } finally {
    await owner.close();
  }
}
