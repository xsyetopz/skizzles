// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve Bun's built-in test module.
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { replaceDirectoryTransaction } from "../src/plugin/destination-transaction.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("plugin destination atomic claims", () => {
  it("publishes ownership before creating a cross-process lock directory", async () => {
    const parent = await temporaryRoot("skizzles-claim-process-");
    const destination = await seededDestination(parent);
    const claimEntered = join(parent, "claim-entered");
    const claimRelease = join(parent, "claim-release");
    const secondEntered = join(parent, "second-entered");
    const secondRelease = join(parent, "second-release");

    const first = spawnTransaction(destination, "first", {
      CLAIM_ENTERED: claimEntered,
      CLAIM_RELEASE: claimRelease,
    });
    await waitForFile(claimEntered, first);
    const second = spawnTransaction(destination, "second", {
      ENTERED: secondEntered,
      RELEASE: secondRelease,
    });
    await waitForFile(secondEntered);
    await writeFile(claimRelease, "release\n");
    expect(await first.exited).toBe(42);
    expect((await first.stderr.text()).trim()).toContain(
      "locked by another operation",
    );
    await writeFile(secondRelease, "release\n");
    expect(await second.exited).toBe(0);
    expect(await readFile(join(destination, "second"), "utf8")).toBe(
      "second\n",
    );
    expect(await claimArtifacts(parent)).toEqual([]);
  }, 20_000);

  it("fails closed when PATH supplies a failing ps command", async () => {
    const parent = await temporaryRoot("skizzles-claim-ps-failure-");
    const destination = await seededDestination(parent);
    const entered = join(parent, "first-entered");
    const release = join(parent, "first-release");
    const first = spawnTransaction(destination, "first", {
      ENTERED: entered,
      RELEASE: release,
    });
    await waitForFile(entered, first);
    const failingPath = join(parent, "failing-path");
    await mkdir(failingPath);
    await writeFile(join(failingPath, "ps"), "#!/bin/sh\nexit 9\n");
    await chmod(join(failingPath, "ps"), 0o755);
    const blocked = spawnTransaction(destination, "second", {
      PATH: `${failingPath}${delimiter}${process.env["PATH"] ?? ""}`,
    });
    expect(await blocked.exited).toBe(42);
    expect((await blocked.stderr.text()).trim()).toContain(
      "locked by another operation",
    );
    await writeFile(release, "release\n");
    expect(await first.exited).toBe(0);
    expect(await claimArtifacts(parent)).toEqual([]);
  });

  it("blocks a live Worker owner and recovers after Worker retirement", async () => {
    const parent = await temporaryRoot("skizzles-claim-worker-");
    const destination = await seededDestination(parent);
    const gate = join(parent, "worker-release");
    const workerModule = await writeWorkerModule(parent);
    const first = startWorker(workerModule, destination, "first", gate);
    const firstMessages = collectMessages(first);
    expect((await firstMessages.next()).value).toEqual({ event: "entered" });

    const blocked = startWorker(workerModule, destination, "second", gate);
    const blockedMessages = collectMessages(blocked);
    expect((await blockedMessages.next()).value).toEqual({
      event: "error",
      message: "Plugin staging destination is locked by another operation.",
    });
    blocked.terminate();

    first.terminate();
    const recovered = startWorker(workerModule, destination, "second", gate);
    const recoveredMessages = collectMessages(recovered);
    expect((await recoveredMessages.next()).value).toEqual({
      event: "constructed",
    });
    expect((await recoveredMessages.next()).value).toEqual({ event: "done" });
    recovered.terminate();
    expect(await readFile(join(destination, "second"), "utf8")).toBe(
      "second\n",
    );
    expect(await claimArtifacts(parent)).toEqual([]);
  });

  it("recovers crashes at every recovery-lease publication point", async () => {
    for (const point of [
      "recovery-helper-ready",
      "recovery-temp-ready",
      "recovery-lease-published",
      "recovery-claim-released",
      "recovery-helper-stopped",
    ]) {
      const parent = await temporaryRoot(`skizzles-lease-${point}-`);
      const destination = await seededDestination(parent);
      expect(crashAt(destination, "owner-ready")).toBe(73);
      expect(crashAt(destination, point)).toBe(73);
      await expect(
        replaceDirectoryTransaction(destination, () =>
          Promise.reject(new Error("entered after lease recovery")),
        ),
      ).rejects.toThrow("entered after lease recovery");
      // biome-ignore lint/performance/noAwaitInLoops: every crash fixture must prove complete cleanup.
      expect(await claimArtifacts(parent)).toEqual([]);
    }
  }, 20_000);
});

function crashAt(destination: string, point: string): number {
  const module = resolve(
    import.meta.dir,
    "../src/plugin/destination-transaction.ts",
  );
  const source = `const { replaceDirectoryTransaction } = await import(process.env.MODULE); await replaceDirectoryTransaction(process.env.DEST, async (stage) => Bun.write(stage + "/new", "new\\n"), { checkpoint: (point) => { if (point === process.env.POINT) process.exit(73); } });`;
  return Bun.spawnSync([process.execPath, "-e", source], {
    env: { ...process.env, DEST: destination, MODULE: module, POINT: point },
    stderr: "pipe",
    stdout: "ignore",
  }).exitCode;
}

function spawnTransaction(
  destination: string,
  name: string,
  extraEnv: Record<string, string>,
) {
  const module = resolve(
    import.meta.dir,
    "../src/plugin/destination-transaction.ts",
  );
  const source = `const { replaceDirectoryTransaction } = await import(process.env.MODULE); try { await replaceDirectoryTransaction(process.env.DEST, async (stage) => { await Bun.write(stage + "/" + process.env.NAME, process.env.NAME + "\\n"); if (process.env.ENTERED) { await Bun.write(process.env.ENTERED, "entered\\n"); while (!(await Bun.file(process.env.RELEASE).exists())) await Bun.sleep(5); } }, { checkpoint: async (point) => { if (point === "claim-helper-ready" && process.env.CLAIM_ENTERED) { await Bun.write(process.env.CLAIM_ENTERED, "entered\\n"); while (!(await Bun.file(process.env.CLAIM_RELEASE).exists())) await Bun.sleep(5); } } }); } catch (error) { console.error(error.message); process.exit(42); }`;
  return Bun.spawn([process.execPath, "-e", source], {
    env: {
      ...process.env,
      ...extraEnv,
      DEST: destination,
      MODULE: module,
      NAME: name,
    },
    stderr: "pipe",
    stdout: "ignore",
  });
}

async function writeWorkerModule(parent: string): Promise<string> {
  const module = resolve(
    import.meta.dir,
    "../src/plugin/destination-transaction.ts",
  );
  const path = join(parent, "claim-worker.ts");
  await writeFile(
    path,
    `import { replaceDirectoryTransaction } from ${JSON.stringify(module)}; onmessage = async (event) => { const { destination, role, gate } = event.data; try { await replaceDirectoryTransaction(destination, async (stage) => { if (role === "second") postMessage({ event: "constructed" }); await Bun.write(stage + "/" + role, role + "\\n"); if (role === "first") { postMessage({ event: "entered" }); while (!(await Bun.file(gate).exists())) await Bun.sleep(5); } }); postMessage({ event: "done" }); } catch (error) { postMessage({ event: "error", message: error.message }); } };`,
  );
  return path;
}

function startWorker(
  module: string,
  destination: string,
  role: string,
  gate: string,
): Worker {
  const worker = new Worker(pathToFileURL(module).href);
  worker.postMessage({ destination, gate, role });
  return worker;
}

function collectMessages(worker: Worker) {
  const messages: unknown[] = [];
  const waiters: Array<(message: unknown) => void> = [];
  worker.addEventListener("message", (event) => {
    const waiter = waiters.shift();
    if (waiter === undefined) messages.push(event.data);
    else waiter(event.data);
  });
  return {
    next: async () => ({
      value:
        messages.length > 0
          ? messages.shift()
          : await new Promise<unknown>((resolve) => waiters.push(resolve)),
    }),
  };
}

async function waitForFile(
  path: string,
  child?: ReturnType<typeof spawnTransaction>,
): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await Bun.file(path).exists()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`Child exited early: ${await child.stderr.text()}`);
    }
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function seededDestination(parent: string): Promise<string> {
  const destination = join(parent, "plugin");
  await mkdir(destination);
  await writeFile(join(destination, "old"), "old\n");
  return destination;
}

async function claimArtifacts(parent: string): Promise<string[]> {
  return (await readdir(parent)).filter((name) =>
    name.startsWith(".skizzles-package-"),
  );
}
