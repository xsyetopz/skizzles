import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { UsageDirectory, UsageEntry, UsageEntryKind } from "./contract.ts";
import { openDarwinUsageDirectory } from "./darwin.ts";

const blockBytes = 512n;
const unsafeEntryName = /[\\/\0]/u;

function safeName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !unsafeEntryName.test(name)
  );
}

function fromStats(stats: BigIntStats): UsageEntry | undefined {
  let kind: UsageEntryKind = "other";
  if (stats.isDirectory()) {
    kind = "directory";
  } else if (stats.isFile()) {
    kind = "file";
  } else if (stats.isSymbolicLink()) {
    kind = "symlink";
  }
  const logicalBytes = stats.size;
  const allocatedBytes = stats.blocks * blockBytes;
  if (logicalBytes < 0n || allocatedBytes < 0n) {
    return;
  }
  return {
    kind,
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    birthtimeNs: stats.birthtimeNs.toString(10),
    changeTimeNs: stats.ctimeNs.toString(10),
    modifiedTimeNs: stats.mtimeNs.toString(10),
    logicalBytes,
    allocatedBytes,
  };
}

function sameEntry(left: UsageEntry, right: UsageEntry): boolean {
  return (
    left.kind === right.kind &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs &&
    left.changeTimeNs === right.changeTimeNs &&
    left.modifiedTimeNs === right.modifiedTimeNs &&
    left.logicalBytes === right.logicalBytes &&
    left.allocatedBytes === right.allocatedBytes
  );
}

function descriptorRoot(
  platform: NodeJS.Platform,
  descriptor: number,
): string | undefined {
  if (platform === "linux") {
    return `/proc/self/fd/${descriptor}`;
  }
  return;
}

async function scanDescriptor(
  root: string,
  limit: number,
): Promise<{ readonly names: readonly string[]; readonly truncated: boolean }> {
  const directory = await opendir(root);
  const names: string[] = [];
  try {
    while (names.length <= limit) {
      const entry = await directory.read();
      if (entry === null) {
        return { names, truncated: false };
      }
      names.push(entry.name);
    }
    return { names: names.slice(0, limit), truncated: true };
  } finally {
    await directory.close().catch(() => undefined);
  }
}

class SystemUsageDirectory implements UsageDirectory {
  readonly entry: UsageEntry;
  readonly #handle: FileHandle;
  readonly #root: string;
  readonly #platform: NodeJS.Platform;
  #closed = false;

  constructor(
    handle: FileHandle,
    root: string,
    platform: NodeJS.Platform,
    entry: UsageEntry,
  ) {
    this.#handle = handle;
    this.#root = root;
    this.#platform = platform;
    this.entry = entry;
  }

  scan(limit: number): Promise<{
    readonly names: readonly string[];
    readonly truncated: boolean;
  }> {
    return scanDescriptor(this.#root, limit);
  }

  inspect(name: string): Promise<UsageEntry | undefined> {
    if (!safeName(name) || this.#closed) {
      return Promise.resolve(undefined);
    }
    return lstatSystemUsage(join(this.#root, name));
  }

  open(name: string): Promise<UsageDirectory | undefined> {
    if (!safeName(name) || this.#closed) {
      return Promise.resolve(undefined);
    }
    return openSystemUsageDirectory(join(this.#root, name), this.#platform);
  }

  async stat(): Promise<UsageEntry | undefined> {
    if (this.#closed) {
      return;
    }
    try {
      return fromStats(await this.#handle.stat({ bigint: true }));
    } catch {
      return;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#handle.close();
  }
}

export async function lstatSystemUsage(
  path: string,
): Promise<UsageEntry | undefined> {
  try {
    return fromStats(await lstat(path, { bigint: true }));
  } catch {
    return;
  }
}

export async function openSystemUsageDirectory(
  path: string,
  platform: NodeJS.Platform,
): Promise<UsageDirectory | undefined> {
  if (platform !== "linux" && platform !== "darwin") {
    return;
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const entry = fromStats(await handle.stat({ bigint: true }));
    if (entry?.kind !== "directory") {
      await handle.close();
      return;
    }
    if (platform === "darwin") {
      const directory = openDarwinUsageDirectory(handle);
      if (directory === undefined || !sameEntry(entry, directory.entry)) {
        await directory?.close().catch(() => undefined);
        if (directory === undefined) {
          await handle.close();
        }
        return;
      }
      return directory;
    }
    const root = descriptorRoot(platform, handle.fd);
    if (root === undefined) {
      await handle.close();
      return;
    }
    const probe = await opendir(root);
    await probe.close();
    const confirmed = fromStats(await handle.stat({ bigint: true }));
    if (confirmed === undefined || !sameEntry(entry, confirmed)) {
      await handle.close();
      return;
    }
    return new SystemUsageDirectory(handle, root, platform, entry);
  } catch {
    await handle?.close().catch(() => undefined);
    return;
  }
}
