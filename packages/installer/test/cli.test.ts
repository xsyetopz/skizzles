import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  }),
);

describe("installer CLI target gates", () => {
  for (const invocation of [
    ["install", "--surface", "skills"],
    ["uninstall", "--surface", "skills"],
    ["install", "--surface", "harness"],
    ["uninstall", "--surface", "harness"],
    ["configure"],
    ["unconfigure"],
    ["prompt-policy", "apply"],
    ["prompt-policy", "restore"],
    ["doctor"],
  ]) {
    test(`requires explicit roots for ${invocation.join(" ")}`, () => {
      const root = `${
        process.env["TMPDIR"] ?? "/tmp"
      }/skizzles-cli-gate-${crypto.randomUUID()}`;
      roots.push(root);
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          resolve(import.meta.dir, "../src/cli.ts"),
          ...invocation,
        ],
        env: {
          ...process.env,
          HOME: join(root, "ambient-home"),
          CODEX_HOME: join(root, "ambient-codex"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(2);
      expect(existsSync(root)).toBe(false);
    });
  }

  test("doctor reports no install with a nonzero exit", () => {
    const root = `${
      process.env["TMPDIR"] ?? "/tmp"
    }/skizzles-cli-doctor-${crypto.randomUUID()}`;
    roots.push(root);
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, "../src/cli.ts"),
        "doctor",
        "--home",
        join(root, "home"),
        "--codex-home",
        join(root, "codex"),
      ],
      env: { ...process.env, PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      ok: false,
      installs: { skills: "absent", harness: "absent" },
    });
    expect(existsSync(root)).toBe(false);
  });

  test("prompt-policy rejects unknown arguments without touching ambient homes", () => {
    const root = `${process.env["TMPDIR"] ?? "/tmp"}/skizzles-cli-unknown-${crypto.randomUUID()}`;
    roots.push(root);
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, "../src/cli.ts"),
        "prompt-policy",
        "apply",
        "--unknown",
      ],
      env: {
        ...process.env,
        HOME: join(root, "ambient-home"),
        CODEX_HOME: join(root, "ambient-codex"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(2);
    expect(existsSync(root)).toBe(false);
  });

  test("configure CLI isolates app-server writes during dry-run", () => {
    const root = `${process.env["TMPDIR"] ?? "/tmp"}/skizzles-cli-config-${crypto.randomUUID()}`;
    roots.push(root);
    const codexHome = join(root, "codex");
    const fakeCodex = join(root, "fake-codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), "# fixture\n");
    const before = snapshotTree(codexHome);
    writeFileSync(
      fakeCodex,
      `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nimport { createInterface } from "node:readline";\nimport { join } from "node:path";\nconst lines = createInterface({ input: process.stdin });\nlines.on("line", (line) => {\n  const message = JSON.parse(line);\n  if (message.id === undefined) return;\n  if (message.method === "initialize") writeFileSync(join(process.env.CODEX_HOME, "app-server-artifact"), "must stay isolated\\n");\n  const result = message.method === "initialize"\n    ? {}\n    : { layers: [{ name: { type: "user", file: join(process.env.CODEX_HOME, "config.toml"), profile: null }, version: "sha256:1", config: {} }] };\n  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");\n});\nlines.on("close", () => process.exit(0));\n`,
    );
    chmodSync(fakeCodex, 0o755);
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, "../src/cli.ts"),
        "configure",
        "--codex-home",
        codexHome,
        "--codex-binary",
        fakeCodex,
        "--orchestration",
        "passive",
        "--dry-run",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      ok: true,
      dryRun: true,
      surface: "config",
      orchestration: "passive",
      configPath: join(realpathSync(codexHome), "config.toml"),
    });
    expect(snapshotTree(codexHome)).toEqual(before);
  });

  test("unconfigure discards pending pre-write validation evidence", () => {
    const root = `${process.env["TMPDIR"] ?? "/tmp"}/skizzles-cli-config-recovery-${crypto.randomUUID()}`;
    roots.push(root);
    const codexHome = join(root, "codex");
    const fakeCodex = join(root, "fake-codex");
    mkdirSync(codexHome, { recursive: true });
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, "# unchanged fixture\n");
    const before = readFileSync(configPath);
    writeFileSync(
      fakeCodex,
      `#!${process.execPath}\nimport { createInterface } from "node:readline";\nimport { join } from "node:path";\nprocess.stderr.write("DO-NOT-LEAK-CONFIG-STDERR\\n");\nconst lines = createInterface({ input: process.stdin });\nlines.on("line", (line) => {\n  const message = JSON.parse(line);\n  if (message.id === undefined) return;\n  if (message.method === "initialize") {\n    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");\n  } else if (message.method === "config/read") {\n    process.stdout.write(JSON.stringify({ id: message.id, result: { layers: [{ name: { type: "user", file: join(process.env.CODEX_HOME, "config.toml"), profile: null }, version: "sha256:1", config: { features: { hooks: false } } }] } }) + "\\n");\n  } else {\n    process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32602, message: "DO-NOT-LEAK-CONFIG-MESSAGE", data: { config_write_error_code: "configValidationError", developer_instructions: "DO-NOT-LEAK-CONFIG-DATA" } } }) + "\\n");\n  }\n});\nlines.on("close", () => process.exit(0));\n`,
    );
    chmodSync(fakeCodex, 0o755);
    const baseCommand = [
      process.execPath,
      resolve(import.meta.dir, "../src/cli.ts"),
      "--codex-home",
      codexHome,
      "--codex-binary",
      fakeCodex,
    ];
    const configured = Bun.spawnSync({
      cmd: [
        ...baseCommand.slice(0, 2),
        "configure",
        ...baseCommand.slice(2),
        "--orchestration",
        "passive",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(configured.exitCode).toBe(1);
    const combined = `${configured.stdout.toString()}\n${configured.stderr.toString()}`;
    expect(combined).toContain("configValidationError");
    expect(combined).not.toContain("DO-NOT-LEAK-CONFIG-MESSAGE");
    expect(combined).not.toContain("DO-NOT-LEAK-CONFIG-DATA");
    expect(combined).not.toContain("DO-NOT-LEAK-CONFIG-STDERR");
    const receipt = join(codexHome, ".skizzles/config-receipt.json");
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({
      state: "pending",
      orchestration: "passive",
    });

    const unconfigured = Bun.spawnSync({
      cmd: [...baseCommand.slice(0, 2), "unconfigure", ...baseCommand.slice(2)],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(unconfigured.exitCode).toBe(0);
    expect(JSON.parse(unconfigured.stdout.toString())).toMatchObject({
      ok: true,
      surface: "config",
      orchestration: "passive",
    });
    expect(existsSync(receipt)).toBe(false);
    expect(readFileSync(configPath)).toEqual(before);
  });

  test("prompt-policy CLI emits a redacted dry-run summary", () => {
    const root = `${process.env["TMPDIR"] ?? "/tmp"}/skizzles-cli-policy-${crypto.randomUUID()}`;
    roots.push(root);
    const codexHome = join(root, "codex");
    const fakeCodex = join(root, "fake-codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), "# fixture\n");
    const before = snapshotTree(codexHome);
    writeFileSync(
      fakeCodex,
      `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nimport { createInterface } from "node:readline";\nimport { join } from "node:path";\nconst lines = createInterface({ input: process.stdin });\nlines.on("line", (line) => {\n  const message = JSON.parse(line);\n  if (message.id === undefined) return;\n  if (message.method === "initialize") writeFileSync(join(process.env.CODEX_HOME, "app-server-artifact"), "must stay isolated\\n");\n  const result = message.method === "initialize"\n    ? {}\n    : message.method === "config/read"\n      ? { layers: [{ name: { type: "user", file: join(process.env.CODEX_HOME, "config.toml"), profile: null }, version: "sha256:1", config: { developer_instructions: "DO-NOT-PRINT-CLI-SECRET" } }] }\n      : { status: "ok", version: "sha256:2", filePath: join(process.env.CODEX_HOME, "config.toml") };\n  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");\n});\nlines.on("close", () => process.exit(0));\n`,
    );
    chmodSync(fakeCodex, 0o755);
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, "../src/cli.ts"),
        "prompt-policy",
        "apply",
        "--codex-home",
        codexHome,
        "--codex-binary",
        fakeCodex,
        "--source-root",
        resolve(import.meta.dir, "../../.."),
        "--dry-run",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).not.toContain("DO-NOT-PRINT-CLI-SECRET");
    expect(stdout).not.toContain("# Skizzles Developer Policy");
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      dryRun: true,
      surface: "prompt-policy",
      action: "apply",
      keys: [
        { keyPath: "model_instructions_file", beforePresent: false },
        { keyPath: "developer_instructions", beforePresent: true },
        { keyPath: "compact_prompt", beforePresent: false },
      ],
    });
    expect(existsSync(join(codexHome, ".skizzles"))).toBe(false);
    expect(snapshotTree(codexHome)).toEqual(before);
  });

  test("prompt-policy CLI redacts app-server error data and stderr", () => {
    const root = `${process.env["TMPDIR"] ?? "/tmp"}/skizzles-cli-policy-error-${crypto.randomUUID()}`;
    roots.push(root);
    const codexHome = join(root, "codex");
    const fakeCodex = join(root, "fake-codex-error");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), "# fixture\n");
    const before = snapshotTree(codexHome);
    writeFileSync(
      fakeCodex,
      `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nimport { createInterface } from "node:readline";\nimport { join } from "node:path";\nprocess.stderr.write("DO-NOT-LEAK-APP-SERVER-STDERR\\n");\nconst lines = createInterface({ input: process.stdin });\nlines.on("line", (line) => {\n  const message = JSON.parse(line);\n  if (message.id === undefined) return;\n  if (message.method === "initialize") {\n    writeFileSync(join(process.env.CODEX_HOME, "app-server-error-artifact"), "isolated\\n");\n    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");\n  } else {\n    process.stdout.write(JSON.stringify({ id: message.id, error: { message: "DO-NOT-LEAK-PROTOCOL-MESSAGE", data: { config_write_error_code: "UNSUPPORTED-DO-NOT-LEAK-CODE", developer_instructions: "DO-NOT-LEAK-ERROR-DATA" } } }) + "\\n");\n  }\n});\nlines.on("close", () => process.exit(0));\n`,
    );
    chmodSync(fakeCodex, 0o755);
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        resolve(import.meta.dir, "../src/cli.ts"),
        "prompt-policy",
        "apply",
        "--codex-home",
        codexHome,
        "--codex-binary",
        fakeCodex,
        "--source-root",
        resolve(import.meta.dir, "../../.."),
        "--dry-run",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    const combined = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    expect(combined).toContain("Codex app-server rejected the request");
    expect(combined).not.toContain("DO-NOT-LEAK-PROTOCOL-MESSAGE");
    expect(combined).not.toContain("DO-NOT-LEAK-ERROR-DATA");
    expect(combined).not.toContain("DO-NOT-LEAK-APP-SERVER-STDERR");
    expect(snapshotTree(codexHome)).toEqual(before);
  });

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The exact wire-code matrix keeps one spawned-process assertion path for all current enum values and the legacy-shape negative case.
  test("prompt-policy CLI classifies only the current nested config write code", () => {
    for (const wireCode of [
      "configLayerReadonly",
      "configVersionConflict",
      "configValidationError",
      "configPathNotFound",
      "configSchemaUnknownKey",
      "userLayerNotFound",
      "UNSUPPORTED-AMBIGUOUS-CODE",
    ]) {
      const root = `${process.env["TMPDIR"] ?? "/tmp"}/skizzles-cli-policy-write-${crypto.randomUUID()}`;
      roots.push(root);
      const codexHome = join(root, "codex");
      const fakeCodex = join(root, "fake-codex");
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, "config.toml"), "# fixture\n");
      const legacyFields = wireCode.startsWith("UNSUPPORTED")
        ? ', code: "configVersionConflict", status: "configVersionConflict"'
        : "";
      writeFileSync(
        fakeCodex,
        `#!${process.execPath}\nimport { createInterface } from "node:readline";\nimport { join } from "node:path";\nprocess.stderr.write("DO-NOT-LEAK-WRITE-STDERR\\n");\nconst lines = createInterface({ input: process.stdin });\nlines.on("line", (line) => {\n  const message = JSON.parse(line);\n  if (message.id === undefined) return;\n  if (message.method === "initialize") {\n    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");\n  } else if (message.method === "config/read") {\n    process.stdout.write(JSON.stringify({ id: message.id, result: { layers: [{ name: { type: "user", file: join(process.env.CODEX_HOME, "config.toml"), profile: null }, version: "sha256:1", config: {} }] } }) + "\\n");\n  } else {\n    process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32602, message: "DO-NOT-LEAK-WRITE-MESSAGE", data: { config_write_error_code: ${JSON.stringify(wireCode)}, developer_instructions: "DO-NOT-LEAK-WRITE-DATA"${legacyFields} } } }) + "\\n");\n  }\n});\nlines.on("close", () => process.exit(0));\n`,
      );
      chmodSync(fakeCodex, 0o755);
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          resolve(import.meta.dir, "../src/cli.ts"),
          "prompt-policy",
          "apply",
          "--codex-home",
          codexHome,
          "--codex-binary",
          fakeCodex,
          "--source-root",
          resolve(import.meta.dir, "../../.."),
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(1);
      const combined = `${result.stdout.toString()}\n${result.stderr.toString()}`;
      expect(combined).not.toContain("DO-NOT-LEAK-WRITE-MESSAGE");
      expect(combined).not.toContain("DO-NOT-LEAK-WRITE-DATA");
      expect(combined).not.toContain("DO-NOT-LEAK-WRITE-STDERR");
      const receipt = join(codexHome, ".skizzles/prompt-policy-receipt.json");
      const managed = join(
        codexHome,
        ".skizzles/prompt-policy/skizzles-base.md",
      );
      if (wireCode === "configVersionConflict") {
        expect(combined).toContain("Codex config version conflict");
        expect(existsSync(receipt)).toBe(false);
        expect(existsSync(managed)).toBe(false);
      } else {
        expect(combined).toContain("Codex app-server rejected the request");
        if (wireCode.startsWith("config") || wireCode === "userLayerNotFound") {
          expect(combined).toContain(wireCode);
        } else {
          expect(combined).not.toContain(wireCode);
        }
        expect(existsSync(receipt)).toBe(true);
        expect(existsSync(managed)).toBe(true);
      }
    }
  });
});

function snapshotTree(root: string): [string, string][] {
  const entries: [string, string][] = [];
  function visit(directory: string, prefix = ""): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push([`${relative}/`, "directory"]);
        visit(path, relative);
      } else {
        entries.push([relative, readFileSync(path).toString("base64")]);
      }
    }
  }
  visit(root);
  return entries;
}
