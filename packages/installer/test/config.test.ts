// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun's built-in bun:test module.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import {
  ConfigRpcError,
  configValueAt,
  openConfigRpcSession,
  selectedUserLayer,
} from "../src/codex-config.ts";
import {
  type ConfigEdit,
  type ConfigRpc,
  configReceiptPath,
  configureCodex,
  desiredConfigEdits,
  unconfigureCodex,
} from "../src/config.ts";
import {
  promptPolicyManagedPath,
  promptPolicyReceiptPath,
} from "../src/prompt-policy.ts";

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

function fixture(initial: Value = {}): {
  codexHome: string;
  codexBinary: string;
  rpc: FakeRpc;
} {
  const codexHome = `${
    process.env["TMPDIR"] ?? "/tmp"
  }/skizzles-config-${crypto.randomUUID()}`;
  roots.push(codexHome);
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

  // biome-ignore lint/suspicious/useAwait: The async signature implements a promise-returning test double contract.
  async read() {
    return {
      layers: [
        {
          name: {
            type: "user",
            file: join(this.codexHome, "config.toml"),
            profile: null,
          },
          version: this.version,
          config: structuredClone(this.config),
        },
      ],
    };
  }

  // biome-ignore lint/suspicious/useAwait: The async signature implements a promise-returning test double contract.
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
    // biome-ignore lint/suspicious/noMisplacedAssertion: This helper is invoked only from test cases and centralizes their assertion.
    expect(params.reloadUserConfig).toBe(true);
    for (const edit of params.edits) {
      setValue(this.config, edit.keyPath, edit.value);
    }
    this.writes += 1;
    this.version = `sha256:${this.writes + 1}`;
    if (this.commitThenThrow) {
      throw new Error("ambiguous private transport data");
    }
    return { status: "ok", version: this.version, filePath: params.filePath };
  }

  // biome-ignore lint/suspicious/useAwait: The async signature implements a promise-returning test double contract.
  async close() {
    this.closed = true;
  }
}

function factory(rpc: FakeRpc) {
  return async () => rpc;
}

describe("Codex configuration lifecycle", () => {
  test("passive orchestration leaves native MultiAgentV2 defaults untouched", () => {
    expect(desiredConfigEdits("passive")).toEqual([
      { keyPath: "features.hooks", value: true, mergeStrategy: "replace" },
    ]);
  });

  test("aggressive orchestration uses concise Fourth Wall hints", () => {
    const edits = desiredConfigEdits("aggressive");
    expect(edits.map(({ keyPath }) => keyPath)).toEqual([
      "features.hooks",
      "features.multi_agent_v2.enabled",
      "features.multi_agent_v2.max_concurrent_threads_per_session",
      "features.multi_agent_v2.multi_agent_mode_hint_text",
      "features.multi_agent_v2.root_agent_usage_hint_text",
      "features.multi_agent_v2.subagent_usage_hint_text",
    ]);
    const hints = edits.slice(3).map(({ value }) => value as string);
    expect(hints.every((hint) => hint.includes("$fourth-wall"))).toBe(true);
    expect(hints.every((hint) => hint.length < 180)).toBe(true);
  });

  test("configures and restores only receipt-owned keys", async () => {
    const f = fixture({
      model: "personal-model",
      features: { hooks: false, goals: true },
      developer_instructions: "personal guidance",
    });
    await configureCodex({
      ...f,
      orchestration: "aggressive",
      rpcFactory: factory(f.rpc),
    });
    expect(f.rpc.config).toMatchObject({
      model: "personal-model",
      developer_instructions: "personal guidance",
      features: { hooks: true, goals: true, multi_agent_v2: { enabled: true } },
    });
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(true);

    f.rpc.closed = false;
    await unconfigureCodex({ ...f, rpcFactory: factory(f.rpc) });
    expect(f.rpc.config).toEqual({
      model: "personal-model",
      features: { hooks: false, goals: true, multi_agent_v2: {} },
      developer_instructions: "personal guidance",
    });
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
    expect(f.rpc.closed).toBe(true);
  });

  test("dry run reads and previews without writing a receipt", async () => {
    const f = fixture({ features: { hooks: false } });
    const receipt = await configureCodex({
      ...f,
      orchestration: "passive",
      dryRun: true,
      rpcFactory: factory(f.rpc),
    });
    expect(receipt.values).toEqual([
      {
        keyPath: "features.hooks",
        beforePresent: true,
        before: false,
        after: true,
      },
    ]);
    expect(f.rpc.writes).toBe(0);
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
  });

  test("isolated dry-run snapshots relative config inputs and remaps resolved paths", async () => {
    const f = fixture();
    const locator = `${f.codexHome}-preview-home.txt`;
    const fakeCodex = `${f.codexHome}-fake-codex`;
    roots.push(locator, fakeCodex);
    const files = {
      "base.md": "top base\n",
      "compact.md": "top compact file\n",
      // biome-ignore lint/security/noSecrets: This is a synthetic model-catalog fixture with no credential material.
      "catalog.json": '{"models":[{"slug":"fixture"}]}\n',
      "profiles/base.md": "profile base\n",
      "profiles/compact.md": "profile compact\n",
      // biome-ignore lint/security/noSecrets: This is a synthetic model-catalog fixture with no credential material.
      "profiles/catalog.json": '{"models":[{"slug":"profile"}]}\n',
      "agents/reviewer.toml":
        'model_instructions_file = "role-base.md"\ndeveloper_instructions = "Review"\n',
      "agents/role-base.md": "role base\n",
    };
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(join(f.codexHome, path, ".."), { recursive: true });
      writeFileSync(join(f.codexHome, path), contents);
    }
    writeFileSync(
      join(f.codexHome, "config.toml"),
      [
        'model_instructions_file = "base.md"',
        'developer_instructions = "inline developer"',
        'compact_prompt = "inline compact"',
        'experimental_compact_prompt_file = "compact.md"',
        'model_catalog_json = "catalog.json"',
        "[profiles.work]",
        'model_instructions_file = "profiles/base.md"',
        'experimental_compact_prompt_file = "profiles/compact.md"',
        'model_catalog_json = "profiles/catalog.json"',
        "[agents.reviewer]",
        'config_file = "agents/reviewer.toml"',
        "[desktop]",
        'config_file = "missing-opaque-file.toml"',
        "",
      ].join("\n"),
    );
    writeFileSync(
      fakeCodex,
      `#!${process.execPath}\nimport { existsSync, readFileSync, writeFileSync } from "node:fs";\nimport { createInterface } from "node:readline";\nimport { join } from "node:path";\nconst home = process.env.CODEX_HOME;\nwriteFileSync(${JSON.stringify(locator)}, home);\nfor (const path of ${JSON.stringify(Object.keys(files))}) { if (!existsSync(join(home, path))) process.exit(71); }\nconst lines = createInterface({ input: process.stdin });\nlines.on("line", (line) => {\n  const message = JSON.parse(line);\n  if (message.id === undefined) return;\n  const config = {\n    model_instructions_file: join(home, "base.md"),\n    developer_instructions: "inline developer",\n    compact_prompt: "inline compact",\n    experimental_compact_prompt_file: join(home, "compact.md"),\n    model_catalog_json: join(home, "catalog.json"),\n    profiles: { work: { model_instructions_file: join(home, "profiles/base.md"), experimental_compact_prompt_file: join(home, "profiles/compact.md") } },\n    agents: { reviewer: { config_file: join(home, "agents/reviewer.toml") } },\n  };\n  const result = message.method === "initialize" ? {} : { config: { ...config, model_instructions_file: join(home, "profiles/base.md") }, layers: [{ name: { type: "user", file: join(home, "config.toml"), profile: null }, version: "sha256:1", config }] };\n  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");\n});\nlines.on("close", () => process.exit(0));\n`,
    );
    chmodSync(fakeCodex, 0o755);
    const before = snapshotTree(f.codexHome);
    const session = await openConfigRpcSession({
      codexHome: realpathSync(f.codexHome),
      codexBinary: fakeCodex,
      dryRun: true,
    });
    const previewHome = readFileSync(locator, "utf8");
    try {
      const read = await session.rpc.read();
      const selectedHome = realpathSync(f.codexHome);
      const layer = selectedUserLayer(read, session.configPath);
      expect(configValueAt(layer.config, "model_instructions_file").value).toBe(
        join(selectedHome, "base.md"),
      );
      expect(
        configValueAt(layer.config, "profiles.work.model_instructions_file")
          .value,
      ).toBe(join(selectedHome, "profiles/base.md"));
      expect(
        configValueAt(
          layer.config,
          "profiles.work.experimental_compact_prompt_file",
        ).value,
      ).toBe(join(selectedHome, "profiles/compact.md"));
      expect(configValueAt(layer.config, "developer_instructions").value).toBe(
        "inline developer",
      );
      expect(configValueAt(layer.config, "compact_prompt").value).toBe(
        "inline compact",
      );
      expect(
        configValueAt(read.config ?? null, "model_instructions_file").value,
      ).toBe(join(selectedHome, "profiles/base.md"));
    } finally {
      await session.rpc.close();
      await session.cleanup();
    }
    expect(existsSync(previewHome)).toBe(false);
    expect(snapshotTree(f.codexHome)).toEqual(before);
  });

  test("isolated dry-run refuses escaping and symlinked relative inputs", async () => {
    for (const kind of ["escape", "symlink"] as const) {
      const f = fixture();
      const outside = `${f.codexHome}-${kind}.md`;
      roots.push(outside);
      writeFileSync(outside, "outside\n");
      if (kind === "escape") {
        writeFileSync(
          join(f.codexHome, "config.toml"),
          `model_instructions_file = "../${basename(f.codexHome)}-${kind}.md"\n`,
        );
      } else {
        symlinkSync(outside, join(f.codexHome, "linked.md"));
        writeFileSync(
          join(f.codexHome, "config.toml"),
          'model_instructions_file = "linked.md"\n',
        );
      }
      const before = snapshotTree(f.codexHome);
      const previewsBefore = previewDirectories();
      await expect(
        openConfigRpcSession({
          codexHome: realpathSync(f.codexHome),
          codexBinary: process.execPath,
          dryRun: true,
        }),
      ).rejects.toThrow(kind === "escape" ? "escapes" : "symlink");
      expect(previewDirectories()).toEqual(previewsBefore);
      expect(snapshotTree(f.codexHome)).toEqual(before);
      expect(readFileSync(outside, "utf8")).toBe("outside\n");
    }
  });

  test("fails closed when an owned key drifts", async () => {
    const f = fixture({});
    await configureCodex({
      ...f,
      orchestration: "aggressive",
      rpcFactory: factory(f.rpc),
    });
    setValue(
      f.rpc.config,
      "features.multi_agent_v2.max_concurrent_threads_per_session",
      3,
    );
    await expect(
      unconfigureCodex({ ...f, rpcFactory: factory(f.rpc) }),
    ).rejects.toThrow("refusing to restore drifted config key");
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(true);
  });

  test("removes a pending receipt when Codex rejects a concurrent edit", async () => {
    const f = fixture({});
    f.rpc.mutateBeforeWrite = true;
    await expect(
      configureCodex({
        ...f,
        orchestration: "passive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("Codex config version conflict");
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
  });

  test("discards exact-before pending evidence after a pre-write rejection", async () => {
    const f = fixture({ features: { hooks: false } });
    f.rpc.writeError = new ConfigRpcError(
      "protocol",
      "Codex app-server rejected the request (configValidationError)",
      "configValidationError",
    );
    await expect(
      configureCodex({
        ...f,
        orchestration: "passive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("configValidationError");
    expect(f.rpc.config).toEqual({ features: { hooks: false } });
    expect(f.rpc.writes).toBe(0);
    expect(
      JSON.parse(readFileSync(configReceiptPath(f.codexHome), "utf8")),
    ).toMatchObject({ state: "pending", orchestration: "passive" });

    f.rpc.writeError = undefined;
    await unconfigureCodex({ ...f, rpcFactory: factory(f.rpc) });
    expect(f.rpc.config).toEqual({ features: { hooks: false } });
    expect(f.rpc.writes).toBe(0);
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
  });

  test("retries an exact-before pending configure with its recorded edits", async () => {
    const f = fixture({ features: { hooks: false } });
    f.rpc.writeError = new ConfigRpcError(
      "protocol",
      "Codex app-server rejected the request (configValidationError)",
      "configValidationError",
    );
    await expect(
      configureCodex({
        ...f,
        orchestration: "passive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("configValidationError");

    f.rpc.writeError = undefined;
    const receipt = await configureCodex({
      ...f,
      orchestration: "passive",
      rpcFactory: factory(f.rpc),
    });
    expect(receipt.state).toBe("active");
    expect(f.rpc.config).toEqual({ features: { hooks: true } });
    expect(f.rpc.writes).toBe(1);
  });

  test("retains pending recovery evidence across a retry conflict", async () => {
    const f = fixture({ features: { hooks: false } });
    f.rpc.writeError = new ConfigRpcError(
      "protocol",
      "Codex app-server rejected the request (configValidationError)",
      "configValidationError",
    );
    await expect(
      configureCodex({
        ...f,
        orchestration: "passive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("configValidationError");
    f.rpc.writeError = undefined;
    f.rpc.mutateBeforeWrite = true;

    await expect(
      configureCodex({
        ...f,
        orchestration: "passive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("Codex config version conflict");
    expect(f.rpc.config).toEqual({ features: { hooks: false } });
    expect(
      JSON.parse(readFileSync(configReceiptPath(f.codexHome), "utf8")),
    ).toMatchObject({ state: "pending", orchestration: "passive" });
  });

  test("pending recovery requires its recorded orchestration mode", async () => {
    const f = fixture({ features: { hooks: false } });
    f.rpc.writeError = new ConfigRpcError(
      "protocol",
      "Codex app-server rejected the request (configValidationError)",
      "configValidationError",
    );
    await expect(
      configureCodex({
        ...f,
        orchestration: "passive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("configValidationError");
    f.rpc.writeError = undefined;

    await expect(
      configureCodex({
        ...f,
        orchestration: "aggressive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("recorded mode");
    expect(f.rpc.config).toEqual({ features: { hooks: false } });
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(true);
  });

  test("retains orchestration receipt when transport fails after commit", async () => {
    const f = fixture({ features: { hooks: false } });
    f.rpc.commitThenThrow = true;
    await expect(
      configureCodex({
        ...f,
        orchestration: "passive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("outcome is ambiguous");
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(true);
    expect(f.rpc.config).toEqual({ features: { hooks: true } });
    f.rpc.commitThenThrow = false;
    await unconfigureCodex({ ...f, rpcFactory: factory(f.rpc) });
    expect(f.rpc.config).toEqual({ features: { hooks: false } });
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
  });

  test("activates exact-after pending evidence without writing again", async () => {
    const f = fixture({ features: { hooks: false } });
    f.rpc.commitThenThrow = true;
    await expect(
      configureCodex({
        ...f,
        orchestration: "passive",
        rpcFactory: factory(f.rpc),
      }),
    ).rejects.toThrow("outcome is ambiguous");
    expect(f.rpc.writes).toBe(1);

    f.rpc.commitThenThrow = false;
    const receipt = await configureCodex({
      ...f,
      orchestration: "passive",
      rpcFactory: factory(f.rpc),
    });
    expect(receipt.state).toBe("active");
    expect(f.rpc.config).toEqual({ features: { hooks: true } });
    expect(f.rpc.writes).toBe(1);
  });

  test("finishes exact-before restoring evidence after an ambiguous restore", async () => {
    const f = fixture({ features: { hooks: false } });
    await configureCodex({
      ...f,
      orchestration: "passive",
      rpcFactory: factory(f.rpc),
    });
    f.rpc.commitThenThrow = true;
    await expect(
      unconfigureCodex({ ...f, rpcFactory: factory(f.rpc) }),
    ).rejects.toThrow("outcome is ambiguous");
    expect(f.rpc.config).toEqual({ features: { hooks: false } });
    expect(
      JSON.parse(readFileSync(configReceiptPath(f.codexHome), "utf8")),
    ).toMatchObject({ state: "restoring" });
    expect(f.rpc.writes).toBe(2);

    f.rpc.commitThenThrow = false;
    await unconfigureCodex({ ...f, rpcFactory: factory(f.rpc) });
    expect(f.rpc.writes).toBe(2);
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
  });

  test("orchestration configuration never activates prompt policy implicitly", async () => {
    const f = fixture({ developer_instructions: "personal guidance" });
    await configureCodex({
      ...f,
      orchestration: "aggressive",
      rpcFactory: factory(f.rpc),
    });
    expect(f.rpc.config["developer_instructions"]).toBe("personal guidance");
    expect(f.rpc.config["model_instructions_file"]).toBeUndefined();
    expect(f.rpc.config["compact_prompt"]).toBeUndefined();
    expect(existsSync(promptPolicyReceiptPath(f.codexHome))).toBe(false);
    expect(existsSync(promptPolicyManagedPath(f.codexHome))).toBe(false);
  });
});

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
