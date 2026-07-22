import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function crashAt(destination: string, point: string): number {
  const module = resolve(
    import.meta.dir,
    "../../../../src/plugin/destination/transaction/apply.ts",
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
    "../../../../src/plugin/destination/transaction/apply.ts",
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

function spawnRecoveryContender(
  destination: string,
  paused: string,
  release: string,
) {
  const module = resolve(
    import.meta.dir,
    "../../../../src/plugin/destination/transaction/apply.ts",
  );
  const source = `const { replaceDirectoryTransaction } = await import(process.env.MODULE); try { await replaceDirectoryTransaction(process.env.DEST, async () => {}, { checkpoint: async (point) => { if (point === "recovery-temp-ready") { await Bun.write(process.env.PAUSED, "paused\\n"); while (!(await Bun.file(process.env.RELEASE).exists())) await Bun.sleep(5); } } }); } catch (error) { console.error(error.message); process.exit(42); }`;
  return Bun.spawn([process.execPath, "-e", source], {
    env: {
      ...process.env,
      DEST: destination,
      MODULE: module,
      PAUSED: paused,
      RELEASE: release,
    },
    stderr: "pipe",
    stdout: "ignore",
  });
}

async function writeWorkerModule(parent: string): Promise<string> {
  const module = resolve(
    import.meta.dir,
    "../../../../src/plugin/destination/transaction/apply.ts",
  );
  const path = join(parent, "claim-worker.ts");
  await writeFile(
    path,
    `import { replaceDirectoryTransaction } from ${JSON.stringify(module)}; onmessage = async (event) => { const { destination, role, gate } = event.data; try { await replaceDirectoryTransaction(destination, async (stage) => { if (role === "second") postMessage({ event: "constructed" }); await Bun.write(stage + "/" + role, role + "\\n"); if (role === "first") { postMessage({ event: "entered" }); while (!(await Bun.file(gate).exists())) await Bun.sleep(5); } }); postMessage({ event: "done" }); } catch (error) { postMessage({ event: "error", message: error.message }); } };`,
  );
  return path;
}

async function writeRecoveryWorkerModule(parent: string): Promise<string> {
  const module = resolve(
    import.meta.dir,
    "../../../../src/plugin/destination/transaction/apply.ts",
  );
  const path = join(parent, "recovery-worker.ts");
  await writeFile(
    path,
    `import { replaceDirectoryTransaction } from ${JSON.stringify(module)}; onmessage = async (event) => { try { await replaceDirectoryTransaction(event.data.destination, async () => {}, { checkpoint: async (point) => { if (point === "recovery-lease-published") { postMessage({ event: "published" }); await new Promise(() => {}); } } }); } catch (error) { postMessage({ event: "error", message: error.message }); } };`,
  );
  return path;
}

function startWorker(
  module: string,
  destination: string,
  role = "recovery",
  gate = "",
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

async function temporaryRoot(
  prefix: string,
  allocate: (purpose: string) => Promise<string>,
): Promise<string> {
  return allocate(prefix.replace(/-$/u, ""));
}

async function seededDestination(parent: string): Promise<string> {
  const destination = join(parent, "plugin");
  await mkdir(destination);
  await writeFile(join(destination, "old"), "old\n");
  return destination;
}

async function claimArtifacts(parent: string): Promise<string[]> {
  return (await readdir(parent))
    .filter((name) => name.startsWith(".skizzles-package-"))
    .sort();
}

async function allocatorArtifacts(parent: string): Promise<string[]> {
  return (await claimArtifacts(parent)).filter((name) =>
    name.includes(".recovery-highwater-"),
  );
}

async function durableAllocatorArtifacts(parent: string): Promise<string[]> {
  return (await allocatorArtifacts(parent)).filter(
    (name) => !name.endsWith(".tmp"),
  );
}

async function nonAllocatorArtifacts(parent: string): Promise<string[]> {
  return (await claimArtifacts(parent)).filter(
    (name) => !name.includes(".recovery-highwater-"),
  );
}

async function moveMarkerToTemporary(
  claimPath: string,
  token: string,
): Promise<string> {
  const marker = `${claimPath}.retired`;
  await waitForFile(marker);
  const temporary = `${marker}.${token}.tmp`;
  await rename(marker, temporary);
  return temporary;
}

async function latestHighWater(
  parent: string,
): Promise<{ path: string; pid: number; token: string }> {
  const names = (await allocatorArtifacts(parent)).filter(
    (candidate) =>
      !(candidate.endsWith(".retired") || candidate.endsWith(".tmp")),
  );
  const name = names.at(-1);
  if (name === undefined) throw new Error("recovery high-water not found");
  const generation = Number(name.slice(name.lastIndexOf("-") + 1));
  return highWaterAt(parent, generation);
}

async function highWaterAt(
  parent: string,
  generation: number,
): Promise<{ path: string; pid: number; token: string }> {
  const name = (await allocatorArtifacts(parent)).find((candidate) =>
    candidate.endsWith(`.recovery-highwater-${generation}`),
  );
  if (name === undefined) throw new Error("recovery high-water not found");
  const path = join(parent, name);
  const owner = requiredRecord(JSON.parse(await readFile(path, "utf8")));
  if (typeof owner["pid"] !== "number" || typeof owner["token"] !== "string") {
    throw new Error("invalid recovery high-water fixture");
  }
  return { path, pid: owner["pid"], token: owner["token"] };
}

async function fixtureMarker(
  path: string,
): Promise<{ dev: string; ino: string; token: string }> {
  const record = requiredRecord(JSON.parse(await readFile(path, "utf8")));
  if (
    typeof record["dev"] !== "string" ||
    typeof record["ino"] !== "string" ||
    typeof record["token"] !== "string"
  ) {
    throw new Error("invalid retirement marker fixture");
  }
  return {
    dev: record["dev"],
    ino: record["ino"],
    token: record["token"],
  };
}

async function currentClaim(
  parent: string,
): Promise<{ path: string; pid: number; token: string }> {
  const name = (await readdir(parent)).find((entry) =>
    entry.endsWith(".claim"),
  );
  if (name === undefined) throw new Error("transaction claim not found");
  const path = join(parent, name);
  const record = requiredRecord(JSON.parse(await readFile(path, "utf8")));
  if (
    typeof record["pid"] !== "number" ||
    typeof record["token"] !== "string"
  ) {
    throw new Error("invalid transaction claim fixture");
  }
  return { path, pid: record["pid"], token: record["token"] };
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid fixture record");
  }
  return Object.fromEntries(Object.entries(value));
}

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error(`helper process ${pid} was not reaped`);
}

export {
  allocatorArtifacts,
  claimArtifacts,
  collectMessages,
  crashAt,
  currentClaim,
  durableAllocatorArtifacts,
  expectProcessGone,
  fixtureMarker,
  highWaterAt,
  latestHighWater,
  moveMarkerToTemporary,
  nonAllocatorArtifacts,
  seededDestination,
  spawnRecoveryContender,
  spawnTransaction,
  startWorker,
  temporaryRoot,
  waitForFile,
  writeRecoveryWorkerModule,
  writeWorkerModule,
};
