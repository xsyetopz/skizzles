import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  authorPromptPatch,
  type ProcessIdentityProvider,
} from "../src/prompt-layer.ts";

const roots: string[] = [];

export const MACHINE_PATH =
  /\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/i;
export const PATCH_NEW_IDENTITY = /\.\.[0-9a-f]{40} 100644/;
export const PROVENANCE_ERROR = /provenance/i;
export const FAILED_OLD_REPLAY =
  /old patch strict replay failed.*newly fetched inputs were not applied/i;
export const REBASE_PROBE_DIAGNOSTIC =
  /newly fetched inputs were not applied.*Recovery of a valid prior interrupted transaction and mutation-lock cleanup may have occurred/i;
export const SYMLINK_ERROR = /symlink/i;
export const LIVE_PID_ERROR = /live pid/i;
export const ACTIVE_MUTATION_ERROR = /mutation is active/i;
export const REPLACEMENT_OWNER_ERROR = /replacement prompt mutation owner/i;
export const BOUNDED_GRACE_ERROR = /bounded grace period/i;
export const QUARANTINE_ERROR = /quarantine/i;
export const MALFORMED_ERROR = /malformed/i;
export const CURRENT_PROCESS_IDENTITY_ERROR = /current process start identity/i;
export const UNVERIFIABLE_PROCESS_IDENTITY_ERROR =
  /cannot verify process-start identity/i;
export const LIVE_ORPHAN_ERROR = /has a live owner/i;

export async function cleanupFixtures(): Promise<void> {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
}

export function trackFixtureRoot(path: string): void {
  roots.push(path);
}

export interface ManifestFixture {
  upstream: {
    commit: string;
    path: string;
    baseline: FileFactFixture;
  };
  patch: FileFactFixture;
  output: FileFactFixture;
}

export interface FileFactFixture {
  path: string;
  sha256: string;
  bytes: number;
}

export interface TransactionJournalFixture {
  operation: string;
  entries: TransactionEntryFixture[];
}

export interface TransactionEntryFixture {
  path: string;
  oldSha256: string;
  oldBytes: number;
  newSha256: string;
  newBytes: number;
}

export function currentCommit(): string {
  // biome-ignore lint/security/noSecrets: This is a public upstream commit digest fixture.
  return "bc5c9161b46feddc13282652fd2cfdf1e5bab4a9";
}

export function canonicalHeader(commit: string): string {
  return `<!--\nSkizzles prompt layer provenance\nRepository: https://github.com/openai/codex\nCommit: ${commit}\nPath: codex-rs/protocol/src/prompts/base_instructions/default.md\nBaseline role: pinned generic upstream compatibility baseline; not a claim about any selected model's active baseline\n-->\n\n`;
}

export function gitBlobId(bytes: Buffer): string {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

export async function fixture(): Promise<string> {
  const source = resolve(import.meta.dir, "../../..");
  const root = await mkdtemp(join(tmpdir(), "skizzles-prompt-layer-test-"));
  roots.push(root);
  await cp(
    join(source, "packages/prompt-layer/assets"),
    join(root, "packages/prompt-layer/assets"),
    {
      recursive: true,
    },
  );
  return root;
}

export async function changedCandidate(
  root: string,
  delta: string,
): Promise<string> {
  const candidatePath = join(root, "reviewed-candidate.md");
  const current = await readFile(
    join(root, "packages/prompt-layer/assets/instructions/skizzles-base.md"),
    "utf8",
  );
  await writeFile(candidatePath, `${current}\n<!-- ${delta} -->\n`);
  return candidatePath;
}

export async function leaveCrashedAuthorTransaction(
  root: string,
): Promise<void> {
  const candidatePath = await changedCandidate(root, "crashed author");
  try {
    await authorPromptPatch(root, candidatePath, {
      transactionFault: { promotionIndex: 3, simulateCrash: true },
    });
  } catch (error) {
    if (String(error).includes("Simulated transaction crash")) {
      return;
    }
    throw error;
  }
  throw new Error("Expected a simulated transaction crash.");
}

export async function writeMutationOwner(
  root: string,
  pid: number,
  token: string,
  operation: "build" | "author" | "rebase",
  processStartIdentity = "test-process-start",
): Promise<void> {
  const lockPath = join(root, "packages/prompt-layer/assets/.mutation-lock");
  await mkdir(lockPath);
  await writeFile(
    join(lockPath, "owner.json"),
    mutationOwnerBytes(pid, token, operation, processStartIdentity),
  );
}

export function mutationOwnerBytes(
  pid: number,
  token: string,
  operation: "build" | "author" | "rebase",
  processStartIdentity: string,
): string {
  return `${JSON.stringify(
    {
      version: 1,
      operation,
      pid,
      processStartIdentity,
      token,
      createdAtUnixMs: Date.now(),
    },
    null,
    2,
  )}\n`;
}

export function identityProvider(
  identities: Array<readonly [number, string]>,
): ProcessIdentityProvider {
  return mutableIdentityProvider(new Map(identities));
}

export function mutableIdentityProvider(
  identities: Map<number, string>,
): ProcessIdentityProvider {
  return {
    processStartIdentity: async (pid) => identities.get(pid),
  };
}

export async function pathExistsForTest(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function restoreEnvironment(
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

export async function exitedPid(): Promise<number> {
  const child = Bun.spawn(["bun", "-e", "process.exit(0)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const pid = child.pid;
  await child.exited;
  return pid;
}

export function fixtureFetcher(root: string, baseline: Buffer) {
  return async (url: string) => {
    if (url.endsWith("/LICENSE")) {
      return {
        status: 200,
        body: await readFile(
          join(root, "packages/prompt-layer/assets/upstream/LICENSE"),
        ),
      };
    }
    if (url.endsWith("/NOTICE")) {
      return {
        status: 200,
        body: await readFile(
          join(root, "packages/prompt-layer/assets/upstream/NOTICE"),
        ),
      };
    }
    return { status: 200, body: baseline };
  };
}

export async function updateManifestFact(
  root: string,
  key: "patch" | "output",
  bytes: Buffer,
): Promise<void> {
  const path = join(root, "packages/prompt-layer/assets/manifest.json");
  const manifest = (await Bun.file(path).json()) as ManifestFixture;
  manifest[key].sha256 = createHash("sha256").update(bytes).digest("hex");
  manifest[key].bytes = bytes.byteLength;
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of await filesUnder(root)) {
    result[path] = createHash("sha256")
      .update(await readFile(join(root, path)))
      .digest("hex");
  }
  return result;
}

export async function filesUnder(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      paths.push(...(await filesUnder(root, path)));
    } else {
      paths.push(path);
    }
  }
  return paths.sort(compareCodeUnits);
}

export function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
