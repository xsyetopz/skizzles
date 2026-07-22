import { dlopen, FFIType, ptr } from "bun:ffi";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import process from "node:process";
import type { UsageDirectory, UsageEntry, UsageEntryKind } from "./contract.ts";

const blockBytes = 512n;
const directoryBufferBytes = 64 * 1024;
const statBytes = 144;
const direntHeaderBytes = 21;
const nanosecondsPerSecond = 1_000_000_000n;
const atSymlinkNoFollow = 0x0020;
const closeOnExec = 0x01000000;
const seekStart = 0;
const fileTypeMask = 0o170000;
const directoryMode = 0o040000;
const regularMode = 0o100000;
const symlinkMode = 0o120000;
const unsafeEntryName = /[\\/\0]/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

const definitions = {
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  fstat: {
    args: [FFIType.i32, FFIType.ptr],
    returns: FFIType.i32,
  },
  fstatat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  __getdirentries64: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.ptr],
    returns: FFIType.i64,
  },
  lseek: {
    args: [FFIType.i32, FFIType.i64, FFIType.i32],
    returns: FFIType.i64,
  },
  openat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
} as const;

const library = (() => {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    return dlopen("/usr/lib/libSystem.B.dylib", definitions);
  } catch {
    return;
  }
})();

function safeName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !unsafeEntryName.test(name)
  );
}

function nativeNumber(value: number | bigint): number | undefined {
  const selected = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(selected)) {
    return;
  }
  return selected;
}

function timeNanoseconds(view: DataView, offset: number): string {
  const seconds = view.getBigInt64(offset, true);
  const nanoseconds = view.getBigInt64(offset + 8, true);
  return (seconds * nanosecondsPerSecond + nanoseconds).toString(10);
}

function entryKind(mode: number): UsageEntryKind {
  const fileType = mode & fileTypeMask;
  if (fileType === directoryMode) {
    return "directory";
  }
  if (fileType === regularMode) {
    return "file";
  }
  if (fileType === symlinkMode) {
    return "symlink";
  }
  return "other";
}

function parseStat(bytes: Uint8Array): UsageEntry | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const logicalBytes = view.getBigInt64(96, true);
  const blocks = view.getBigInt64(104, true);
  if (logicalBytes < 0n || blocks < 0n) {
    return;
  }
  return {
    kind: entryKind(view.getUint16(4, true)),
    device: view.getInt32(0, true).toString(10),
    inode: view.getBigUint64(8, true).toString(10),
    birthtimeNs: timeNanoseconds(view, 80),
    changeTimeNs: timeNanoseconds(view, 64),
    modifiedTimeNs: timeNanoseconds(view, 48),
    logicalBytes,
    allocatedBytes: blocks * blockBytes,
  };
}

function descriptorStat(descriptor: number): UsageEntry | undefined {
  const symbols = library?.symbols;
  if (symbols === undefined) {
    return;
  }
  const bytes = new Uint8Array(statBytes);
  if (symbols.fstat(descriptor, ptr(bytes)) !== 0) {
    return;
  }
  return parseStat(bytes);
}

function childStat(descriptor: number, name: string): UsageEntry | undefined {
  const symbols = library?.symbols;
  if (symbols === undefined || !safeName(name)) {
    return;
  }
  const bytes = new Uint8Array(statBytes);
  const encoded = Buffer.from(`${name}\0`, "utf8");
  if (
    symbols.fstatat(descriptor, ptr(encoded), ptr(bytes), atSymlinkNoFollow) !==
    0
  ) {
    return;
  }
  return parseStat(bytes);
}

function directoryNames(
  descriptor: number,
  limit: number,
):
  | { readonly names: readonly string[]; readonly truncated: boolean }
  | undefined {
  const symbols = library?.symbols;
  if (
    symbols === undefined ||
    nativeNumber(symbols.lseek(descriptor, 0n, seekStart)) !== 0
  ) {
    return;
  }
  const names: string[] = [];
  const bytes = new Uint8Array(directoryBufferBytes);
  const base = new BigInt64Array(1);
  while (names.length <= limit) {
    const count = nativeNumber(
      symbols.__getdirentries64(
        descriptor,
        ptr(bytes),
        BigInt(bytes.byteLength),
        ptr(base),
      ),
    );
    if (count === undefined || count < 0) {
      return;
    }
    if (count === 0) {
      return { names, truncated: false };
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, count);
    let offset = 0;
    while (offset < count) {
      if (offset + direntHeaderBytes > count) {
        return;
      }
      const recordBytes = view.getUint16(offset + 16, true);
      const nameBytes = view.getUint16(offset + 18, true);
      if (
        recordBytes < direntHeaderBytes ||
        offset + recordBytes > count ||
        nameBytes > recordBytes - direntHeaderBytes
      ) {
        return;
      }
      const name = decoder.decode(
        bytes.subarray(
          offset + direntHeaderBytes,
          offset + direntHeaderBytes + nameBytes,
        ),
      );
      if (name !== "." && name !== "..") {
        if (!safeName(name)) {
          return;
        }
        names.push(name);
        if (names.length > limit) {
          return { names: names.slice(0, limit), truncated: true };
        }
      }
      offset += recordBytes;
    }
  }
  return { names: names.slice(0, limit), truncated: true };
}

class DarwinUsageDirectory implements UsageDirectory {
  readonly entry: UsageEntry;
  readonly #descriptor: number;
  readonly #closeDescriptor: () => Promise<void>;
  #closed = false;

  constructor(
    descriptor: number,
    entry: UsageEntry,
    closeDescriptor: () => Promise<void>,
  ) {
    this.#descriptor = descriptor;
    this.entry = entry;
    this.#closeDescriptor = closeDescriptor;
  }

  scan(limit: number): Promise<{
    readonly names: readonly string[];
    readonly truncated: boolean;
  }> {
    if (this.#closed) {
      return Promise.reject(new Error("Usage directory is closed"));
    }
    const scanned = directoryNames(this.#descriptor, limit);
    if (scanned === undefined) {
      return Promise.reject(new Error("Descriptor enumeration failed"));
    }
    return Promise.resolve(scanned);
  }

  inspect(name: string): Promise<UsageEntry | undefined> {
    if (this.#closed) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(childStat(this.#descriptor, name));
  }

  open(name: string): Promise<UsageDirectory | undefined> {
    const symbols = library?.symbols;
    if (this.#closed || symbols === undefined || !safeName(name)) {
      return Promise.resolve(undefined);
    }
    const encoded = Buffer.from(`${name}\0`, "utf8");
    const descriptor = symbols.openat(
      this.#descriptor,
      ptr(encoded),
      constants.O_RDONLY |
        constants.O_DIRECTORY |
        constants.O_NOFOLLOW |
        closeOnExec,
    );
    if (descriptor < 0) {
      return Promise.resolve(undefined);
    }
    const entry = descriptorStat(descriptor);
    if (entry?.kind !== "directory") {
      symbols.close(descriptor);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(
      new DarwinUsageDirectory(descriptor, entry, async () => {
        if (symbols.close(descriptor) !== 0) {
          throw new Error("Descriptor close failed");
        }
      }),
    );
  }

  stat(): Promise<UsageEntry | undefined> {
    if (this.#closed) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(descriptorStat(this.#descriptor));
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#closeDescriptor();
  }
}

export function openDarwinUsageDirectory(
  handle: FileHandle,
): UsageDirectory | undefined {
  if (library === undefined) {
    return;
  }
  const entry = descriptorStat(handle.fd);
  if (entry?.kind !== "directory") {
    return;
  }
  return new DarwinUsageDirectory(handle.fd, entry, () => handle.close());
}
