import { afterEach } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { ConfigRpcError } from "../../src/codex-config.ts";
import type { ConfigEdit, ConfigRpc } from "../../src/config.ts";

type Value =
  | null
  | boolean
  | number
  | string
  | Value[]
  | {
      [key: string]: Value;
    };

const roots: string[] = [];

function trackRoot(root: string): void {
  roots.push(root);
}

function fixture(initial: Value = {}): {
  codexHome: string;
  codexBinary: string;
  rpc: FakeRpc;
} {
  const codexHome = `${
    process.env["TMPDIR"] ?? "/tmp"
  }/skizzles-config-${crypto.randomUUID()}`;
  trackRoot(codexHome);
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    "# preserved by native Codex config editing\n",
  );
  return {
    codexHome,
    codexBinary: process.execPath,
    rpc: new FakeRpc(codexHome, initial),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function setValue(
  root: { [key: string]: Value },
  keyPath: string,
  value: Value,
): void {
  const segments = keyPath.split(".");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (!child || Array.isArray(child) || typeof child !== "object") {
      current[segment] = {};
    }
    current = current[segment] as { [key: string]: Value };
  }
  const final = segments.at(-1);
  if (!final) {
    throw new Error("config test key path is empty");
  }
  if (value === null) {
    delete current[final];
  } else {
    current[final] = structuredClone(value);
  }
}

class FakeRpc implements ConfigRpc {
  private readonly codexHome: string;
  config: { [key: string]: Value };
  version = "sha256:1";
  writes = 0;
  closed = false;
  mutateBeforeWrite = false;
  commitThenThrow = false;
  writeError: Error | undefined;

  constructor(codexHome: string, initial: Value) {
    this.codexHome = codexHome;
    this.config = structuredClone(initial) as { [key: string]: Value };
  }

  async read() {
    return {
      layers: [
        {
          name: {
            type: "user" as const,
            file: join(this.codexHome, "config.toml"),
            profile: null,
          },
          version: this.version,
          config: structuredClone(this.config),
        },
      ],
    };
  }

  async batchWrite(params: {
    edits: ConfigEdit[];
    filePath: string;
    expectedVersion: string;
    reloadUserConfig: boolean;
  }) {
    if (this.mutateBeforeWrite) {
      this.version = "sha256:external";
    }
    if (params.expectedVersion !== this.version) {
      throw new ConfigRpcError(
        "conflict",
        "Codex config version conflict",
        "configVersionConflict",
      );
    }
    if (this.writeError) {
      throw this.writeError;
    }

    if (!params.reloadUserConfig) {
      throw new Error("test ConfigRpc requires user-config reload");
    }
    for (const edit of params.edits) {
      setValue(this.config, edit.keyPath, edit.value);
    }
    this.writes += 1;
    this.version = `sha256:${this.writes + 1}`;
    if (this.commitThenThrow) {
      throw new Error("ambiguous private transport data");
    }
    return {
      status: "ok" as const,
      version: this.version,
      filePath: params.filePath,
    };
  }

  async close() {
    this.closed = true;
  }
}

function factory(rpc: FakeRpc) {
  return async () => rpc;
}

function snapshotTree(root: string): [string, string, number][] {
  const entries: [string, string, number][] = [];
  function visit(directory: string, prefix = ""): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const mode = lstatSync(path).mode & 0o777;
      if (entry.isDirectory()) {
        entries.push([`${relative}/`, "directory", mode]);
        visit(path, relative);
      } else if (entry.isSymbolicLink()) {
        entries.push([relative, "symlink", mode]);
      } else {
        entries.push([relative, readFileSync(path).toString("base64"), mode]);
      }
    }
  }
  visit(root);
  return entries;
}

function previewDirectories(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("skizzles-config-preview-"))
    .sort();
}

export {
  factory,
  fixture,
  previewDirectories,
  setValue,
  snapshotTree,
  trackRoot,
};
