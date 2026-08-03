import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configReceiptPath, configReconcilePendingPath, unconfigureCodex, type ConfigEdit, type ConfigRpc } from "../src/config";
import { harnessReceiptPath } from "../src/harness";
import { installLocalSuite } from "../src/local-suite";

type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
const roots: string[] = [];

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function setValue(root: { [key: string]: Value }, keyPath: string, value: Value): void {
  const segments = keyPath.split(".");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (!child || Array.isArray(child) || typeof child !== "object") current[segment] = {};
    current = current[segment] as { [key: string]: Value };
  }
  const final = segments.at(-1)!;
  if (value === null) delete current[final];
  else current[final] = structuredClone(value);
}

class FakeRpc implements ConfigRpc {
  config: { [key: string]: Value };
  version = "sha256:1";
  writes = 0;
  mutateBeforeWrite = false;
  failMode: "before" | "after" | undefined;

  constructor(private readonly codexHome: string, initial: Value) {
    this.config = structuredClone(initial) as { [key: string]: Value };
  }

  async read() {
    return {
      layers: [{
        name: { type: "user", file: join(this.codexHome, "config.toml"), profile: null },
        version: this.version,
        config: structuredClone(this.config),
      }],
    };
  }

  async batchWrite(params: { edits: ConfigEdit[]; filePath: string; expectedVersion: string; reloadUserConfig: boolean }) {
    if (this.mutateBeforeWrite) this.version = "sha256:external";
    if (params.expectedVersion !== this.version) throw new Error("configVersionConflict");
    if (this.failMode === "before") throw new Error("transport lost before commit");
    expect(params.reloadUserConfig).toBe(true);
    for (const edit of params.edits) setValue(this.config, edit.keyPath, edit.value);
    this.writes += 1;
    this.version = `sha256:${this.writes + 1}`;
    if (this.failMode === "after") throw new Error("transport lost after commit");
    return { status: "ok", version: this.version, filePath: params.filePath };
  }

  async close() {}
}

function fixture(initial: Value = {}): { sourceRoot: string; home: string; codexHome: string; codexBinary: string; rpc: FakeRpc } {
  const root = `${process.env.TMPDIR ?? "/tmp"}/skizzles-local-suite-${crypto.randomUUID()}`;
  roots.push(root);
  const sourceRoot = join(root, "source");
  const home = join(root, "home");
  const codexHome = join(root, "codex");
  mkdirSync(join(sourceRoot, "plugins/skizzles/.codex-plugin"), { recursive: true });
  writeFileSync(join(sourceRoot, "plugins/skizzles/.codex-plugin/plugin.json"), '{"name":"skizzles"}\n');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), "# native config\n");
  const codexBinary = join(codexHome, "fake-codex");
  writeFileSync(codexBinary, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.146.0-alpha.14'\n");
  chmodSync(codexBinary, 0o755);
  return { sourceRoot, home, codexHome, codexBinary, rpc: new FakeRpc(codexHome, initial) };
}

function writeInstructionAssets(sourceRoot: string): void {
  mkdirSync(join(sourceRoot, "assets/agents"), { recursive: true });
  writeFileSync(join(sourceRoot, "assets/skizzles_instructions.md"), "root\n");
  writeFileSync(join(sourceRoot, "assets/skizzles_subagent_instructions.md"), "subagent\n");
  const agents = [
    { agentType: "default", description: "Generated default", configFile: "default.toml" },
    { agentType: "worker", description: "Generated worker", configFile: "worker.toml" },
  ];
  for (const agent of agents) writeFileSync(join(sourceRoot, "assets/agents", agent.configFile), `${agent.agentType}\n`);
  writeFileSync(join(sourceRoot, "assets/agents/manifest.json"), JSON.stringify({ version: 1, nativeRoleAliases: {}, agents }));
}

function options(f: ReturnType<typeof fixture>, overrides: Partial<Parameters<typeof installLocalSuite>[0]> = {}) {
  return {
    sourceRoot: f.sourceRoot,
    home: f.home,
    codexHome: f.codexHome,
    codexBinary: f.codexBinary,
    transfer: "link" as const,
    orchestration: "aggressive" as const,
    instructions: "native" as const,
    rpcFactory: async () => f.rpc,
    ...overrides,
  };
}

describe("checkout-local full suite installer", () => {
  test("dry run previews a fresh suite without creating targets", async () => {
    const f = fixture({ features: { hooks: false } });
    const result = await installLocalSuite(options(f, { dryRun: true }));
    expect(result.harness.status).toBe("install");
    expect(result.config.status).toBe("install");
    expect(existsSync(f.home)).toBe(false);
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
    expect(f.rpc.writes).toBe(0);
  });

  test("fresh apply installs the harness and configuration, then is an idempotent noop", async () => {
    const f = fixture({ model: "personal", features: { hooks: false, goals: true } });
    const first = await installLocalSuite(options(f));
    expect(first.harness.status).toBe("install");
    expect(first.config.status).toBe("install");
    expect(existsSync(join(f.home, "plugins/skizzles/.codex-plugin/plugin.json"))).toBe(true);
    expect(existsSync(harnessReceiptPath(f.home))).toBe(true);
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(true);
    const writes = f.rpc.writes;
    const receiptBefore = readFileSync(configReceiptPath(f.codexHome), "utf8");

    const second = await installLocalSuite(options(f));
    expect(second.harness.status).toBe("noop");
    expect(second.config.status).toBe("noop");
    expect(f.rpc.writes).toBe(writes);
    expect(readFileSync(configReceiptPath(f.codexHome), "utf8")).toBe(receiptBefore);
  });

  test("fresh pre-batch transport failure keeps a pending receipt for safe recovery", async () => {
    const f = fixture({ features: { hooks: false } });
    f.rpc.failMode = "before";
    await expect(installLocalSuite(options(f))).rejects.toThrow("transport lost before commit");
    expect(JSON.parse(readFileSync(configReceiptPath(f.codexHome), "utf8"))).toMatchObject({ state: "pending" });
    expect(existsSync(harnessReceiptPath(f.home))).toBe(false);

    f.rpc.failMode = undefined;
    await unconfigureCodex({ codexHome: f.codexHome, codexBinary: f.codexBinary, rpcFactory: async () => f.rpc });
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
    expect(f.rpc.config).toEqual({ features: { hooks: false } });
  });

  test("fresh post-batch transport failure keeps a pending receipt and restores the commit", async () => {
    const f = fixture({ features: { hooks: false } });
    f.rpc.failMode = "after";
    await expect(installLocalSuite(options(f))).rejects.toThrow("transport lost after commit");
    expect(JSON.parse(readFileSync(configReceiptPath(f.codexHome), "utf8"))).toMatchObject({ state: "pending" });
    expect(existsSync(harnessReceiptPath(f.home))).toBe(false);

    f.rpc.failMode = undefined;
    await unconfigureCodex({ codexHome: f.codexHome, codexBinary: f.codexBinary, rpcFactory: async () => f.rpc });
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
    expect(f.rpc.config).toEqual({ features: { hooks: false, multi_agent_v2: {} } });
  });

  test("replaces receipt-owned config drift while preserving the original baseline", async () => {
    const f = fixture({ features: { hooks: false, goals: true } });
    await installLocalSuite(options(f));
    setValue(f.rpc.config, "features.multi_agent_v2.max_concurrent_threads_per_session", 2);
    const result = await installLocalSuite(options(f));
    expect(result.config.status).toBe("reconcile");
    expect(f.rpc.config.features).toMatchObject({
      hooks: true,
      goals: true,
      multi_agent_v2: { max_concurrent_threads_per_session: 6 },
    });
    const receipt = JSON.parse(readFileSync(configReceiptPath(f.codexHome), "utf8")) as {
      values: Array<{ keyPath: string; before: Value; after: Value }>;
    };
    expect(receipt.values.find(({ keyPath }) => keyPath === "features.hooks")).toMatchObject({ before: false, after: true });
    expect(receipt.values.find(({ keyPath }) => keyPath === "features.multi_agent_v2.max_concurrent_threads_per_session")).toMatchObject({ before: null, after: 6 });
  });

  test("profile downgrade restores removed owned keys and keeps unrelated siblings", async () => {
    const f = fixture({
      features: {
        hooks: false,
        goals: true,
        multi_agent_v2: { enabled: false, max_concurrent_threads_per_session: 3, user_flag: true },
      },
      model_instructions_file: "/personal/root.md",
      agents: { worker: { description: "Personal worker", nickname_candidates: ["Ada"] } },
    });
    await installLocalSuite(options(f));
    const downgraded = await installLocalSuite(options(f, { orchestration: "passive", instructions: "native" }));
    expect(downgraded.config.status).toBe("reconcile");
    expect(f.rpc.config).toEqual({
      features: {
        hooks: true,
        goals: true,
        multi_agent_v2: { enabled: false, max_concurrent_threads_per_session: 3, user_flag: true },
      },
      model_instructions_file: "/personal/root.md",
      agents: { worker: { description: "Personal worker", nickname_candidates: ["Ada"] } },
    });
    await unconfigureCodex({ ...options(f), rpcFactory: async () => f.rpc });
    expect(f.rpc.config).toEqual({
      features: {
        hooks: false,
        goals: true,
        multi_agent_v2: { enabled: false, max_concurrent_threads_per_session: 3, user_flag: true },
      },
      model_instructions_file: "/personal/root.md",
      agents: { worker: { description: "Personal worker", nickname_candidates: ["Ada"] } },
    });
  });

  test("absent agents ownership preserves later roles and nickname fields", async () => {
    const f = fixture({ features: { hooks: false } });
    writeInstructionAssets(f.sourceRoot);
    await installLocalSuite(options(f, { orchestration: "passive", instructions: "skizzles" }));
    setValue(f.rpc.config, "agents.personal.nickname_candidates", ["Ada"]);
    setValue(f.rpc.config, "agents.worker.nickname_candidates", ["Grace"]);

    await installLocalSuite(options(f, { orchestration: "passive", instructions: "native" }));
    expect(f.rpc.config.agents).toEqual({
      personal: { nickname_candidates: ["Ada"] },
      worker: { nickname_candidates: ["Grace"] },
    });
    await unconfigureCodex({ codexHome: f.codexHome, codexBinary: f.codexBinary, rpcFactory: async () => f.rpc });
    expect(f.rpc.config).toEqual({
      features: { hooks: false },
      agents: {
        personal: { nickname_candidates: ["Ada"] },
        worker: { nickname_candidates: ["Grace"] },
      },
    });
  });

  test("migrates a legacy broad agents receipt before reconciling user descendants", async () => {
    const f = fixture({ features: { hooks: false } });
    writeInstructionAssets(f.sourceRoot);
    const installOptions = options(f, { orchestration: "passive", instructions: "skizzles" });
    await installLocalSuite(installOptions);

    const receiptPath = configReceiptPath(f.codexHome);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      values: Array<{ keyPath: string; beforePresent: boolean; before: Value; after: Value }>;
      cleanupPaths?: string[];
    };
    const generated: { [role: string]: { description: Value; config_file: Value } } = {};
    for (const value of receipt.values.filter(({ keyPath }) => keyPath.startsWith("agents."))) {
      const [, role, field] = value.keyPath.split(".");
      if (!generated[role!]) generated[role!] = {} as { description: Value; config_file: Value };
      generated[role!]![field as "description" | "config_file"] = value.after as Value;
    }
    receipt.values = [
      ...receipt.values.filter(({ keyPath }) => !keyPath.startsWith("agents.")),
      { keyPath: "agents", beforePresent: false, before: null, after: generated },
    ];
    delete receipt.cleanupPaths;
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    setValue(f.rpc.config, "agents.personal.nickname_candidates", ["Ada"]);
    setValue(f.rpc.config, "agents.worker.nickname_candidates", ["Grace"]);

    const migrated = await installLocalSuite(installOptions);
    expect(migrated.config.status).toBe("reconcile");
    const migratedReceipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { values: Array<{ keyPath: string }> };
    expect(migratedReceipt.values.some(({ keyPath }) => keyPath === "agents")).toBe(false);
    expect(migratedReceipt.values.some(({ keyPath }) => keyPath === "agents.worker.description")).toBe(true);

    await installLocalSuite(options(f, { orchestration: "passive", instructions: "native" }));
    expect(f.rpc.config).toEqual({
      features: { hooks: true },
      agents: {
        personal: { nickname_candidates: ["Ada"] },
        worker: { nickname_candidates: ["Grace"] },
      },
    });
    await unconfigureCodex({ codexHome: f.codexHome, codexBinary: f.codexBinary, rpcFactory: async () => f.rpc });
    expect(f.rpc.config).toEqual({
      features: { hooks: false },
      agents: {
        personal: { nickname_candidates: ["Ada"] },
        worker: { nickname_candidates: ["Grace"] },
      },
    });
  });

  test("direct unconfigure migrates a legacy broad receipt before restoring user descendants", async () => {
    const f = fixture({ features: { hooks: false } });
    writeInstructionAssets(f.sourceRoot);
    await installLocalSuite(options(f, { orchestration: "passive", instructions: "skizzles" }));
    const receiptPath = configReceiptPath(f.codexHome);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      values: Array<{ keyPath: string; beforePresent: boolean; before: Value; after: Value }>;
    };
    const generated: { [role: string]: { description: Value; config_file: Value } } = {};
    for (const value of receipt.values.filter(({ keyPath }) => keyPath.startsWith("agents."))) {
      const [, role, field] = value.keyPath.split(".");
      if (!generated[role!]) generated[role!] = {} as { description: Value; config_file: Value };
      generated[role!]![field as "description" | "config_file"] = value.after as Value;
    }
    receipt.values = [
      ...receipt.values.filter(({ keyPath }) => !keyPath.startsWith("agents.")),
      { keyPath: "agents", beforePresent: false, before: null, after: generated },
    ];
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    setValue(f.rpc.config, "agents.personal.nickname_candidates", ["Ada"]);
    setValue(f.rpc.config, "agents.worker.nickname_candidates", ["Grace"]);

    await unconfigureCodex({ codexHome: f.codexHome, codexBinary: f.codexBinary, rpcFactory: async () => f.rpc });
    expect(f.rpc.config).toEqual({
      features: { hooks: false },
      agents: {
        personal: { nickname_candidates: ["Ada"] },
        worker: { nickname_candidates: ["Grace"] },
      },
    });
  });

  test("migrates legacy absent-role parent receipts without deleting later role fields", async () => {
    const f = fixture({
      features: { hooks: false },
      agents: { personal: { nickname_candidates: ["Ada"] } },
    });
    writeInstructionAssets(f.sourceRoot);
    const installOptions = options(f, { orchestration: "passive", instructions: "skizzles" });
    await installLocalSuite(installOptions);
    expect(JSON.parse(readFileSync(configReceiptPath(f.codexHome), "utf8")).values).toEqual(expect.arrayContaining([
      expect.objectContaining({ keyPath: "agents.worker" }),
    ]));
    setValue(f.rpc.config, "agents.worker.nickname_candidates", ["Grace"]);

    const migrated = await installLocalSuite(installOptions);
    expect(migrated.config.status).toBe("reconcile");
    const migratedReceipt = JSON.parse(readFileSync(configReceiptPath(f.codexHome), "utf8")) as { values: Array<{ keyPath: string }> };
    expect(migratedReceipt.values.some(({ keyPath }) => keyPath === "agents.worker")).toBe(false);
    expect(migratedReceipt.values.some(({ keyPath }) => keyPath === "agents.worker.config_file")).toBe(true);

    await installLocalSuite(options(f, { orchestration: "passive", instructions: "native" }));
    expect(f.rpc.config).toEqual({
      features: { hooks: true },
      agents: {
        personal: { nickname_candidates: ["Ada"] },
        worker: { nickname_candidates: ["Grace"] },
      },
    });
    await unconfigureCodex({ codexHome: f.codexHome, codexBinary: f.codexBinary, rpcFactory: async () => f.rpc });
    expect(f.rpc.config).toEqual({
      features: { hooks: false },
      agents: { personal: { nickname_candidates: ["Ada"] }, worker: { nickname_candidates: ["Grace"] } },
    });
  });

  test("profile downgrade removes an initially absent agents table when it remains fully owned", async () => {
    const f = fixture({ features: { hooks: false } });
    writeInstructionAssets(f.sourceRoot);
    await installLocalSuite(options(f, { orchestration: "passive", instructions: "skizzles" }));
    await installLocalSuite(options(f, { orchestration: "passive", instructions: "native" }));
    expect(f.rpc.config).toEqual({ features: { hooks: true } });
  });

  test("direct unconfigure prunes only empty generated role parents", async () => {
    const f = fixture({ features: { hooks: false } });
    writeInstructionAssets(f.sourceRoot);
    await installLocalSuite(options(f, { orchestration: "passive", instructions: "skizzles" }));
    setValue(f.rpc.config, "agents.personal.nickname_candidates", ["Ada"]);
    setValue(f.rpc.config, "agents.worker.nickname_candidates", ["Grace"]);
    await unconfigureCodex({ codexHome: f.codexHome, codexBinary: f.codexBinary, rpcFactory: async () => f.rpc });
    expect(f.rpc.config).toEqual({
      features: { hooks: false },
      agents: {
        personal: { nickname_candidates: ["Ada"] },
        worker: { nickname_candidates: ["Grace"] },
      },
    });
  });

  test("foreign plugin targets are hard conflicts and do not touch configuration", async () => {
    const f = fixture({ features: { hooks: false } });
    mkdirSync(join(f.home, "plugins/skizzles"), { recursive: true });
    writeFileSync(join(f.home, "plugins/skizzles/foreign.txt"), "keep me\n");
    await expect(installLocalSuite(options(f))).rejects.toThrow("harness foreign-conflict");
    expect(f.rpc.writes).toBe(0);
    expect(readFileSync(join(f.home, "plugins/skizzles/foreign.txt"), "utf8")).toBe("keep me\n");
  });

  test("receipt-managed harness drift is a hard conflict", async () => {
    const f = fixture();
    await installLocalSuite(options(f, { transfer: "copy" }));
    writeFileSync(join(f.home, "plugins/skizzles/changed.txt"), "drift\n");
    await expect(installLocalSuite(options(f, { transfer: "copy" }))).rejects.toThrow("harness drift-conflict");
  });

  test("version conflict leaves the active receipt recoverable", async () => {
    const f = fixture();
    await installLocalSuite(options(f));
    const receiptBefore = readFileSync(configReceiptPath(f.codexHome), "utf8");
    f.rpc.mutateBeforeWrite = true;
    await expect(installLocalSuite(options(f, { orchestration: "passive" }))).rejects.toThrow("configVersionConflict");
    expect(readFileSync(configReceiptPath(f.codexHome), "utf8")).toBe(receiptBefore);
  });

  test("pre-batch failure leaves a pending marker that recovery discards safely", async () => {
    const f = fixture({ features: { hooks: false } });
    await installLocalSuite(options(f));
    f.rpc.failMode = "before";
    await expect(installLocalSuite(options(f, { orchestration: "passive" }))).rejects.toThrow("transport lost before commit");
    expect(existsSync(configReconcilePendingPath(f.codexHome))).toBe(true);
    f.rpc.failMode = undefined;
    await unconfigureCodex({ codexHome: f.codexHome, codexBinary: f.codexBinary, rpcFactory: async () => f.rpc });
    expect(existsSync(configReconcilePendingPath(f.codexHome))).toBe(false);
    expect(f.rpc.config).toEqual({ features: { hooks: false, multi_agent_v2: {} } });
  });

  test("post-batch transport failure lets recovery select the committed next state", async () => {
    const f = fixture({ features: { hooks: false } });
    await installLocalSuite(options(f));
    f.rpc.failMode = "after";
    await expect(installLocalSuite(options(f, { orchestration: "passive" }))).rejects.toThrow("transport lost after commit");
    expect(existsSync(configReconcilePendingPath(f.codexHome))).toBe(true);
    f.rpc.failMode = undefined;
    await unconfigureCodex({ codexHome: f.codexHome, codexBinary: f.codexBinary, rpcFactory: async () => f.rpc });
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
    expect(existsSync(configReconcilePendingPath(f.codexHome))).toBe(false);
    expect(f.rpc.config).toEqual({ features: { hooks: false } });
  });

  test("restore retry honors a restoring receipt after the restore batch committed", async () => {
    const f = fixture({ features: { hooks: false } });
    await installLocalSuite(options(f));
    f.rpc.failMode = "after";
    await expect(installLocalSuite(options(f, { orchestration: "passive" }))).rejects.toThrow("transport lost after commit");
    await expect(unconfigureCodex({ codexHome: f.codexHome, codexBinary: f.codexBinary, rpcFactory: async () => f.rpc })).rejects.toThrow("transport lost after commit");
    expect(existsSync(configReconcilePendingPath(f.codexHome))).toBe(true);
    f.rpc.failMode = undefined;
    await unconfigureCodex({ codexHome: f.codexHome, codexBinary: f.codexBinary, rpcFactory: async () => f.rpc });
    expect(existsSync(configReceiptPath(f.codexHome))).toBe(false);
    expect(existsSync(configReconcilePendingPath(f.codexHome))).toBe(false);
    expect(f.rpc.config).toEqual({ features: { hooks: false } });
  });

  test("foreign dangling plugin symlink remains untouched", async () => {
    const f = fixture();
    mkdirSync(join(f.home, "plugins"), { recursive: true });
    symlinkSync(join(f.home, "missing"), join(f.home, "plugins/skizzles"));
    await expect(installLocalSuite(options(f))).rejects.toThrow("harness foreign-conflict");
    expect(lstatSync(join(f.home, "plugins/skizzles")).isSymbolicLink()).toBe(true);
  });
});
