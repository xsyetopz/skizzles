import { randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunWorkspace } from "@skizzles/run-workspace";
import type { WorkflowTarget } from "./publication.ts";

interface OwnedIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly birthtime: bigint;
}

interface OwnedCandidate {
  readonly name: string;
  readonly identity: OwnedIdentity;
  readonly bytes: readonly number[];
}

export interface CommandScope {
  readonly cwd: string;
  readonly root: string;
  readonly cwdReal: string;
  readonly rootReal: string;
  readonly rootIdentity: OwnedIdentity;
  readonly cwdIdentity: OwnedIdentity;
  readonly candidates: readonly OwnedCandidate[];
}

export async function createCommandScope(
  workspace: RunWorkspace,
  sequence: number,
  targets: readonly WorkflowTarget[],
): Promise<CommandScope | undefined> {
  try {
    const root = dirname(workspace.path("owned-root-anchor"));
    const rootStat = await lstat(root, { bigint: true });
    if (!privateDirectory(rootStat)) return;
    const rootIdentity = identity(rootStat);
    const rootReal = await realpath(root);
    const allocated = await allocateCommandDirectory(workspace, sequence);
    if (allocated === undefined) return;
    const { cwd, name } = allocated;
    const cwdStat = await lstat(cwd, { bigint: true });
    const cwdReal = await realpath(cwd);
    if (
      !privateDirectory(cwdStat) ||
      cwdStat.dev !== rootStat.dev ||
      dirname(cwd) !== root ||
      cwdReal !== join(rootReal, name) ||
      dirname(cwdReal) !== rootReal
    ) {
      return;
    }
    const candidates: OwnedCandidate[] = [];
    let ordinal = 0;
    for (const target of targets) {
      if (target.candidateBytes === null) continue;
      const name = `candidate-${ordinal.toString().padStart(6, "0")}.bin`;
      ordinal += 1;
      const path = join(cwd, name);
      const handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(Uint8Array.from(target.candidateBytes));
        await handle.sync();
        const stat = await handle.stat({ bigint: true });
        if (!ownedFile(stat, target.candidateBytes.length)) return;
        candidates.push(
          Object.freeze({
            name,
            identity: identity(stat),
            bytes: target.candidateBytes,
          }),
        );
      } finally {
        await handle.close();
      }
    }
    if (!(await matchesDirectory(root, rootIdentity, rootReal))) return;
    return Object.freeze({
      cwd,
      root,
      cwdReal,
      rootReal,
      rootIdentity,
      cwdIdentity: identity(cwdStat),
      candidates: Object.freeze(candidates),
    });
  } catch {
    return undefined;
  }
}

export async function verifyCommandScope(
  scope: CommandScope,
): Promise<boolean> {
  try {
    if (
      !(
        (await matchesDirectory(
          scope.root,
          scope.rootIdentity,
          scope.rootReal,
        )) &&
        (await matchesDirectory(scope.cwd, scope.cwdIdentity, scope.cwdReal))
      ) ||
      dirname(scope.cwd) !== scope.root ||
      dirname(scope.cwdReal) !== scope.rootReal
    ) {
      return false;
    }
    for (const candidate of scope.candidates) {
      const path = join(scope.cwd, candidate.name);
      const before = await lstat(path, { bigint: true });
      if (!matchesFile(before, candidate.identity, candidate.bytes.length)) {
        return false;
      }
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const opened = await handle.stat({ bigint: true });
        if (!matchesFile(opened, candidate.identity, candidate.bytes.length)) {
          return false;
        }
        const bytes = await handle.readFile();
        const after = await handle.stat({ bigint: true });
        if (
          !(
            matchesFile(after, candidate.identity, candidate.bytes.length) &&
            sameBytes(bytes, candidate.bytes)
          )
        ) {
          return false;
        }
      } finally {
        await handle.close();
      }
      const final = await lstat(path, { bigint: true });
      if (!matchesFile(final, candidate.identity, candidate.bytes.length)) {
        return false;
      }
    }
    return matchesDirectory(scope.root, scope.rootIdentity, scope.rootReal);
  } catch {
    return false;
  }
}

function privateDirectory(stat: BigIntStats): boolean {
  return (
    stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077n) === 0n
  );
}

function ownedFile(stat: BigIntStats, bytes: number): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1n &&
    stat.size === BigInt(bytes) &&
    (stat.mode & 0o077n) === 0n
  );
}

function identity(stat: BigIntStats): OwnedIdentity {
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    birthtime: stat.birthtimeNs,
  });
}

function sameIdentity(stat: BigIntStats, expected: OwnedIdentity): boolean {
  return (
    stat.dev === expected.device &&
    stat.ino === expected.inode &&
    stat.birthtimeNs === expected.birthtime
  );
}

function matchesFile(
  stat: BigIntStats,
  expected: OwnedIdentity,
  bytes: number,
): boolean {
  return ownedFile(stat, bytes) && sameIdentity(stat, expected);
}

async function matchesDirectory(
  path: string,
  expected: OwnedIdentity,
  expectedReal: string,
): Promise<boolean> {
  const stat = await lstat(path, { bigint: true });
  return (
    privateDirectory(stat) &&
    sameIdentity(stat, expected) &&
    (await realpath(path)) === expectedReal
  );
}

async function allocateCommandDirectory(
  workspace: RunWorkspace,
  sequence: number,
): Promise<{ readonly cwd: string; readonly name: string } | undefined> {
  const maximumAttempts = 8;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const name = `command-${sequence}-${randomUUID()}`;
    const cwd = workspace.path(name);
    try {
      await mkdir(cwd, { mode: 0o700, recursive: false });
      return Object.freeze({ cwd, name });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  }
  return undefined;
}

function hasCode(error: unknown, expected: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === expected
  );
}

function sameBytes(actual: Uint8Array, expected: readonly number[]): boolean {
  return (
    actual.byteLength === expected.length &&
    actual.every((byte, index) => byte === expected[index])
  );
}
