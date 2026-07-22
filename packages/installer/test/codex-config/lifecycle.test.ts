import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";
import {
  configValueAt,
  openConfigRpcSession,
  selectedUserLayer,
} from "../../src/codex-config.ts";
import {
  configReceiptPath,
  configureCodex,
  desiredConfigEdits,
  unconfigureCodex,
} from "../../src/config.ts";
import {
  promptPolicyManagedPath,
  promptPolicyReceiptPath,
} from "../../src/prompt-policy.ts";
import {
  factory,
  fixture,
  previewDirectories,
  setValue,
  snapshotTree,
  trackRoot,
} from "./support.ts";

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

  test("skizzles instruction mode installs the portable root and role assets", async () => {
    const f = fixture({
      agents: {
        default: { developer_instructions: "prior default" },
      },
    });
    const sourceRoot = realpathSync(join(import.meta.dir, "../../../.."));
    const receipt = await configureCodex({
      ...f,
      orchestration: "passive",
      instructions: "skizzles",
      sourceRoot,
      rpcFactory: factory(f.rpc),
    });
    expect(receipt.instructions).toBe("skizzles");
    expect(f.rpc.config["model_instructions_file"]).toBe(
      join(sourceRoot, "assets/skizzles_instructions.md"),
    );
    expect(f.rpc.config["agents"]).toMatchObject({
      default: {
        config_file: join(sourceRoot, "assets/agents/default.toml"),
      },
      triage: {
        config_file: join(sourceRoot, "assets/agents/triage.toml"),
      },
    });

    await unconfigureCodex({ ...f, rpcFactory: factory(f.rpc) });
    expect(f.rpc.config).toEqual({
      agents: {
        default: { developer_instructions: "prior default" },
      },
      features: {},
    });
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
    trackRoot(locator);
    trackRoot(fakeCodex);
    const files = {
      "base.md": "top base\n",
      "compact.md": "top compact file\n",

      "catalog.json": `${JSON.stringify({ models: [{ slug: "fixture" }] })}\n`,
      "profiles/base.md": "profile base\n",
      "profiles/compact.md": "profile compact\n",

      "profiles/catalog.json": `${JSON.stringify({
        models: [{ slug: "profile" }],
      })}\n`,
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
      `#!${process.execPath}\nimport { existsSync, readFileSync, writeFileSync } from "node:fs";\nimport { createInterface } from "node:readline";\nimport { join } from "node:path";\nconst home = process.env.CODEX_HOME;\nwriteFileSync(${JSON.stringify(
        locator,
      )}, home);\nfor (const path of ${JSON.stringify(
        Object.keys(files),
      )}) { if (!existsSync(join(home, path))) process.exit(71); }\nconst lines = createInterface({ input: process.stdin });\nlines.on("line", (line) => {\n  const message = JSON.parse(line);\n  if (message.id === undefined) return;\n  const config = {\n    model_instructions_file: join(home, "base.md"),\n    developer_instructions: "inline developer",\n    compact_prompt: "inline compact",\n    experimental_compact_prompt_file: join(home, "compact.md"),\n    model_catalog_json: join(home, "catalog.json"),\n    profiles: { work: { model_instructions_file: join(home, "profiles/base.md"), experimental_compact_prompt_file: join(home, "profiles/compact.md") } },\n    agents: { reviewer: { config_file: join(home, "agents/reviewer.toml") } },\n  };\n  const result = message.method === "initialize" ? {} : { config: { ...config, model_instructions_file: join(home, "profiles/base.md") }, layers: [{ name: { type: "user", file: join(home, "config.toml"), profile: null }, version: "sha256:1", config }] };\n  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");\n});\nlines.on("close", () => process.exit(0));\n`,
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
      trackRoot(outside);
      writeFileSync(outside, "outside\n");
      if (kind === "escape") {
        writeFileSync(
          join(f.codexHome, "config.toml"),
          `model_instructions_file = "../${basename(
            f.codexHome,
          )}-${kind}.md"\n`,
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
