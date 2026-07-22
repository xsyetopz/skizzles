export type UsageEntryKind = "directory" | "file" | "other" | "symlink";

export interface UsageEntry {
  readonly kind: UsageEntryKind;
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
  readonly changeTimeNs: string;
  readonly modifiedTimeNs: string;
  readonly logicalBytes: bigint;
  readonly allocatedBytes: bigint;
}

export interface UsageDirectory {
  readonly entry: UsageEntry;
  scan: (limit: number) => Promise<{
    readonly names: readonly string[];
    readonly truncated: boolean;
  }>;
  inspect: (name: string) => Promise<UsageEntry | undefined>;
  open: (name: string) => Promise<UsageDirectory | undefined>;
  stat: () => Promise<UsageEntry | undefined>;
  close: () => Promise<void>;
}
